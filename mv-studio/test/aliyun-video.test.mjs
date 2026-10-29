import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createAliVideo} from '../aliyun-video.mjs';
import {createMaterialStore} from '../materials.mjs';

const remote = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/generated/video.mp4?Expires=123&Signature=temporary-secret';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const request = (patch = {}) => ({request_id: crypto.randomUUID(), prompt: '一片原创纸叶在阳光中缓缓转动，固定镜头。', duration: 5, ratio: '16:9', ...patch});
const box = (type, body = Buffer.alloc(0)) => { const bytes = Buffer.alloc(8 + body.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); body.copy(bytes, 8); return bytes; };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov'), box('mdat', Buffer.alloc(16, 1))]);
const videoInfo = (width = 1280, height = 720, patch = {}) => ({format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.04'}, streams: [{codec_type: 'video', codec_name: 'h264', width, height}], ...patch});
function sandbox(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-aliyun-video-test-')); t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const config = {data, key: 'server-only-test-secret', workspace: 'llm-test-workspace', probe: () => videoInfo(), pollIntervalMs: 0, fetchImpl: async () => { throw Error('Every call must have an explicit mock'); }, ...options};
  return {data, folder: path.join(data, 'aliyun-video'), config, adapter: createAliVideo(config)};
}
function flow({pollStatus = 'SUCCEEDED', videoUrl = remote, download = () => new Response(mp4, {headers: {'Content-Length': String(mp4.length), 'Content-Type': 'video/mp4'}})} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith('/video-synthesis')) return json({request_id: 'provider-request', output: {task_id: 'provider-task-1', task_status: 'PENDING'}});
    if (String(url).includes('/api/v1/tasks/')) return json({output: {task_id: 'provider-task-1', task_status: pollStatus, video_url: videoUrl, code: 'InvalidParameter', message: 'provider rejected input'}});
    return download(String(url), init);
  };
  return {calls, fetchImpl};
}

test('官方async请求、同ID持久幂等、重启轮询和本地无声MP4输出校验', async t => {
  const mock = flow(), {adapter, config, folder} = sandbox(t, {fetchImpl: mock.fetchImpl}), input = request();
  assert.equal(adapter.capabilities().estimatedCostCny, 1.2); assert.equal(adapter.capabilities().budgetCny, 20);
  const queued = await adapter.submit(input); assert.equal(queued.status, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,input.request_id+'.json'))).requestHash,'f3903183f9f699d05882f5bf119130dac3630d0f273ac786ef78d9909ec81de3','legacy five-second request signature must remain unchanged');
  const submitted = mock.calls[0]; assert.equal(submitted.url, 'https://llm-test-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(submitted.init.headers['X-DashScope-Async'], 'enable'); assert.equal(submitted.init.headers.Authorization, 'Bearer server-only-test-secret'); assert.equal(submitted.init.redirect, 'error');
  const body = JSON.parse(submitted.init.body); assert.equal(body.model, 'wanx2.1-t2v-turbo'); assert.equal(body.parameters.size, '1280*720'); assert.equal(body.parameters.duration, undefined); assert.equal(body.parameters.prompt_extend, false);
  assert.equal((await adapter.submit(input)).replayed, true); assert.equal(mock.calls.length, 1);
  await assert.rejects(adapter.submit({...input, prompt: '不同内容'}), error => error.status === 409);
  const restarted = createAliVideo(config), ready = await restarted.refresh(input.request_id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.url, `/files/aliyun-video/${input.request_id}/video.mp4`); assert.equal(ready.width, 1280); assert.equal(ready.height, 720); assert.equal(ready.output.validation, 'ffprobe');
  const file = path.join(folder, input.request_id, 'video.mp4'); assert(fs.readFileSync(file).equals(mp4)); assert.equal(ready.sha256, crypto.createHash('sha256').update(mp4).digest('hex'));
  assert.equal(mock.calls[1].init.headers.Authorization, 'Bearer server-only-test-secret'); assert.equal(mock.calls[2].init.headers, undefined); assert.equal(mock.calls[2].init.redirect, 'manual');
  const record = fs.readFileSync(path.join(folder, input.request_id + '.json'), 'utf8'); assert(!record.includes('server-only-test-secret')); assert(!record.includes('temporary-secret')); assert(!record.includes('dashscope-result'));
  assert.equal(restarted.asset(input.request_id).file, fs.realpathSync(file));
  await restarted.refresh(input.request_id); assert.equal(mock.calls.length, 3);
  assert.equal(restarted.capabilities().usedCny, 1.2);
  const altered = Buffer.from(mp4); altered[altered.length - 1] ^= 1; fs.writeFileSync(file, altered);
  assert.equal(restarted.get(input.request_id).status, 'download_failed'); assert.throws(() => restarted.asset(input.request_id));
});

