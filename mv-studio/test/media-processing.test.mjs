import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMediaProcessing} from '../media-processing.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=t=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'media-pool-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const file=path.join(data,'source.wav');fs.writeFileSync(file,'isolated media');return{data,file};};
test('bounded process queue deduplicates a file, rejects excess and releases failed work',async t=>{
 const {data,file}=fixture(t),second=path.join(data,'second.wav'),third=path.join(data,'third.wav');fs.writeFileSync(second,'second');fs.writeFileSync(third,'third');let release,calls=0;
 const pool=createMediaProcessing({ffmpeg:'mock',ffprobe:'mock',environment:{MV_MEDIA_CONCURRENCY:1,MV_MEDIA_QUEUE_LIMIT:1},run:async()=>{calls++;if(calls===1)await new Promise(r=>release=r);if(calls===2)throw Error('tool failed');return '{}';}});
 const a=pool.probe(file),same=pool.probe(file);await wait(0);const b=pool.probe(second);const rejected=assert.rejects(b,/tool failed/);
 await assert.rejects(pool.probe(third),e=>e.code==='MEDIA_BUSY');assert.deepEqual(pool.status(),{active:1,queued:1,uploads:0,concurrent:1,waiting:1});release();assert.deepEqual(await a,await same);await rejected;
 await pool.probe(third);assert.equal(calls,3);await pool.probe(file);assert.equal(calls,3);fs.writeFileSync(file,'changed');await pool.probe(file);assert.equal(calls,4);
});
test('actual HTTP capability and project reads remain responsive while an upload probe is waiting',async t=>{
 const {data}=fixture(t);process.env.MV_DATA_DIR=data;process.env.MV_DISABLE_MODELS='1';
 let release,reached;const ready=new Promise(r=>reached=r);
 const media=createMediaProcessing({ffmpeg:'mock-ff',ffprobe:'mock-fp',environment:{MV_MEDIA_CONCURRENCY:1,MV_MEDIA_QUEUE_LIMIT:0},run:async tool=>{
  if(tool==='mock-fp'){reached();await new Promise(r=>release=r);return JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:'4'}});}return Buffer.alloc(400*4);
 }});
 const {createServer}=await import('../server.mjs'),server=createServer({media});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const upload=fetch(base+'/api/upload',{method:'POST',headers:{'x-filename':'test.wav'},body:Buffer.from('isolated mocked probe')});await ready;
 let state;try{
  state=await Promise.race([Promise.all([fetch(base+'/api/capabilities'),fetch(base+'/api/project')]),wait(1000).then(()=>{throw Error('other HTTP routes blocked by media processing');})]);
  assert(state.every(r=>r.status===200));await Promise.all(state.map(r=>r.json()));
  const crowded=await fetch(base+'/api/upload',{method:'POST',headers:{'x-filename':'second.wav'},body:Buffer.from('not admitted')});assert.equal(crowded.status,503);await crowded.json();
 }finally{release();}
 const result=await upload;assert.equal(result.status,201);const body=await result.json();assert.equal(body.source.duration,4);assert.equal(body.waveform.length,100);
});
