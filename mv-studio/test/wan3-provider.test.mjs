import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWan3LipSyncRequest, createWan3Transport, uploadWan3Audio, wan3EstimateCents} from '../wan3-provider.mjs';

const spec = {prompt: '图1中的人物对着音频1歌唱', imageDataUrl: 'data:image/png;base64,YWJj', audioUrl: 'oss://dashscope-instant/account/tmp/song.wav', audioDuration: 5, audioBytes: 3000, duration: 5};
const fakeResponse = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

test('reference image and audio are passed using the compatible multimodal mode', () => {
  const r = buildWan3LipSyncRequest(spec);
  assert.equal(r.estimatedCents, 300);
  assert.equal(r.body.model, 'wan3.0-video');
  assert.deepEqual(r.body.input.media.map(x => x.type), ['reference_image', 'reference_audio']);
  assert.equal(r.body.input.media[1].url, spec.audioUrl);
  assert.equal(r.body.parameters.audio, true);
  assert.equal(wan3EstimateCents({model: 'wan3.0-video-prime', resolution: '1080P', duration: 5}), 900);
});

test('invalid audio references, oversized media and durations fail closed', () => {
  for (const patch of [{audioUrl:'data:audio/wav;base64,YWJj'}, {audioUrl:'oss://dashscope-instant/../secret'}, {audioDuration:16}, {audioBytes:15000001}, {duration:1}, {imageDataUrl:'https://evil.invalid/picture.jpg'}, {ratio:'2:1'}]) {
    assert.throws(() => buildWan3LipSyncRequest({...spec, ...patch}), {code:'WAN3_INVALID_INPUT'});
  }
});

test('provider refuses paid request without durable charge gate', async () => {
  let calls = 0;
  const p = createWan3Transport({key:'test-key', workspace:'my-space', fetchImpl:async () => {calls++; return fakeResponse({});}});
  await assert.rejects(() => p.submit(spec, 'request-1'), {code:'WAN3_CHARGE_GATE_REQUIRED'});
  assert.equal(calls, 0);
});

test('provider passes the request through the charge gate, sends one POST and polls by task ID', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {calls.push({url,options}); return calls.length === 1 ? fakeResponse({output:{task_id:'task-1', task_status:'PENDING'}}) : fakeResponse({output:{task_id:'task-1', task_status:'SUCCEEDED', video_url:'https://output.example/video.mp4'}});};
  const gate = {run: async (reservation, execute) => {assert.equal(reservation.estimatedCents, 300); assert.equal(reservation.requestId,'request-1'); assert.match(reservation.requestHash,/^[a-f0-9]{64}$/); return execute();}};
  const p = createWan3Transport({key:'test-key', workspace:'my-space', fetchImpl, chargeGate:gate});
  const job = await p.submit(spec, 'request-1');
  assert.equal(job.taskId, 'task-1');
  assert.equal(calls[0].url,'https://my-space.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(calls[0].options.headers['X-DashScope-OssResourceResolve'], 'enable');
  assert.equal(JSON.parse(calls[0].options.body).input.media[1].type, 'reference_audio');
  assert.equal((await p.query(job.taskId)).status, 'SUCCEEDED');
  assert.equal(calls[1].url,'https://my-space.cn-beijing.maas.aliyuncs.com/api/v1/tasks/task-1');
  assert.equal(calls.length, 2);
});

test('Beijing shared endpoint needs no workspace and keeps async accounting gate', async () => {
  const calls=[];
  const fetchImpl=async (url,options)=>{calls.push({url,options});return calls.length===1?fakeResponse({output:{task_id:'task-1',task_status:'PENDING'}}):fakeResponse({output:{task_id:'task-1',task_status:'RUNNING'}});};
  const p=createWan3Transport({key:'test-key',fetchImpl,chargeGate:{run:async (_r, f)=>f()}});
  await p.submit(spec,'request-1');await p.query('task-1');
  assert.equal(calls[0].url,'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(calls[1].url,'https://dashscope.aliyuncs.com/api/v1/tasks/task-1');
  assert.throws(()=>createWan3Transport({key:'test-key',workspace:'evil.example'}),{code:'WAN3_INVALID_INPUT'});
});

test('submission network interruption is uncertain and never retried by transport', async () => {
  let calls = 0;
  const p = createWan3Transport({key:'test-key', workspace:'my-space', fetchImpl:async () => {calls++; throw new Error('interrupted');}, chargeGate:{run:async (_r, f) => f()}});
  await assert.rejects(() => p.submit(spec, 'request-1'), {code:'WAN3_SUBMISSION_UNCERTAIN', retryBlocked:true});
  assert.equal(calls, 1);
});

test('audio upload uses model-scoped policy, sends file last and returns OSS URL', async () => {
  const calls=[];
  const p={upload_host:'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/account/folder',policy:'policy',signature:'signature',oss_access_key_id:'test',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'};
  const fetchImpl=async (url, options) => {calls.push({url,options}); return calls.length===1?fakeResponse({data:p}):new Response('',{status:200});};
  const result=await uploadWan3Audio({key:'test-key',workspace:'my-space',bytes:Buffer.from('hello'),mime:'audio/wav',duration:5,fetchImpl});
  assert.match(result.url,/^oss:\/\/dashscope-instant\/account\/folder\/.+\.wav$/);
  assert.match(calls[0].url,/model=wan3.0-video/);
  assert.equal([...calls[1].options.body.keys()].at(-1),'file');
  assert.equal(calls.length,2);
});

test('rejects untrusted upload host before audio bytes leave the process', async () => {
  let calls=0;
  const fetchImpl=async () => {calls++;return fakeResponse({data:{upload_host:'https://attacker.invalid'}});};
  await assert.rejects(() => uploadWan3Audio({key:'test-key',workspace:'my-space',bytes:Buffer.from('a'),mime:'audio/wav',duration:5,fetchImpl}), /上传凭证格式无效/);
  assert.equal(calls,1);
});