test('预算跨实例/不同任务持久计入，明确provider FAILED释放预留', async t => {
  let posts = 0;
  const {adapter, config} = sandbox(t, {budgetCny: 2.4, fetchImpl: async (url) => String(url).includes('/video-synthesis') ? (posts++, json({output: {task_id: 'task-' + posts, task_status: 'PENDING'}})) : json({output: {task_status: 'FAILED', code: 'InvalidParameter', message: 'invalid input'}})});
  const first = request({prompt: 'first'}), second = request({prompt: 'second'}), third = request({prompt: 'third'});
  await adapter.submit(first); await createAliVideo(config).submit(second);
  await assert.rejects(createAliVideo(config).submit(third), error => error.status === 402 && error.code === 'ALI_VIDEO_BUDGET_EXCEEDED'); assert.equal(posts, 2); assert.equal(adapter.capabilities().remainingCny, 0);
  assert.equal((await adapter.refresh(first.request_id)).status, 'failed'); assert.equal(adapter.get(first.request_id).accountedCostCny, 0);
  await adapter.submit(third); assert.equal(posts, 3); assert.equal(adapter.capabilities().usedCny, 2.4);
});

test('超时结果不明计入全额预算，同ID和换ID同内容均不盲目重提', async t => {
  let posts = 0;
  const {adapter, config} = sandbox(t, {fetchImpl: async () => { posts++; throw new DOMException('mock timeout', 'TimeoutError'); }}), input = request();
  await assert.rejects(adapter.submit(input), error => error.status === 409 && error.retryBlocked);
  assert.equal(adapter.get(input.request_id).status, 'uncertain'); assert.equal(adapter.capabilities().usedCny, 1.2);
  const restarted = createAliVideo(config);
  await assert.rejects(restarted.submit(input), error => error.retryBlocked);
  await assert.rejects(restarted.submit({...input, request_id: crypto.randomUUID()}), error => error.retryBlocked);
  assert.equal((await restarted.refresh(input.request_id)).status, 'uncertain'); assert.equal(posts, 1);
});

test('并发同ID只提交一次；请求前已登记预算，另实例不能重提pending', async t => {
  let resolve, posts = 0;
  const {adapter, config, folder} = sandbox(t, {fetchImpl: async () => { posts++; return await new Promise(r => { resolve = r; }); }}), input = request();
  const first = adapter.submit(input), second = adapter.submit(input);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, input.request_id + '.json'))).status, 'submitting');
  await assert.rejects(createAliVideo(config).submit(input), error => error.retryBlocked);
  await assert.rejects(adapter.submit({...input, request_id: crypto.randomUUID()}), error => error.retryBlocked);
  resolve(json({output: {task_id: 'task-pending', task_status: 'PENDING'}}));
  const results = await Promise.all([first, second]); assert.equal(results[0].id, results[1].id); assert.equal(results[1].replayed, true); assert.equal(posts, 1);
});

