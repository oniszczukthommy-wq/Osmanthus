import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedance25Client, seedance25Request} from '../seedance25-client.mjs';

const png = 'data:image/png;base64,' + Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
const input = {prompt:'镜头跟随主角走过雨夜', imageDataUri:png, duration:5};
const reply = (body, status=200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json'}});

test('first-frame request uses official 2.5 model and adaptive aspect ratio', () => {
  const value = seedance25Request(input);
  assert.equal(value.model,'doubao-seedance-2-5-260628');
  assert.equal(value.ratio,'adaptive');
  assert.equal(value.generate_audio,false);
  assert.equal(value.duration,5);
  assert.deepEqual(value.content[1],{type:'image_url',image_url:{url:png},role:'first_frame'});
  assert.throws(()=>seedance25Request({...input,duration:3}),/4 至 30/);
  assert.throws(()=>seedance25Request({...input,imageDataUri:'https://example.com/1.png'}),/PNG/);
  assert.throws(()=>seedance25Request({...input,imageDataUri:'data:image/jpeg;base64,'+Buffer.from('not-image').toString('base64')}),/格式不匹配/);
});

test('submission is one authenticated request and poll never submits', async () => {
  const calls = [], mock = async (url,options) => {
    calls.push({url,options});
    return options.method === 'POST' ? reply({id:'cgt-20261111-test'}) : reply({id:'cgt-20261111-test',status:'succeeded',content:{video_url:'https://video.volces.com/result.mp4?signature=private'}});
  };
  const api = createSeedance25Client({key:'secret-test-key',fetchImpl:mock});
  assert.deepEqual(await api.submit(input),{providerTaskId:'cgt-20261111-test',status:'queued'});
  const output = await api.query('cgt-20261111-test');
  assert.equal(output.status,'succeeded');
  assert.equal(output.outputUrl,'https://video.volces.com/result.mp4?signature=private');
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,'Bearer secret-test-key');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(JSON.parse(calls[0].options.body).content[1].role,'first_frame');
  assert.equal(calls[1].options.method,'GET');
});

test('an interrupted or failed POST is uncertain and cannot be silently retried', async () => {
  let calls=0;
  const api=createSeedance25Client({key:'secret-test-key',fetchImpl:async()=>{calls++;throw Error('secret-test-key');}});
  await assert.rejects(api.submit(input), e=>e.code==='SEEDANCE_SUBMISSION_UNCERTAIN' && e.retryBlocked && !e.message.includes('secret-test-key'));
  assert.equal(calls,1);
  const http=createSeedance25Client({key:'secret-test-key',fetchImpl:async()=>reply({error:{message:'secret-test-key'}},500)});
  await assert.rejects(http.submit(input), e=>e.retryBlocked && !e.message.includes('secret-test-key'));
});

test('rejects dangerous output URLs and malformed tasks without issuing requests', async () => {
  let calls=0;
  const api=createSeedance25Client({key:'test',fetchImpl:async()=>{calls++;return reply({id:'cgt-1',status:'succeeded',content:{video_url:'http://127.0.0.1/admin'}});}});
  await assert.rejects(api.query('../secret'),e=>e.code==='SEEDANCE_INVALID_TASK');
  assert.equal(calls,0);
  await assert.rejects(api.query('cgt-1'),e=>e.code==='SEEDANCE_OUTPUT_INVALID');
});

test('configuration and polling never imply that generation was verified', async () => {
  let calls=0;
  const unconfigured=createSeedance25Client({fetchImpl:async()=>{calls++;}});
  assert.equal(unconfigured.capabilities().configured,false);
  await assert.rejects(unconfigured.submit(input),e=>e.code==='SEEDANCE_NOT_CONFIGURED');
  assert.equal(calls,0);
  const api=createSeedance25Client({key:'test',fetchImpl:async()=>reply({id:'cgt-1',status:'running'})});
  assert.deepEqual(await api.query('cgt-1'),{providerTaskId:'cgt-1',status:'running'});
});
