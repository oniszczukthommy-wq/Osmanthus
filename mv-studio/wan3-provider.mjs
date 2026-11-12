import crypto from 'node:crypto';

// Protocol only. The caller MUST wrap submit in its durable budget and
// idempotency ledger. Never retry a timed-out POST: it may have been accepted.
// https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
// https://help.aliyun.com/zh/model-studio/get-temporary-file-url/
const MODELS = new Set(['wan3.0-video', 'wan3.0-video-prime']);
const RATIOS = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const RATES = {'wan3.0-video': {'480P': 30, '720P': 60, '1080P': 120}, 'wan3.0-video-prime': {'480P': 45, '720P': 90, '1080P': 180}};
const bad = message => Object.assign(new Error(message), {code: 'WAN3_INVALID_INPUT', status: 400});
const taskId = value => typeof value === 'string' && /^[a-z0-9_-]{1,150}$/i.test(value);
const oss = value => typeof value === 'string' && /^oss:\/\/dashscope-instant\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..');

export function wan3EstimateCents({model = 'wan3.0-video', resolution = '720P', duration} = {}) {
  if (!MODELS.has(model) || !RATES[model][resolution] || !Number.isInteger(duration) || duration < 2 || duration > 30) throw bad('万相 3.0 视频参数无效');
  // Beijing list price as of 2026-11-11; estimate, not an invoice. No input video is accepted here.
  return RATES[model][resolution] * duration;
}

// Video editing is billed for input video as well as output video. Reserve
// the next whole input second when duration is fractional (conservative).
export function wan3RelipEstimateCents({model='wan3.0-video',resolution='720P',duration,inputDuration}={}){
  const output=wan3EstimateCents({model,resolution,duration});
  if(!Number.isFinite(inputDuration)||inputDuration<1||inputDuration>15||inputDuration+duration>30)throw bad('输入视频和输出视频的时长超出万相限制');
  return output+RATES[model][resolution]*Math.ceil(inputDuration);
}

export function buildWan3RelipRequest({model='wan3.0-video',prompt,videoUrl,audioUrl,inputDuration,audioDuration,audioBytes,duration,ratio='adaptive',resolution='720P',watermark=true}={}){
  const estimatedCents=wan3RelipEstimateCents({model,resolution,duration,inputDuration});
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>20000||/\0/.test(prompt))throw bad('请提供 20000 字以内的镜头修改要求');
  if(!oss(videoUrl)||!oss(audioUrl))throw bad('视频及音频需使用百炼临时素材地址');
  if(!Number.isFinite(audioDuration)||audioDuration<1||audioDuration>15||!Number.isInteger(audioBytes)||audioBytes<1||audioBytes>15_000_000)throw bad('参考音频不符合模型限制');
  if(!RATIOS.has(ratio)||typeof watermark!=='boolean')throw bad('视频画幅或水印参数无效');
  return {estimatedCents,body:{model,input:{prompt:prompt.trim(),media:[{type:'reference_video',url:videoUrl},{type:'reference_audio',url:audioUrl}]},parameters:{resolution,ratio,duration,audio:true,prompt_extend:false,watermark}}};
}

export function buildWan3LipSyncRequest({model = 'wan3.0-video', prompt, imageDataUrl, audioUrl, audioDuration, audioBytes, duration, ratio = '16:9', resolution = '720P', watermark = true} = {}) {
  const estimatedCents = wan3EstimateCents({model, resolution, duration});
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000 || /\0/.test(prompt)) throw bad('请提供不超过 20000 字的镜头提示词');
  if (typeof imageDataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl) || imageDataUrl.length > 27_000_000) throw bad('角色图必须是有效的图片数据');
  if (!oss(audioUrl)) throw bad('音频需要使用通过百炼上传获取的临时 OSS 地址');
  if (!Number.isFinite(audioDuration) || audioDuration < 1 || audioDuration > 15 || !Number.isInteger(audioBytes) || audioBytes < 1 || audioBytes > 15_000_000) throw bad('参考音频需为 1 至 15 秒且不超过 15MB');
  if (!RATIOS.has(ratio) || typeof watermark !== 'boolean') throw bad('视频画幅或水印参数无效');
  return {estimatedCents, body: {model, input: {prompt: prompt.trim(), media: [{type: 'reference_image', url: imageDataUrl}, {type: 'reference_audio', url: audioUrl}]}, parameters: {resolution, ratio, duration, audio: true, prompt_extend: false, watermark}}};
}

function validConfig({key, workspace, fetchImpl}) {
  // Beijing's shared DashScope host accepts a regional key without an
  // explicit workspace. A supplied workspace must still be a safe host label.
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key) || typeof workspace !== 'string' || (workspace !== '' && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(workspace)) || typeof fetchImpl !== 'function') throw bad('万相密钥或北京地域业务空间配置无效');
}

async function limitedJson(response) {
  const body = await response.text();
  if (Buffer.byteLength(body) > 64000) throw new Error('服务响应过大');
  return JSON.parse(body);
}