test('首帧取注册图片并验证hash；flash显式720P/audio:false，不把base64或key落盘', async t => {
  const mock = flow(); const probe = file => file.endsWith('.png') ? {format: {format_name: 'png_pipe'}, streams: [{codec_type: 'video', codec_name: 'png', width: 320, height: 240}]} : videoInfo(960, 720);
  const {adapter, data, folder} = sandbox(t, {model: 'wan2.6-i2v-flash', probe, fetchImpl: mock.fetchImpl});
  const images = createMaterialStore({data, probe}), png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24)]), image = images.upload('frame.png', png), input = request({ratio: '4:3', image: {material_id: image.id}});
  assert.equal(adapter.capabilities().estimatedCostCny, .75);
  await adapter.submit(input); const body = JSON.parse(mock.calls[0].init.body); assert.match(body.input.img_url, /^data:image\/png;base64,/); assert.equal(body.parameters.audio, false); assert.equal(body.parameters.resolution, '720P'); assert.equal(body.parameters.duration, 5);
  assert.equal((await adapter.refresh(input.request_id)).status, 'ready');
  const record = fs.readFileSync(path.join(folder, input.request_id + '.json'), 'utf8'); assert(!record.includes('base64')); assert(!record.includes('server-only-test-secret'));
  await assert.rejects(adapter.submit(request({ratio: '16:9', image: {material_id: image.id}})), /首帧决定/);
  fs.appendFileSync(path.join(data, 'materials', path.basename(image.url)), Buffer.from([1]));
  await assert.rejects(adapter.submit(request({ratio: '4:3', image: {material_id: image.id}})), /首帧需/);
});

