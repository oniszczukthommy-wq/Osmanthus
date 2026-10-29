import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';
import {createMusicBridge} from '../music-bridge.mjs';import {makeProject} from '../public/domain.js';
test('music handoff preserves version, verifies source, resumes edits and rejects changed audio',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'osmanthus-music-bridge-'));fs.mkdirSync(path.join(data,'uploads'));const bytes=Buffer.from('test source'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),id='10000000-0000-4000-8000-000000000001',project_id='20000000-0000-4000-8000-000000000002';
 let calls=0;const versions=[],old=makeProject();fs.writeFileSync(path.join(data,'project.json'),JSON.stringify(old));
 const server=http.createServer((req,res)=>{calls++;if(req.url.endsWith('/audio.mp3')){res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id,project_id,title:'带入的歌曲',revision:7,fingerprint:'a'.repeat(64),source_kind:'current_mix',audio_sha256:sha,audio_bytes:bytes.length,audio_url:`/api/mv/handoffs/${id}/audio.mp3`,lyrics:'第一句歌词',timed_lyrics:[{start:1,end:2,text:'第一句歌词'}]}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const bridge=createMusicBridge({data,musicBase:`http://127.0.0.1:${server.address().port}`,probe:()=>({format:{duration:'60'},streams:[{codec_type:'audio'}]}),waveform:()=>[.2,.4],write:(file,v)=>fs.writeFileSync(file,JSON.stringify(v)),version:(p,label)=>versions.push({project:p,label})});
 try{
  await assert.rejects(()=>bridge.importMusic('../invalid'),/标识/);assert.equal(calls,0);
  const [a,b]=await Promise.all([bridge.importMusic(id),bridge.importMusic(id)]);assert.equal(a.project.id,b.project.id);assert.equal(calls,2);assert.equal(versions.length,1);assert.deepEqual(versions[0].project,old);
  assert.equal(a.project.title,'带入的歌曲');assert.equal(a.project.duration,30);assert.equal(a.project.manualLyrics,'第一句歌词');assert.equal(a.project.musicHandoff.revision,7);assert.equal(a.project.lyrics.length,1);assert.equal(a.project.generated,null);
  a.project.title='用户已修改的MV';bridge.persist(a.project);const resumed=await bridge.importMusic(id);assert.equal(resumed.project.title,'用户已修改的MV');assert.equal(calls,2);assert.equal(versions.length,1);
  fs.writeFileSync(path.join(data,'uploads',a.project.source.id),'corrupt');await assert.rejects(()=>bridge.importMusic(id),/校验失败/);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(data,{recursive:true,force:true});}
});
test('mounted resource URLs keep media in /mv and music navigation in root',async()=>{
 const old=globalThis.location;globalThis.location={pathname:'/mv/',origin:'http://127.0.0.1:8615'};
 try{const {localUrl,musicUrl}=await import('../public/integration.js?integration-test');assert.equal(localUrl('/api/project'),'/mv/api/project');assert.equal(localUrl('/mv/files/a.mp4'),'/mv/files/a.mp4');assert.equal(localUrl('https://example.org/a'),'https://example.org/a');assert.equal(new URL(musicUrl({song:'abc'})).pathname,'/');assert.equal(new URL(musicUrl()).port,'8615');}finally{if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});
