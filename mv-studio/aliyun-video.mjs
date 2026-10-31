import fs from 'node:fs';
import {createBudgetLock} from './budget-lock.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMaterialStore} from './materials.mjs';

// Official legacy async video protocol (Wan 2.6 and earlier):
// https://help.aliyun.com/en/model-studio/text-to-video-api-reference
// https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/
const SCHEMA = 'osmanthus-aliyun-video-v1', UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SIZES = Object.freeze({'16:9': '1280*720', '9:16': '720*1280', '1:1': '960*960', '4:3': '1088*832', '3:4': '832*1088'});
// Wulanchabu was additionally verified in an authenticated response for an
// existing task; this is an exact hostname, not an Alibaba-wide wildcard.
// Corroboration: official output.video_url example and result-domain FAQ:
// https://help.aliyun.com/en/model-studio/legacy-image-to-video-by-first-and-last-frame-api-reference
// https://help.aliyun.com/zh/model-studio/text-to-image-api-reference
export const ALI_VIDEO_OUTPUT_HOSTS = Object.freeze(['dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 'dashscope-result-sh.oss-cn-shanghai.aliyuncs.com', 'dashscope-result-bj.oss-accelerate.aliyuncs.com', 'dashscope-result-sh.oss-accelerate.aliyuncs.com', 'dashscope-result-wlcb-acdr-1.oss-cn-wulanchabu-acdr-1.aliyuncs.com', 'dashscope-a717.oss-accelerate.aliyuncs.com']);
const STATES = ['submitting', 'queued', 'running', 'downloading', 'downloaded', 'ready', 'failed', 'uncertain', 'download_failed', 'canceled', 'unknown'];
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const error = (message, status = 400, code = 'ALI_VIDEO_INVALID_INPUT', extra = {}) => Object.assign(new Error(message), {status, code, ...extra});
const validId = id => typeof id === 'string' && UUID.test(id);
const ownKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
function estimatedCents(model, region, duration = 5) {
  if (!['wanx2.1-t2v-turbo', 'wan2.6-i2v-flash'].includes(model) || !['cn-beijing', 'ap-southeast-1'].includes(region) || !Number.isInteger(duration) || (model === 'wanx2.1-t2v-turbo' ? duration !== 5 : duration < 2 || duration > 15)) return null;
  return Math.ceil((model === 'wanx2.1-t2v-turbo' ? 0.24 : region === 'cn-beijing' ? 0.15 : 0.183481) * duration * 100 - 1e-8);
}

/** One POST per durable request, and free GET polling thereafter. No timer/retry loop. */
export function createAliVideo({data, key = '', workspace = '', model = 'wanx2.1-t2v-turbo', region = 'cn-beijing', fetchImpl = globalThis.fetch, probe, budgetCny = 20, maxOutputBytes = 80_000_000, pollIntervalMs = 15000, submitTimeoutMs = 40000, queryTimeoutMs = 20000, downloadTimeoutMs = 120000, allowedOutputHosts = ALI_VIDEO_OUTPUT_HOSTS} = {}) {
  if (typeof data !== 'string' || !data || typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key) || typeof workspace !== 'string' || (workspace && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(workspace)) || typeof fetchImpl !== 'function' || (probe !== undefined && typeof probe !== 'function')) throw new TypeError('阿里云视频配置无效');
  if (!['wanx2.1-t2v-turbo', 'wan2.6-i2v-flash'].includes(model) || !['cn-beijing', 'ap-southeast-1'].includes(region)) throw new TypeError('不支持的视频模型或地域');
  if (!Number.isFinite(budgetCny) || budgetCny <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 32 || maxOutputBytes > 500_000_000 || ![pollIntervalMs, submitTimeoutMs, queryTimeoutMs, downloadTimeoutMs].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('视频预算或限制配置无效');
  if (!Array.isArray(allowedOutputHosts) || !allowedOutputHosts.length || allowedOutputHosts.some(host => typeof host !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.aliyuncs\.com$/i.test(host))) throw new TypeError('视频结果域名白名单无效');
  const hosts = new Set(allowedOutputHosts.map(host => host.toLowerCase())), budgetCents = Math.floor(budgetCny * 100 + 1e-8);
  const estimateCents = estimatedCents(model, region);
  const regionSupported = region === 'cn-beijing' || (model === 'wan2.6-i2v-flash' && allowedOutputHosts.some(host => host.endsWith('.oss-ap-southeast-1.aliyuncs.com')));
  const base = workspace ? `https://${workspace}.${region}.maas.aliyuncs.com` : region === 'cn-beijing' ? 'https://dashscope.aliyuncs.com' : 'https://dashscope-intl.aliyuncs.com';
  const scope = hash({workspace, region}), requestedRoot = path.resolve(data, 'aliyun-video');
  fs.mkdirSync(requestedRoot, {recursive: true});
  if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw error('视频任务目录不能是符号链接', 500);
  const root = fs.realpathSync(requestedRoot), identity = fs.statSync(root), submitting = new Map(), refreshing = new Map();
  const budgetLock=createBudgetLock({root,label:'视频',codePrefix:'ALI_VIDEO'});
  const assertRoot = () => { const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw error('视频任务目录已改变', 500); };
  const fileFor = id => { if (!validId(id)) throw error('视频请求标识需为合法UUID'); return path.join(root, id + '.json'); };
  const folderFor = id => { if (!validId(id)) throw error('视频任务标识无效'); return path.join(root, id); };
  const cleanMessage = value => String(value || '视频服务未完成请求').replaceAll(key.trim() || '\x00', '[redacted]').replace(/https?:\/\/\S+/g, '[remote URL]').slice(0, 300);
  const safeCode = value => typeof value === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(value) && (!key.trim() || !value.includes(key.trim())) ? value : 'ProviderError';
  const providerId = value => typeof value === 'string' && /^[a-z0-9_-]{1,150}$/i.test(value) && (!key.trim() || !value.includes(key.trim())) ? value : null;
  function regular(file, max) {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw error('视频任务文件无效', 409);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > max) { fs.closeSync(fd); throw error('视频文件已改变', 409); }
    return {fd, stat: opened};
  }
  function readRecord(id) {
    assertRoot(); const file = fileFor(id); let fd;
    try {
      ({fd} = regular(file, 256000)); const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!object(record) || record.schema !== SCHEMA || record.id !== id || !/^[a-f0-9]{64}$/.test(record.requestHash || '') || !STATES.includes(record.status) || record.estimatedCents !== estimatedCents(record.model, record.region, record.request?.duration) || !Number.isSafeInteger(record.accountedCents) || (record.accountedCents !== record.estimatedCents && !(record.accountedCents === 0 && record.status === 'failed' && record.providerStatus === 'FAILED')) || !object(record.request) || !/^[a-f0-9]{64}$/.test(record.scope || '') || record.requestHash !== hash({model: record.model, scope: record.scope, request: record.request}) || (record.providerTaskId !== undefined && !/^[a-z0-9_-]{1,150}$/i.test(record.providerTaskId))) throw Error('invalid record');
      return record;
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw error('视频任务记录无法校验，已阻止重新付费提交', 409, 'ALI_VIDEO_RECORD_INVALID', {retryBlocked: true}); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function writeRecord(record, initial = false) {
    assertRoot(); const file = fileFor(record.id), bytes = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(bytes) > 256000) throw error('视频任务记录过大', 500);
    if (initial) { fs.writeFileSync(file, bytes, {flag: 'wx', mode: 0o600}); return record; }
    const previous = readRecord(record.id);
    if (!previous || previous.requestHash !== record.requestHash) throw error('视频任务记录冲突', 409);
    const temp = path.join(root, '.' + record.id + '.' + crypto.randomUUID() + '.tmp'); let owned = false;
    try { const fd = fs.openSync(temp, 'wx', 0o600); owned = true; try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); } fs.renameSync(temp, file); }
    finally { if (owned) { try { fs.unlinkSync(temp); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; } } }
    return record;
  }
  function allRecords() { assertRoot(); return fs.readdirSync(root).filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => readRecord(name.slice(0, -5))); }
  function budget() { const usedCents = allRecords().reduce((sum, record) => sum + record.accountedCents, 0); return {budgetCny: budgetCents / 100, usedCny: usedCents / 100, remainingCny: Math.max(0, budgetCents - usedCents) / 100}; }
  function capabilities() {
    const lockState=budgetLock.status();
    let accounting, reason = lockState.available?'':lockState.reason;
    try { accounting = budget(); } catch (cause) { reason = cause.message; }
    if (!key.trim()) reason = '阿里云视频密钥尚未配置';
    else if (!regionSupported) reason = '当前地域的模型或输出域名尚未完成本地核验，请使用北京地域';
    else if (!probe && fetchImpl === globalThis.fetch) reason = '真实视频生成需要本地ffprobe校验';
    const durations = model === 'wanx2.1-t2v-turbo' ? [5] : Array.from({length:14}, (_, index) => index + 2);
    return {available: !reason, reason, budgetLock:lockState, model, region, maxPromptChars:model==='wan2.6-i2v-flash'?1500:800, duration: 5, durations, minDuration:durations[0], maxDuration:durations.at(-1), resolution: '720P', audio: false, ratios: Object.keys(SIZES), estimatedCostCny: estimateCents / 100, estimatedCostsCny:Object.fromEntries(durations.map(duration=>[duration,estimatedCents(model,region,duration)/100])), pollIntervalMs, mediaProbe: !!probe, ...accounting};
  }
  function readImage(input) {
    if (!ownKeys(input, ['material_id']) || !validId(input.material_id)) throw error('图生视频需要有效的本地图片素材标识');
    const store = createMaterialStore({data, probe: probe || (() => null)}), asset = store.asset(input.material_id);
    if (!asset || asset.material.kind !== 'image' || !/\.(?:png|jpe?g)$/i.test(asset.file) || asset.material.width < 240 || asset.material.height < 240 || asset.material.width > 8000 || asset.material.height > 8000 || asset.material.bytes > 20_000_000) throw error('首帧需为240至8000像素、20MB内的本地PNG/JPEG图片');
    return {info: {materialId: asset.material.id, sha256: asset.material.sha256, mime: asset.mime, width: asset.material.width, height: asset.material.height}, dataUri: `data:${asset.mime};base64,${fs.readFileSync(asset.file).toString('base64')}`};
  }
  function normalize(input) {
    if (!ownKeys(input, ['request_id', 'prompt', 'duration', 'ratio', 'image']) || !validId(input.request_id) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > (model==='wan2.6-i2v-flash'?1500:800) || /\x00/.test(input.prompt) || estimatedCents(model,region,input.duration??5) === null || !Object.hasOwn(SIZES, input.ratio || '16:9')) throw error(`请提供合法请求ID、${model==='wan2.6-i2v-flash'?1500:800}字内提示词和受支持画幅；文字模型固定5秒，首帧模型支持2至15整数秒`);
    if (model === 'wanx2.1-t2v-turbo' && input.image != null) throw error('文字视频模型不接受首帧图片');
    const image = model === 'wan2.6-i2v-flash' ? readImage(input.image) : null;
    const request = {prompt: input.prompt.trim(), duration: input.duration??5, ratio: input.ratio || '16:9', ...(image ? {image: image.info} : {})};
    if (image) { const [w, h] = request.ratio.split(':').map(Number); if (Math.abs(image.info.width / image.info.height / (w / h) - 1) > .025) throw error('图生视频画幅由首帧决定，请先把图片裁剪为所选比例'); }
    return {id: input.request_id, request, requestHash: hash({model, scope, request}), image};
  }
  function folder(id) {
    assertRoot(); const dir = folderFor(id); fs.mkdirSync(dir, {recursive: true}); const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw error('视频输出目录无效', 409);
    return dir;
  }
  function fileHash(file, expectedBytes) {
    const {fd, stat} = regular(file, maxOutputBytes);
    try {
      if (expectedBytes !== undefined && stat.size !== expectedBytes) throw error('视频大小与记录不一致', 409);
      const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let length;
      while ((length = fs.readSync(fd, chunk, 0, chunk.length, null))) digest.update(chunk.subarray(0, length));
      return {bytes: stat.size, sha256: digest.digest('hex')};
    } finally { fs.closeSync(fd); }
  }
  function verifiedOutput(record) {
    if (!record.output || record.output.url !== `/files/aliyun-video/${record.id}/video.mp4`) throw error('视频输出记录无效', 409);
    const dir = folderFor(record.id), stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw error('视频输出路径无效', 409);
    const file = path.join(dir, 'video.mp4'), actual = fileHash(file, record.output.bytes);
    if (actual.sha256 !== record.output.sha256) throw error('视频输出校验失败', 409);
    return {file, mime: 'video/mp4', ...clone(record.output)};
  }
  function publicRecord(record, replayed = false) {
    let status = record.status, output = record.output ? clone(record.output) : null, failureInfo = record.error ? clone(record.error) : null;
    if (status === 'submitting' && !submitting.has(record.id)) status = 'uncertain';
    if (status === 'downloaded') status = 'downloading';
    if (status === 'unknown') status = 'uncertain';
    if (status === 'canceled') status = 'failed';
    if (status === 'ready') { try { verifiedOutput(record); } catch { status = 'download_failed'; output = null; failureInfo = {code: 'LOCAL_OUTPUT_INVALID', message: '本地视频缺失或校验失败，刷新仅查询原任务，不会重新生成'}; } }
    return {id: record.id, request_id: record.id, status, providerStatus: record.providerStatus || null, providerTaskId: record.providerTaskId || null, model: record.model, region: record.region, prompt: record.request.prompt, duration: record.request.duration??5, ratio: record.request.ratio, estimatedCostCny: record.estimatedCents / 100, accountedCostCny: record.accountedCents / 100, createdAt: record.createdAt, updatedAt: record.updatedAt, nextPollAt: record.nextPollAt || null, retryBlocked: ['uncertain', 'unknown', 'submitting'].includes(status), error: failureInfo, output, url: output?.url || null, sha256: output?.sha256 || null, bytes: output?.bytes || null, width: output?.width || null, height: output?.height || null, replayed};
  }
  function requireRecord(id) { const record = readRecord(id); if (!record) throw error('视频任务不存在', 404); if (record.scope !== scope) throw error('视频任务属于其他地域或工作空间，未请求远端', 409); return record; }
  async function jsonResponse(response) {
    if (Number(response.headers?.get?.('content-length')) > 64000) throw Error('响应过大');
    let bytes;
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 64000) throw Error('响应过大'); chunks.push(Buffer.from(chunk)); }
      bytes = Buffer.concat(chunks).toString('utf8');
    } else { bytes = await response.text(); if (Buffer.byteLength(bytes) > 64000) throw Error('响应过大'); }
    return JSON.parse(bytes);
  }
  function mark(record, status, patch = {}) { return writeRecord({...record, ...patch, status, updatedAt: new Date().toISOString()}); }
  function reserve(normalized) {
    assertRoot();
    return budgetLock.run(() => {
      const records = allRecords(), duplicate = records.find(record => record.requestHash === normalized.requestHash && ['submitting', 'queued', 'running', 'downloading', 'downloaded', 'uncertain', 'unknown'].includes(record.status));
      if (duplicate) throw error('相同内容已有任务或执行结果未确认，已阻止重复付费', 409, 'ALI_VIDEO_DUPLICATE_ACTIVE', {retryBlocked: true, existingId: duplicate.id});
      const requestCents = estimatedCents(model, region, normalized.request.duration);
      if (records.reduce((sum, record) => sum + record.accountedCents, 0) + requestCents > budgetCents) throw error('视频生成预算不足，未提交付费请求', 402, 'ALI_VIDEO_BUDGET_EXCEEDED', {estimatedCostCny: requestCents / 100, ...budget()});
      const now = new Date().toISOString();
      return writeRecord({schema: SCHEMA, id: normalized.id, requestHash: normalized.requestHash, scope, model, region, request: normalized.request, estimatedCents: requestCents, accountedCents: requestCents, status: 'submitting', createdAt: now, updatedAt: now}, true);
    });
  }
  async function doSubmit(normalized) {
    let record = reserve(normalized), response, body;
    const parameters = model === 'wanx2.1-t2v-turbo' ? {size: SIZES[record.request.ratio], prompt_extend: false, watermark: true} : {resolution: '720P', duration: record.request.duration??5, audio: false, prompt_extend: false, watermark: true};
    const input = {prompt: record.request.prompt, ...(normalized.image ? {img_url: normalized.image.dataUri} : {})};
    try {
      response = await fetchImpl(base + '/api/v1/services/aigc/video-generation/video-synthesis', {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key.trim(), 'X-DashScope-Async': 'enable'}, body: JSON.stringify({model, input, parameters}), signal: AbortSignal.timeout(submitTimeoutMs)});
      body = await jsonResponse(response);
    } catch {
      try { record = mark(record, 'uncertain', {error: {code: 'SUBMISSION_UNCERTAIN', message: '提交连接或响应中断，执行结果未确认；已计入预算并阻止盲目重试'}}); } catch {}
      throw error('视频提交结果未确认，已阻止再次付费提交；请保留任务ID', 409, 'ALI_VIDEO_SUBMISSION_UNCERTAIN', {retryBlocked: true, id: record.id});
    }
    const output = body?.output, taskId = output?.task_id;
    const definitiveFailure = output?.task_status === 'FAILED' || (!response.ok && [400, 401, 403, 404, 422, 429].includes(response.status));
    if (definitiveFailure) return publicRecord(mark(record, 'failed', {accountedCents: 0, providerStatus: 'FAILED', providerRequestId: providerId(body.request_id), error: {code: safeCode(output?.code || body.code), message: cleanMessage(output?.message || body.message)}}));
    if (!response.ok || !providerId(taskId)) {
      try { mark(record, 'uncertain', {error: {code: 'SUBMISSION_UNCERTAIN', message: '服务未返回可查询任务标识，已计入预算并阻止重复提交'}}); } catch {}
      throw error('视频服务的任务标识无法确认，未自动重试', 409, 'ALI_VIDEO_SUBMISSION_UNCERTAIN', {retryBlocked: true, id: record.id});
    }
    try { record = mark(record, output?.task_status === 'RUNNING' ? 'running' : 'queued', {providerTaskId: taskId, providerStatus: ['PENDING','RUNNING','SUCCEEDED'].includes(output?.task_status) ? output.task_status : 'PENDING', providerRequestId: providerId(body.request_id), nextPollAt: new Date(Date.now() + pollIntervalMs).toISOString(), error: null}); }
    catch { throw error('视频可能已提交，但本地任务标识未能保存；已阻止重复付费', 409, 'ALI_VIDEO_SUBMISSION_UNCERTAIN', {retryBlocked: true, id: record.id}); }
    return publicRecord(record);
  }
  async function submit(input) {
    const cap = capabilities(); if (!cap.available) throw error(cap.reason, 503, 'ALI_VIDEO_UNAVAILABLE');
    const normalized = normalize(input), active = submitting.get(normalized.id);
    if (active) { if (active.hash !== normalized.requestHash) throw error('同一视频请求ID收到不同内容', 409, 'ALI_VIDEO_REQUEST_CONFLICT'); return {...await active.promise, replayed: true}; }
    const previous = readRecord(normalized.id);
    if (previous) {
      if (previous.requestHash !== normalized.requestHash) throw error('同一视频请求ID收到不同内容', 409, 'ALI_VIDEO_REQUEST_CONFLICT');
      if (['submitting', 'uncertain', 'unknown'].includes(previous.status)) throw error('上次提交结果未确认，已阻止重复付费', 409, 'ALI_VIDEO_SUBMISSION_UNCERTAIN', {retryBlocked: true, id: previous.id});
      return publicRecord(previous, true);
    }
    const promise = doSubmit(normalized); submitting.set(normalized.id, {hash: normalized.requestHash, promise});
    try { return await promise; } finally { submitting.delete(normalized.id); }
  }
  function outputUrl(value) {
    let url; try { url = new URL(value); } catch { throw error('视频结果地址无效', 502); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.has(url.hostname.toLowerCase())) throw error('视频结果地址不在已核实的官方HTTPS域名内', 502, 'ALI_VIDEO_UNSAFE_RESULT_URL');
    return url;
  }
  async function downloadResponse(remote) {
    let url = outputUrl(remote);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetchImpl(url.href, {method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(downloadTimeoutMs)});
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers?.get?.('location'); if (!location) throw error('结果下载重定向无效', 502); url = outputUrl(new URL(location, url).href); continue; }
      if (!response.ok) throw error('视频结果暂时无法下载，请刷新原任务', 502);
      if (Number(response.headers?.get?.('content-length')) > maxOutputBytes) throw error('视频输出超过本地大小限制', 413);
      return response;
    }
    throw error('视频结果重定向次数过多', 502);
  }
  async function validateVideo(file, record) {
    if (!probe) {
      const {fd, stat} = regular(file, maxOutputBytes); let at = 0, ftyp = false, moov = false, mdat = false;
      try {
        for (let count = 0; at + 8 <= stat.size && count < 10000; count++) {
          const header = Buffer.alloc(16), got = fs.readSync(fd, header, 0, Math.min(16, stat.size - at), at); let length = header.readUInt32BE(0), head = 8; const type = header.toString('ascii', 4, 8);
          if (length === 1) { if (got < 16 || header.readBigUInt64BE(8) > BigInt(stat.size - at)) throw Error('Invalid MP4'); length = Number(header.readBigUInt64BE(8)); head = 16; }
          else if (length === 0) length = stat.size - at;
          if (length < head || at + length > stat.size) throw Error('Invalid MP4');
          ftyp ||= type === 'ftyp'; moov ||= type === 'moov'; mdat ||= type === 'mdat'; at += length;
        }
        if (!ftyp || !moov || !mdat || at !== stat.size) throw error('视频不是完整的MP4容器', 502);
        return {width: null, height: null, duration: null, validation: 'container-only-test'};
      } finally { fs.closeSync(fd); }
    }
    const info = await probe(file), video = info?.streams?.find(stream => stream.codec_type === 'video' && !Number(stream.disposition?.attached_pic));
    const duration = Number(info?.format?.duration || video?.duration), audio = info?.streams?.some(stream => stream.codec_type === 'audio');
    const requestedDuration=record.request.duration??5,tolerance=Math.max(.25,Math.min(.75,requestedDuration*.05));
    const minimum=record.model==='wanx2.1-t2v-turbo'?4:requestedDuration-tolerance,maximum=record.model==='wanx2.1-t2v-turbo'?6.5:requestedDuration+tolerance;
    if (!String(info?.format?.format_name || '').split(',').some(name => ['mov', 'mp4'].includes(name)) || !video || video.codec_name !== 'h264' || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width < 240 || video.height < 240 || video.width > 4096 || video.height > 4096 || !Number.isFinite(duration) || duration < minimum || duration > maximum || audio) throw error('视频轨道、无声配置或时长未通过本地检查', 502);
    if (record.model === 'wanx2.1-t2v-turbo') { const [width, height] = SIZES[record.request.ratio].split('*').map(Number); if (video.width !== width || video.height !== height) throw error('视频画幅与提交参数不一致', 502); }
    else if (Math.abs(video.width / video.height / (record.request.image.width / record.request.image.height) - 1) > .03) throw error('视频画幅与首帧图片不一致', 502);
    return {width: video.width, height: video.height, duration, validation: 'ffprobe'};
  }
  function finalize(record) {
    const pending = record.pendingOutput, dir = folder(record.id);
    if (!pending || !/^part-[a-f0-9-]{36}\.mp4$/.test(pending.part || '') || !/^[a-f0-9]{64}$/.test(pending.sha256 || '')) throw error('视频落盘恢复信息无效', 409);
    const part = path.join(dir, pending.part), target = path.join(dir, 'video.mp4');
    if (fs.existsSync(target)) { const actual = fileHash(target, pending.bytes); if (actual.sha256 !== pending.sha256) throw error('已有输出文件与登记副本不同，未覆盖原文件', 409); }
    else { const actual = fileHash(part, pending.bytes); if (actual.sha256 !== pending.sha256) throw error('视频临时副本校验失败', 409); fs.linkSync(part, target); }
    try { fs.unlinkSync(part); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const {part: _, ...metadata} = pending;
    return mark(record, 'ready', {output: {url: `/files/aliyun-video/${record.id}/video.mp4`, ...metadata}, pendingOutput: null, error: null});
  }
  async function download(record, remote) {
    const dir = folder(record.id), partName = 'part-' + crypto.randomUUID() + '.mp4', part = path.join(dir, partName); let owned = false, registered = false, fd;
    record = mark(record, 'downloading', {error: null});
    try {
      const response = await downloadResponse(remote); fd = fs.openSync(part, 'wx', 0o600); owned = true;
      const digest = crypto.createHash('sha256'); let bytes = 0;
      const chunks = response.body && typeof response.body[Symbol.asyncIterator] === 'function' ? response.body : [Buffer.from(await response.arrayBuffer())];
      for await (const chunk of chunks) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > maxOutputBytes) throw error('视频输出超过本地大小限制', 413); fs.writeSync(fd, buffer); digest.update(buffer); }
      fs.closeSync(fd); fd = undefined;
      const declared = response.headers?.get?.('content-length');
      if (bytes < 32 || (declared !== null && declared !== undefined && Number(declared) !== bytes)) throw error('视频下载未完整结束', 502);
      const media = await validateVideo(part, record), pendingOutput = {part: partName, bytes, sha256: digest.digest('hex'), ...media};
      record = mark(record, 'downloaded', {pendingOutput}); registered = true;
      return finalize(record);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (owned && !registered) { try { fs.unlinkSync(part); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; } }
    }
  }
  async function doRefresh(id) {
    let record = requireRecord(id);
    if (record.status === 'ready') { try { verifiedOutput(record); return publicRecord(record); } catch {} }
    if (record.pendingOutput) { try { return publicRecord(finalize(record)); } catch (cause) { record = mark(record, 'download_failed', {error: {code: 'OUTPUT_RECOVERY_FAILED', message: cleanMessage(cause.message)}}); } }
    if (!record.providerTaskId || ['failed', 'canceled', 'unknown', 'uncertain', 'submitting'].includes(record.status)) return publicRecord(record);
    if (record.nextPollAt && Date.parse(record.nextPollAt) > Date.now()) return publicRecord(record);
    if (!key.trim()) throw error('阿里云视频密钥尚未配置', 503);
    try {
      const response = await fetchImpl(base + '/api/v1/tasks/' + encodeURIComponent(record.providerTaskId), {method: 'GET', redirect: 'error', headers: {Authorization: 'Bearer ' + key.trim()}, signal: AbortSignal.timeout(queryTimeoutMs)}), body = await jsonResponse(response), output = body?.output;
      if ([404, 410].includes(response.status)) return publicRecord(mark(record, 'unknown', {providerStatus: 'UNKNOWN', error: {code: 'TASK_NOT_FOUND', message: '远端任务不存在或已超过有效期，未重新创建付费任务'}}));
      if (!response.ok || !object(output) || (output.task_id !== undefined && output.task_id !== record.providerTaskId)) throw error('原视频任务暂时无法查询', 502);
      const providerStatus = output.task_status;
      record = {...record, providerStatus, nextPollAt: new Date(Date.now() + pollIntervalMs).toISOString()};
      if (providerStatus === 'FAILED') return publicRecord(mark(record, 'failed', {accountedCents: 0, error: {code: safeCode(output.code), message: cleanMessage(output.message)}}));
      if (providerStatus === 'CANCELED' || providerStatus === 'UNKNOWN') return publicRecord(mark(record, providerStatus === 'CANCELED' ? 'canceled' : 'unknown', {error: {code: providerStatus, message: '远端任务已取消或无法确认，未重复创建任务'}}));
      if (providerStatus === 'PENDING' || providerStatus === 'RUNNING') return publicRecord(mark(record, providerStatus === 'RUNNING' ? 'running' : 'queued', {error: null}));
      if (providerStatus !== 'SUCCEEDED' || typeof output.video_url !== 'string') throw error('原任务没有返回完整的视频结果', 502);
      try { return publicRecord(await download(record, output.video_url)); }
      catch (cause) { const latest = requireRecord(id); return publicRecord(mark(latest, 'download_failed', {providerStatus: 'SUCCEEDED', error: {code: safeCode(cause.code || 'DOWNLOAD_FAILED'), message: cleanMessage(cause.message)}})); }
    } catch (cause) {
      return publicRecord(mark(requireRecord(id), record.status === 'ready' ? 'download_failed' : record.status, {nextPollAt: new Date(Date.now() + pollIntervalMs).toISOString(), error: {code: 'POLL_FAILED', message: cleanMessage(cause.message)}}));
    }
  }
  async function refresh(id) {
    if (!validId(id)) throw error('视频任务标识无效');
    if (refreshing.has(id)) return await refreshing.get(id);
    const promise = doRefresh(id); refreshing.set(id, promise);
    try { return await promise; } finally { refreshing.delete(id); }
  }
  function get(id) { const record = readRecord(id); return record ? publicRecord(record) : null; }
  function asset(id) { const record = readRecord(id); return record?.status === 'ready' ? verifiedOutput(record) : null; }
  return Object.freeze({capabilities, submit, get, refresh, asset});
}