test('只从精确官方HTTPS域名下载，每次redirect重验，绝不发送API Key至CDN', async t => {
  for (const unsafe of ['http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.mp4', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.test/x.mp4', 'https://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.mp4']) {
    const mock = flow({videoUrl: unsafe}), {adapter} = sandbox(t, {fetchImpl: mock.fetchImpl}), input = request(); await adapter.submit(input);
    assert.equal((await adapter.refresh(input.request_id)).status, 'download_failed'); assert.equal(mock.calls.length, 2);
  }
  const redirected = flow({download: () => new Response(null, {status: 302, headers: {Location: 'https://evil.test/video.mp4'}})}), {adapter} = sandbox(t, {fetchImpl: redirected.fetchImpl}), input = request();
  await adapter.submit(input); assert.equal((await adapter.refresh(input.request_id)).status, 'download_failed'); assert.equal(redirected.calls.length, 3); assert.equal(redirected.calls[2].init.headers, undefined);
});

test('已认证任务返回的乌兰察布精确域名可下载，相似前缀与恶意后缀仍拒绝', async t => {
  const host = 'dashscope-result-wlcb-acdr-1.oss-cn-wulanchabu-acdr-1.aliyuncs.com';
  const allowed = flow({videoUrl: `https://${host}/generated/video.mp4?Expires=123&Signature=mock-private`});
  const {adapter} = sandbox(t, {fetchImpl: allowed.fetchImpl}), input = request();
  await adapter.submit(input);
  assert.equal((await adapter.refresh(input.request_id)).status, 'ready');
  assert.equal(new URL(allowed.calls[2].url).hostname, host);
  assert.equal(allowed.calls[2].init.headers, undefined);
  for (const unsafe of [`${host}.evil.test`, `other-${host}`, 'dashscope-result-wlcb-acdr-2.oss-cn-wulanchabu-acdr-1.aliyuncs.com']) {
    const mock = flow({videoUrl: `https://${unsafe}/video.mp4`}), env = sandbox(t, {fetchImpl: mock.fetchImpl}), rejected = request();
    await env.adapter.submit(rejected);
    assert.equal((await env.adapter.refresh(rejected.request_id)).status, 'download_failed');
    assert.equal(mock.calls.length, 2);
  }
});

test('verified a717 official output host is accepted without allowing suffix lookalikes',async t=>{
 const host='dashscope-a717.oss-accelerate.aliyuncs.com';const mock=flow({videoUrl:`https://${host}/video.mp4`}),{adapter}=sandbox(t,{fetchImpl:mock.fetchImpl}),input=request();await adapter.submit(input);assert.equal((await adapter.refresh(input.request_id)).status,'ready');assert.equal(mock.calls[2].init.headers,undefined);
 for(const bad of [`${host}.evil.test`,'dashscope-a718.oss-accelerate.aliyuncs.com']){const f=flow({videoUrl:`https://${bad}/video.mp4`}),s=sandbox(t,{fetchImpl:f.fetchImpl}),q=request();await s.adapter.submit(q);assert.equal((await s.adapter.refresh(q.request_id)).status,'download_failed');}
});

test('过大、截断或带音频的输出不能成为ready，不遗留未登记临时副本', async t => {
  for (const variant of ['oversize', 'truncated', 'audio']) {
    const mock = flow({download: () => new Response(mp4, {headers: {'Content-Length': String(variant === 'oversize' ? 1000 : variant === 'truncated' ? mp4.length + 1 : mp4.length)}})});
    const {adapter, folder} = sandbox(t, {fetchImpl: mock.fetchImpl, maxOutputBytes: 100, probe: () => variant === 'audio' ? videoInfo(1280, 720, {streams: [...videoInfo().streams, {codec_type: 'audio', codec_name: 'aac'}]}) : videoInfo()}), input = request();
    await adapter.submit(input); assert.equal((await adapter.refresh(input.request_id)).status, 'download_failed');
    assert.deepEqual(fs.readdirSync(path.join(folder, input.request_id)), []); assert.equal(adapter.capabilities().usedCny, 1.2);
  }
});

test('落盘已验证但最终链接中断可重启恢复，不再次POST或下载', async t => {
  const mock = flow(), {adapter, config, folder} = sandbox(t, {fetchImpl: mock.fetchImpl}), input = request(); await adapter.submit(input);
  const actualLink = fs.linkSync; let fail = true;
  t.mock.method(fs, 'linkSync', (...args) => { if (fail) { fail = false; throw Error('mock link interruption'); } return actualLink(...args); });
  assert.equal((await adapter.refresh(input.request_id)).status, 'download_failed');
  assert(JSON.parse(fs.readFileSync(path.join(folder, input.request_id + '.json'))).pendingOutput);
  assert.equal((await createAliVideo(config).refresh(input.request_id)).status, 'ready'); assert.equal(mock.calls.length, 3);
});

test('未配置、非法请求、损坏预算记录与符号链接在付费前拒绝', async t => {
  let calls = 0; const {adapter, folder, data, config} = sandbox(t, {fetchImpl: async () => { calls++; return json({output: {task_id: 'task-1', task_status: 'PENDING'}}); }});
  for (const input of [request({request_id: '../unsafe'}), request({duration: 10}), request({ratio: '3:2'}), request({prompt: ''}), request({image: {material_id: crypto.randomUUID()}}), {...request(), source: {id: 'sample'}}]) await assert.rejects(adapter.submit(input));
  await assert.rejects(createAliVideo({...config, key: ''}).submit(request()), error => error.status === 503); assert.equal(calls, 0);
  await adapter.submit(request()); const record = fs.readdirSync(folder).find(name => name.endsWith('.json')), file = path.join(folder, record), saved = JSON.parse(fs.readFileSync(file)); saved.accountedCents = 0; fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(adapter.capabilities().available, false); await assert.rejects(adapter.submit(request()), error => error.status === 503); assert.equal(calls, 1);
  const linked = path.join(data, 'linked'); fs.mkdirSync(linked); fs.symlinkSync(folder, path.join(linked, 'aliyun-video')); assert.throws(() => createAliVideo({...config, data: linked}), /符号链接/);
});

test('mock无probe也检查MP4结构；真实fetch未配置probe时禁止付费生成', async t => {
  const mock = flow(), {adapter} = sandbox(t, {fetchImpl: mock.fetchImpl, probe: undefined}), input = request(); await adapter.submit(input);
  const ready = await adapter.refresh(input.request_id); assert.equal(ready.status, 'ready'); assert.equal(ready.output.validation, 'container-only-test'); assert.equal(ready.width, null);
  const noProbe = sandbox(t, {fetchImpl: globalThis.fetch, probe: undefined}); assert.equal(noProbe.adapter.capabilities().available, false);
  const invalid = flow({download: () => new Response(Buffer.alloc(64))}), second = sandbox(t, {fetchImpl: invalid.fetchImpl, probe: undefined}), other = request();
  await second.adapter.submit(other); assert.equal((await second.adapter.refresh(other.request_id)).status, 'download_failed');
});

test('flash 2/10/15秒显式参数、费用与时长校验；turbo仍只允许5秒',async t=>{
  for(const duration of[2,10,15]){
    const mock=flow(),probe=file=>file.endsWith('.png')?{format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width:320,height:240}]}:videoInfo(960,720,{format:{format_name:'mov,mp4',duration:String(duration+.04)}});
    const{adapter,data,config}=sandbox(t,{model:'wan2.6-i2v-flash',probe,fetchImpl:mock.fetchImpl});
    const material=createMaterialStore({data,probe}).upload('frame.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]));
    const input=request({duration,ratio:'4:3',image:{material_id:material.id}}),queued=await adapter.submit(input),parameters=JSON.parse(mock.calls[0].init.body).parameters;
    assert.equal(parameters.duration,duration);assert.equal(parameters.resolution,'720P');assert.equal(parameters.audio,false);assert.equal(queued.duration,duration);assert.equal(queued.estimatedCostCny,duration*.15);assert.equal(adapter.capabilities().usedCny,duration*.15);
    assert.deepEqual(adapter.capabilities().durations,Array.from({length:14},(_,i)=>i+2));assert.equal(adapter.capabilities().estimatedCostsCny[10],1.5);assert.equal(adapter.capabilities().estimatedCostsCny[15],2.25);
    const ready=await createAliVideo(config).refresh(input.request_id);assert.equal(ready.status,'ready');assert.equal(ready.duration,duration);assert.equal(ready.output.duration,duration+.04);
    assert.equal((await adapter.submit(input)).replayed,true);await assert.rejects(adapter.submit({...input,duration:duration===15?10:15}),error=>error.status===409);assert.equal(mock.calls.filter(call=>call.init.method==='POST').length,1);
  }
});

