import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {checkedSelection,newMvProject,selectedAudioPath} from '../public/tunee-create-domain.js';
import {mediaTools} from '../runtime-config.mjs';

test('选段和本机音频地址严格验证，新项目保留歌曲与歌词',()=>{
 const id=crypto.randomUUID(),source={id:id+'.wav',url:'/mv/files/uploads/'+id+'.wav',name:'test.wav',duration:90};
 const lyric=[{start:8,end:9,text:'测试'}],old=JSON.stringify({source,lyric});
 const p=newMvProject({source,start:7,end:22,title:'测试',lyrics:'测试',timedLyrics:lyric},crypto.randomUUID());
 assert.equal(p.start,7);assert.equal(p.duration,15);assert.equal(p.source.url,'/files/uploads/'+id+'.wav');assert.equal(p.manualLyrics,'测试');assert.deepEqual(p.lyrics,lyric);assert.equal(JSON.stringify({source,lyric}),old);
 for(const args of [[0,2,90],[-1,10,90],[0,91,90],[0,181,400],['',15,90]])assert.throws(()=>checkedSelection(...args));
 assert.equal(selectedAudioPath({url:'https://evil.example/sound.mp3'}),'');
});

test('上传音乐、新建独立工程和选段在会话与刷新后保留（无模型调用）',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mv-entry-'));const sound=path.join(tmp,'demo.wav');
 execFileSync(mediaTools().ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=330:duration=35','-ac','1',sound],{timeout:30000});
 process.env.MV_DATA_DIR=path.join(tmp,'data');process.env.MV_DISABLE_MODELS='1';delete process.env.MV_ENV_FILE;
 const {createServer}=await import('../server.mjs');const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
 try{
  const result=await fetch(base+'/api/upload',{method:'POST',headers:{'x-filename':'demo.wav'},body:fs.readFileSync(sound)});assert.equal(result.status,201);const {source}=await result.json();
  const original=newMvProject({source,start:0,end:15,title:'原工程',lyrics:'原歌词',timedLyrics:[{start:1,end:3,text:'原歌词'}]},crypto.randomUUID());
  await req('/api/canvas-projects',{project:original});
  const copy=newMvProject({source:original.source,start:17,end:32,title:'独立 MV',lyrics:original.manualLyrics,timedLyrics:original.lyrics},crypto.randomUUID());
  const saved=await req('/api/canvas-projects',{project:copy});assert.notEqual(saved.project.id,original.id);
  const {session}=await req('/api/mv-director/open',{project_id:saved.project.id});assert.equal(session.range.start,17);assert.equal(session.range.end,32);assert.equal(session.manualLyrics,'原歌词');assert.deepEqual(session.lyrics,original.lyrics);
  const reopened=await req('/api/mv-director/'+session.id);assert.equal(reopened.session.range.start,17);assert.equal(reopened.session.range.end,32);
  const old=await req('/api/canvas-projects/'+original.id);assert.equal(old.project.title,'原工程');assert.equal(old.project.start,0);assert.equal(old.project.manualLyrics,'原歌词');assert.deepEqual(old.project.lyrics,original.lyrics);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
});
