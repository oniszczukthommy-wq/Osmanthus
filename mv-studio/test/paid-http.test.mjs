import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {makeProject} from '../public/domain.js';

test('real HTTP routes deduplicate planning, validate local source and share a durable text limit',async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-paid-http-'));
  const before={...process.env},nativeFetch=globalThis.fetch;
  Object.assign(process.env,{MV_DATA_DIR:data,MV_DISABLE_MODELS:'0',DEEPSEEK_API_KEY:'offline-fake-key',DASHSCOPE_API_KEY:'',MV_TEXT_DAILY_LIMIT:'1',MV_TEXT_TOTAL_LIMIT:'3',MV_TEXT_RATE_PER_MINUTE:'8',MV_TEXT_MAX_CONCURRENT:'2'});
  let calls=0,release,started;
  const reached=new Promise(r=>started=r);
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');calls++;started();
    await new Promise(r=>release=r);
    const input=JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'保留原歌曲和镜头结构',shots:input.shots.map(({id})=>({id,caption:'夜晚归途',camera:'wide',warm:.5}))})}}]}));
  };
  const {createServer}=await import('../server.mjs');globalThis.fetch=nativeFetch;
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);fs.rmSync(data,{recursive:true,force:true});});
  const post=async(route,body)=>{const response=await nativeFetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  const project=makeProject(),id=crypto.randomUUID()+'.wav';
  project.source={...project.source,id,url:'/files/uploads/'+id};
  assert((await post('/api/plan',{project})).status>=400);assert.equal(calls,0);
  const sample=path.resolve(import.meta.dirname,'../public/assets/sample-song.mp3');
  if(!fs.existsSync(sample)){assert((await post('/api/plan',{project:makeProject()})).status>=400);assert.equal(calls,0);}
  // An isolated, valid PCM source; no model, sample library or user song is used.
  const pcm=Buffer.alloc(44+16000*4*2);pcm.write('RIFF');pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(16000,24);pcm.writeUInt32LE(32000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);fs.writeFileSync(path.join(data,'uploads',id),pcm);
  const a=post('/api/plan',{project});await reached;const b=post('/api/plan',{project});release();
  const results=await Promise.all([a,b]);assert(results.every(r=>r.status===200),JSON.stringify(results));assert.deepEqual(results[0].body,results[1].body);assert.equal(calls,1);
  assert.equal((await post('/api/plan',{project})).status,200);assert.equal(calls,1);
  assert.equal((await post('/api/plan',{project:{...project,title:'不同方案'}})).status,429);assert.equal(calls,1);
  // A separate feature must use the same exhausted ledger, not its own cap.
  const assistant=await post('/api/canvas-assist',{request_id:crypto.randomUUID(),mode:'prompt',instruction:'整理雨夜站台的创意'});
  assert(assistant.status>=400,JSON.stringify(assistant));assert.equal(calls,1);
  assert.equal(fs.readdirSync(path.join(data,'text-usage','total')).length,1);
});