test('flash非整数/越界时长在计费前拒绝',async t=>{
  let posts=0;const{adapter}=sandbox(t,{model:'wan2.6-i2v-flash',fetchImpl:async()=>{posts++;throw Error('must not fetch');}});
  for(const duration of[0,1,1.5,16,-2,NaN,Infinity,'10'])await assert.rejects(adapter.submit(request({duration,image:{material_id:crypto.randomUUID()}})),error=>error.status===400);
  assert.equal(posts,0);assert.equal(adapter.capabilities().usedCny,0);
});

test('model-specific prompt limits reject before paid calls instead of relying on upstream truncation',async t=>{
 const turbo=flow(),a=sandbox(t,{fetchImpl:turbo.fetchImpl});assert.equal(a.adapter.capabilities().maxPromptChars,800);await assert.rejects(a.adapter.submit(request({prompt:'字'.repeat(801)})));assert.equal(turbo.calls.length,0);await a.adapter.submit(request({prompt:'字'.repeat(800)}));assert.equal(turbo.calls.length,1);
 const flash=flow(),probe=file=>file.endsWith('.png')?{format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width:320,height:240}]}:videoInfo(960,720),b=sandbox(t,{model:'wan2.6-i2v-flash',probe,fetchImpl:flash.fetchImpl}),m=createMaterialStore({data:b.data,probe}).upload('frame.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]));assert.equal(b.adapter.capabilities().maxPromptChars,1500);const input=request({ratio:'4:3',image:{material_id:m.id}});await assert.rejects(b.adapter.submit({...input,prompt:'字'.repeat(1501)}));assert.equal(flash.calls.length,0);await b.adapter.submit({...input,prompt:'字'.repeat(1500)});assert.equal(flash.calls.length,1);
});