/** Upload a validated audio segment to Alibaba's 48-hour temporary storage. */
async function uploadWan3File({key, workspace = '', bytes, mime, duration, model = 'wan3.0-video', fetchImpl = globalThis.fetch,kind} = {}) {
  validConfig({key, workspace, fetchImpl});
  const types=kind==='audio'?{'audio/wav':'.wav','audio/mpeg':'.mp3'}:kind==='video'?{'video/mp4':'.mp4','video/quicktime':'.mov'}:{};
  if (!MODELS.has(model) || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > (kind==='audio'?15_000_000:100_000_000) || !Number.isFinite(duration) || duration < 1 || duration > 15 || !Object.hasOwn(types,mime)) throw bad('参考素材格式、时长或大小不符合万相限制');
  const policyUrl = new URL('https://dashscope.aliyuncs.com/api/v1/uploads');
  policyUrl.searchParams.set('action', 'getPolicy'); policyUrl.searchParams.set('model', model);
  const policyRes = await fetchImpl(policyUrl.toString(), {method: 'GET', redirect: 'error', headers: {Authorization: 'Bearer ' + key.trim()}, signal: AbortSignal.timeout(20000)});
  if (!policyRes.ok) throw new Error('获取百炼音频上传凭证失败');
  const p = (await limitedJson(policyRes)).data;
  if (!p || typeof p.upload_host !== 'string' || !/^https:\/\/[a-z0-9-]+\.oss-cn-beijing\.aliyuncs\.com\/?$/i.test(p.upload_host) || typeof p.upload_dir !== 'string' || !/^dashscope-instant\/[a-z0-9_/-]+$/i.test(p.upload_dir) || p.upload_dir.includes('..') || !['policy', 'signature', 'oss_access_key_id', 'x_oss_object_acl', 'x_oss_forbid_overwrite'].every(k => typeof p[k] === 'string' && p[k].length > 0 && p[k].length < 8192)) throw new Error('百炼上传凭证格式无效');
  const name = crypto.randomUUID() + types[mime];
  const objectKey = p.upload_dir + '/' + name;
  const form = new FormData();
  form.set('OSSAccessKeyId', p.oss_access_key_id); form.set('policy', p.policy); form.set('Signature', p.signature);
  form.set('key', objectKey); form.set('x-oss-object-acl', p.x_oss_object_acl); form.set('x-oss-forbid-overwrite', p.x_oss_forbid_overwrite);
  form.set('success_action_status', '200'); form.set('file', new Blob([bytes], {type: mime}), name);
  const response = await fetchImpl(p.upload_host, {method: 'POST', redirect: 'error', body: form, signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error('上传参考音频失败');
  return {url: 'oss://' + objectKey, duration, bytes: bytes.length, expiresInHours: 48};
}
export function uploadWan3Audio(input={}){return uploadWan3File({...input,kind:'audio'});}
export function uploadWan3Video(input={}){return uploadWan3File({...input,kind:'video'});}

/** Raw transport. submit requires an external durable exactly-once budget gate. */
export function createWan3Transport({key, workspace = '', fetchImpl = globalThis.fetch, chargeGate} = {}) {
  validConfig({key, workspace, fetchImpl});
  const base = workspace ? `https://${workspace}.cn-beijing.maas.aliyuncs.com` : 'https://dashscope.aliyuncs.com';
  const headers = {Authorization: 'Bearer ' + key.trim()};
  async function submitRequest(request, requestId) {
    if (!taskId(requestId)) throw bad('缺少有效的本地请求 ID');
    if (!chargeGate || typeof chargeGate.run !== 'function') throw Object.assign(new Error('未配置持久预算和幂等保护，禁止付费提交'), {code: 'WAN3_CHARGE_GATE_REQUIRED'});
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
    return chargeGate.run({requestId, requestHash, estimatedCents: request.estimatedCents}, async () => {
      let response, body;
      try {
        response = await fetchImpl(base + '/api/v1/services/aigc/video-generation/video-synthesis', {method: 'POST', redirect: 'error', headers: {...headers, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable'}, body: JSON.stringify(request.body), signal: AbortSignal.timeout(40000)});
        body = await limitedJson(response);
      } catch {
        throw Object.assign(new Error('万相任务提交结果不确定，请勿重复提交'), {code: 'WAN3_SUBMISSION_UNCERTAIN', retryBlocked: true});
      }
      if (!response.ok || !taskId(body?.output?.task_id)) {
        // A response without a usable task ID is not automatically safe to retry.
        throw Object.assign(new Error('万相未返回可查询任务，请核对后处理'), {code: 'WAN3_SUBMISSION_UNCERTAIN', retryBlocked: true, providerStatus: response.status});
      }
      return {taskId: body.output.task_id, status: body.output.task_status || 'PENDING', estimatedCents: request.estimatedCents};
    });
  }
  const submit=(spec,requestId)=>submitRequest(buildWan3LipSyncRequest(spec),requestId);
  const submitRelip=(spec,requestId)=>submitRequest(buildWan3RelipRequest(spec),requestId);
  async function query(id) {
    if (!taskId(id)) throw bad('万相任务 ID 无效');
    const response = await fetchImpl(base + '/api/v1/tasks/' + id, {method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('查询万相任务失败');
    const body = await limitedJson(response), result = body?.output;
    if (!result || result.task_id !== id || !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'].includes(result.task_status)) throw new Error('万相返回了无效任务状态');
    // The result URL must be allowlisted and downloaded/validated by the caller.
    return {taskId: id, status: result.task_status, videoUrl: result.task_status === 'SUCCEEDED' && typeof result.video_url === 'string' ? result.video_url : null};
  }
  return {submit, submitRelip, query};
}
