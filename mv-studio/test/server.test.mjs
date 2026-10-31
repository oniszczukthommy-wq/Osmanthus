import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {makeProject,resizePlan} from '../public/domain.js';
test('真实上传、持久化、任务取消、完整帧检查、MP4编码与下载',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mv-demo-test-'));process.env.MV_DATA_DIR=temp;process.env.MV_DISABLE_MODELS='1';const {createServer}=await import('../server.mjs');const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(p,data,method='POST')=>{const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:r.status,data:await r.json()}};
 try{
  const cap=(await req('/api/capabilities',undefined,'GET')).data;assert.equal(cap.deepseek,false);assert.equal(cap.comfy.available,false);assert.equal(cap.freeRender,true);assert.equal((await req('/api/import-link',{url:'https://music.example/song'})).status,501);assert.equal((await req('/api/plan',{project:makeProject()})).status,503);
  const sr=16000,count=sr*3.2,b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)b.writeInt16LE(Math.sin(i/sr*Math.PI*440*2)*6000,44+i*2);
  let r=await fetch(base+'/api/upload',{method:'POST',headers:{'x-filename':'test.wav'},body:b});assert.equal(r.status,201);const upload=await r.json();assert(upload.source.duration>=3);assert.equal(upload.waveform.length,100);
  const range=await fetch(base+upload.source.url,{headers:{Range:'bytes=0-31'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,32);
  let p=resizePlan(makeProject(),3,0);p.source=upload.source;p.lyrics=[];const saved=await req('/api/project',p,'PUT');assert.equal(saved.status,200);p=saved.data.project;assert.equal((await req('/api/project',undefined,'GET')).data.project.source.id,upload.source.id);
  const first=(await req('/api/render',{project:p})).data;assert.equal(first.total,72);assert.equal((await req('/api/render',{project:p})).status,409);assert.equal((await req(`/api/jobs/${first.id}/cancel`,{})).data.status,'cancelled');
  const ff=mediaTools().ffmpeg,image=path.join(temp,'frame.jpg');execFileSync(ff,['-y','-v','error','-f','lavfi','-i','color=c=0x263e4f:s=1280x720','-frames:v','1',image]);const jpg=fs.readFileSync(image);
  const second=(await req('/api/render',{project:p})).data;assert.equal((await req(`/api/jobs/${second.id}/finish`,{})).status,409);
  for(let i=0;i<72;i++){r=await fetch(base+`/api/jobs/${second.id}/frame?index=${i}`,{method:'POST',body:jpg});assert.equal(r.status,200);await r.json();}
  const duplicate=await fetch(base+`/api/jobs/${second.id}/frame?index=0`,{method:'POST',body:jpg});assert.equal((await duplicate.json()).received,72);
  const conflict=await fetch(base+`/api/jobs/${second.id}/frame?index=0`,{method:'POST',body:Buffer.concat([jpg,Buffer.from([1])])});assert.equal(conflict.status,409);await conflict.json();assert.equal((await req(`/api/jobs/${second.id}/finish`,{})).status,202);
  let status;for(let i=0;i<100;i++){status=(await req(`/api/jobs/${second.id}`,undefined,'GET')).data;if(['ready','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,100));}assert.equal(status.status,'ready',status.error);assert(status.url.endsWith('/mv.mp4'));
  const file=path.join(temp,'jobs',second.id,'mv.mp4');execFileSync(ff,['-v','error','-i',file,'-f','null','-']);const info=JSON.parse(fs.readFileSync(path.join(temp,'jobs',second.id,'ffprobe.json')));assert.equal(Number(info.streams.find(s=>s.codec_type==='video').nb_frames),72);assert(info.streams.some(s=>s.codec_type==='audio'));
  const versions=(await req('/api/versions',undefined,'GET')).data.versions;assert(versions.some(v=>v.output));assert.equal((await fetch(base+status.url)).status,200);
  console.log('72真实编码帧、3秒有声MP4、范围下载和版本持久化通过；无模型请求。');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});