test('长视频不能通过旧5秒窗口，已成功远端任务仍保留完整估价',async t=>{
  for(const requested of[10,15]){
    const mock=flow(),probe=file=>file.endsWith('.png')?{format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width:320,height:240}]}:videoInfo(960,720);
    const{adapter,data}=sandbox(t,{model:'wan2.6-i2v-flash',probe,fetchImpl:mock.fetchImpl});const image=createMaterialStore({data,probe}).upload('frame.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]));
    const input=request({duration:requested,ratio:'4:3',image:{material_id:image.id}});await adapter.submit(input);assert.equal((await adapter.refresh(input.request_id)).status,'download_failed');assert.equal(adapter.capabilities().usedCny,requested*.15);
  }
});

test('同DATA的turbo/flash共用预算并读取双方输出，旧5秒记录不改写',async t=>{
  let activeModel='turbo',activeDuration=5,sequence=0;const statuses=new Map(),calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url:String(url),init});if(init.method==='POST'){const id='shared-task-'+(++sequence);statuses.set(id,'PENDING');return json({output:{task_id:id,task_status:'PENDING'}});}if(String(url).includes('/api/v1/tasks/')){const id=String(url).split('/').at(-1);return json({output:{task_id:id,task_status:statuses.get(id)==='FAILED'?'FAILED':'SUCCEEDED',video_url:remote,code:'InvalidParameter',message:'failed'}});}return new Response(mp4);};
  const probe=file=>file.endsWith('.png')?{format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width:320,height:240}]}:videoInfo(activeModel==='turbo'?1280:960,720,{format:{format_name:'mov,mp4',duration:String(activeDuration+.04)}});
  const{adapter,config,data,folder}=sandbox(t,{budgetCny:4,probe,fetchImpl}),old=request();await adapter.submit(old);await adapter.refresh(old.request_id);const originalRecord=fs.readFileSync(path.join(folder,old.request_id+'.json'));
  const flash=createAliVideo({...config,model:'wan2.6-i2v-flash'}),image=createMaterialStore({data,probe}).upload('frame.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]));
  assert.equal(flash.get(old.request_id).status,'ready');assert.equal(flash.get(old.request_id).duration,5);assert(flash.asset(old.request_id));assert.equal(flash.capabilities().usedCny,1.2);assert.deepEqual(adapter.capabilities().durations,[5]);
  const ten=request({duration:10,ratio:'4:3',image:{material_id:image.id}}),fifteen=request({duration:15,ratio:'4:3',image:{material_id:image.id}});await flash.submit(ten);assert.equal(adapter.capabilities().usedCny,2.7);await assert.rejects(flash.submit(fifteen),error=>error.status===402&&error.estimatedCostCny===2.25);assert.equal(sequence,2);
  statuses.set('shared-task-2','FAILED');await flash.refresh(ten.request_id);assert.equal(adapter.capabilities().usedCny,1.2);await flash.submit(fifteen);activeModel='flash';activeDuration=15;assert.equal((await flash.refresh(fifteen.request_id)).status,'ready');assert.equal(adapter.capabilities().usedCny,3.45);
  assert(fs.readFileSync(path.join(folder,old.request_id+'.json')).equals(originalRecord));assert.equal((await adapter.submit(old)).replayed,true);assert.equal(sequence,3);
});

test('15秒提交结果不明预留2.25元，重启及换ID不会再次POST',async t=>{
  let posts=0;const probe=file=>file.endsWith('.png')?{format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width:320,height:240}]}:videoInfo();
  const{adapter,config,data}=sandbox(t,{model:'wan2.6-i2v-flash',probe,fetchImpl:async()=>{posts++;throw new DOMException('mock timeout','TimeoutError');}}),image=createMaterialStore({data,probe}).upload('frame.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)])),input=request({duration:15,ratio:'4:3',image:{material_id:image.id}});
  await assert.rejects(adapter.submit(input),error=>error.retryBlocked);assert.equal(adapter.capabilities().usedCny,2.25);assert.equal(adapter.get(input.request_id).duration,15);await assert.rejects(createAliVideo(config).submit(input),error=>error.retryBlocked);await assert.rejects(adapter.submit({...input,request_id:crypto.randomUUID()}),error=>error.retryBlocked);assert.equal(posts,1);
});
