// Seedance 2.5 upstream protocol adapter. This module does not perform durable
// accounting, retries, output downloads, or API routing. The caller MUST record
// a durable budget reservation and request ID before calling submit, and MUST
// treat an uncertain result as potentially billed. Never expose the upstream
// signed result URL or the API key to a browser.
// https://www.volcengine.com/docs/82379/1520757
// https://console.volcengine.com/ark/region:cn-beijing/docs/seedance-2-5

const BASE = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const MODEL = 'doubao-seedance-2-5-260628';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_IMAGE_BYTES = 29_000_000;
const MAX_BODY_BYTES = 64_000;
const fail = (message, code, extra = {}) => Object.assign(new Error(message), {code, ...extra});

function validateImage(data) {
  if (typeof data !== 'string') throw fail('需要已验证的首帧图片', 'SEEDANCE_INVALID_IMAGE');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!m || m[2].length % 4 !== 0 || m[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw fail('首帧必须是小于 29MB 的 PNG、JPEG 或 WebP 图片', 'SEEDANCE_INVALID_IMAGE');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== m[2]) throw fail('首帧图片编码无效', 'SEEDANCE_INVALID_IMAGE');
  const png = bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpeg) || (m[1] === 'webp' && !webp)) throw fail('首帧图片格式不匹配', 'SEEDANCE_INVALID_IMAGE');
  return data;
}

/** Build the official first-frame request; caller separately verifies dimensions. */
export function seedance25Request({prompt, imageDataUri, duration = 5} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 5000 || /\x00/.test(prompt)) throw fail('请提供 5000 字内的视频描述', 'SEEDANCE_INVALID_PROMPT');
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) throw fail('Seedance 2.5 视频时长需为 4 至 30 秒的整数', 'SEEDANCE_INVALID_DURATION');
  return {model: MODEL, content: [{type:'text', text:prompt.trim()}, {type:'image_url', image_url:{url:validateImage(imageDataUri)}, role:'first_frame'}], resolution:'720p', ratio:'adaptive', duration, generate_audio:false, watermark:true};
}

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw Error('response too large');
  let bytes = 0, chunks = [];
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) throw Error('response too large'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const raw = await response.text(); if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw Error('response too large');
  return JSON.parse(raw);
}

/** Low-level client; one POST per invocation, one GET per query, no hidden retries. */
export function createSeedance25Client({key='', fetchImpl=globalThis.fetch, submitTimeoutMs=40000, queryTimeoutMs=20000} = {}) {
  if (typeof key !== 'string' || /[\r\n]/.test(key) || key.length > 4096 || typeof fetchImpl !== 'function' || !Number.isSafeInteger(submitTimeoutMs) || submitTimeoutMs < 1 || !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1) throw new TypeError('Seedance 配置无效');
  const headers = {'Content-Type':'application/json', Authorization:'Bearer '+key.trim()};
  function requireKey() { if (!key.trim()) throw fail('未配置火山方舟 API 密钥', 'SEEDANCE_NOT_CONFIGURED'); }
  return {
    capabilities() { return {configured:!!key.trim(), model:MODEL, minDuration:4, maxDuration:30, audio:false, input:'first_frame', resolution:'720p'}; },
    async submit(input) {
      requireKey(); const body = seedance25Request(input); let response, payload;
      try { response = await fetchImpl(BASE, {method:'POST', redirect:'error', headers, body:JSON.stringify(body), signal:AbortSignal.timeout(submitTimeoutMs)}); payload = await readJson(response); }
      catch { throw fail('提交结果未确认，禁止直接重试；请先核对远端任务', 'SEEDANCE_SUBMISSION_UNCERTAIN', {retryBlocked:true}); }
      if (!response.ok) {
        // HTTP errors do not, by themselves, prove the upstream did not create
        // a task. Preserve the reservation and require reconciliation.
        throw fail('提交未成功确认，请检查方舟账号及任务记录后再操作', 'SEEDANCE_SUBMISSION_UNCERTAIN', {retryBlocked:true, httpStatus:response.status});
      }
      if (!TASK_ID.test(payload?.id || '')) throw fail('服务未返回有效任务 ID；请核对远端任务', 'SEEDANCE_SUBMISSION_UNCERTAIN', {retryBlocked:true});
      return {providerTaskId:payload.id, status:'queued'};
    },
    async query(providerTaskId) {
      requireKey(); if (typeof providerTaskId !== 'string' || !TASK_ID.test(providerTaskId)) throw fail('任务 ID 无效', 'SEEDANCE_INVALID_TASK');
      let response, payload;
      try { response = await fetchImpl(BASE + '/' + encodeURIComponent(providerTaskId), {method:'GET', redirect:'error', headers, signal:AbortSignal.timeout(queryTimeoutMs)}); payload = await readJson(response); }
      catch { throw fail('查询任务失败，可稍后再次查询；不会重新生成', 'SEEDANCE_QUERY_FAILED'); }
      if (!response.ok || payload?.id !== providerTaskId) throw fail('查询任务失败，可稍后再次查询；不会重新生成', 'SEEDANCE_QUERY_FAILED');
      const status = payload.status;
      if (status === 'queued' || status === 'running') return {providerTaskId, status};
      if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired') return {providerTaskId, status:'failed', providerStatus:status};
      if (status !== 'succeeded') return {providerTaskId, status:'uncertain', retryBlocked:true};
      let url;
      try { url = new URL(payload.content?.video_url); } catch { throw fail('生成完成但没有可用的视频地址', 'SEEDANCE_OUTPUT_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port) throw fail('生成结果地址无效', 'SEEDANCE_OUTPUT_INVALID');
      // This signed URL is untrusted and sensitive: a separate download layer
      // must enforce a verified host allowlist, block redirects and validate MP4.
      return {providerTaskId, status:'succeeded', outputUrl:url.href};
    }
  };
}
