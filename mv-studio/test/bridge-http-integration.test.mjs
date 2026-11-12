import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mediaTools} from '../runtime-config.mjs';

test('HTTP 手工镜头导入、版本选择、原歌合成与下载（所有模型禁用）',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guihua-http-bridge-'));
 const resolved=path.resolve(temp),baseTemp=path.resolve(os.tmpdir())+path.sep;
 assert(resolved.startsWith(baseTemp),'fixture 目录必须位于指定临时工作区');
 const fixture=path.join(resolved,'fixture');
 execFileSync(process.execPath,[path.join(process.cwd(),'test','bridge-fixture-20261111.mjs')],{env:{...process.env,BRIDGE_FIXTURE_ROOT:fixture},timeout:30000});
 const meta=JSON.parse(fs.readFileSync(path.join(fixture,'fixture.json'),'utf8'));
 const ff=mediaTools().ffmpeg;
 const files=[];
 for(const [color,duration] of [['red','11'],['blue','11'],['black','2']]){
  const f=path.join(resolved,color+'.mp4');
  execFileSync(ff,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=24`,'-t',duration,'-c:v','libx264','-pix_fmt','yuv420p',f],{timeout:30000});files.push(f);
 }
 process.env.MV_DATA_DIR=path.join(fixture,'data');process.env.MV_DISABLE_MODELS='1';
 const nativeFetch=globalThis.fetch;
 globalThis.fetch=(input,options)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.ok(['127.0.0.1','localhost'].includes(u.hostname),'测试不能访问外部模型');return nativeFetch(input,options);};
 const {createServer}=await import('../server.mjs');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const json=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+route,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});let value=await r.json();return{status:r.status,value};};
 async function upload(file){const r=await fetch(base+'/api/materials',{method:'POST',headers:{'x-filename':path.basename(file)},body:fs.readFileSync(file)});assert.equal(r.status,201);return (await r.json()).material;}
 try{
  const cap=await json('/api/capabilities');assert.equal(cap.value.mvDirectorImportShots,true);assert.equal(cap.value.deepseek,false);
  const front=await fetch(base+'/tunee-workspace.html');assert.equal(front.status,200);
  let result=await json('/api/mv-director/'+meta.sessionId);assert.equal(result.status,200);let s=result.value.session;assert.equal(s.productionMode,'manual-web');assert.equal(s.plan.shots.length,1);
  const shot=s.plan.shots[0],red=await upload(files[0]),blue=await upload(files[1]),short=await upload(files[2]);
  const route=`/api/mv-director/${s.id}/import-shot`;
  let imported=await json(route,{revision:s.revision,shot_id:shot.id,material_id:short.id});assert.notEqual(imported.status,200,'不允许短于镜头的视频');
  imported=await json(route,{revision:s.revision,shot_id:shot.id,material_id:red.id});assert.equal(imported.status,200,JSON.stringify(imported.value));s=imported.value.session;const version1=s.importedShots[shot.id].selected;assert.equal(s.importedShots[shot.id].valid,true);
  imported=await json(route,{revision:s.revision,shot_id:shot.id,material_id:blue.id});assert.equal(imported.status,200,JSON.stringify(imported.value));s=imported.value.session;assert.equal(s.importedShots[shot.id].versions.length,2);
  const stale=await json(`/api/mv-director/${s.id}/select-import`,{revision:s.revision-1,shot_id:shot.id,version_id:version1});assert.equal(stale.status,409);
  const selected=await json(`/api/mv-director/${s.id}/select-import`,{revision:s.revision,shot_id:shot.id,version_id:version1});assert.equal(selected.status,200,JSON.stringify(selected.value));s=selected.value.session;assert.equal(s.importedShots[shot.id].selected,version1);
  const started=await json('/api/mv-director/jobs',{session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'compose-imports',input:{confirmed:true,subtitles:false}});assert.equal(started.status,202,JSON.stringify(started.value));
  let job=started.value.job;for(let i=0;i<200&&!['ready','failed','uncertain'].includes(job.status);i++){await new Promise(r=>setTimeout(r,100));job=(await json('/api/mv-director/jobs/'+job.id)).value.job;}
  assert.equal(job.status,'ready',job.message);assert(job.output?.url);
  const download=await fetch(base+job.output.url);assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert(bytes.length>1000);
  const file=path.join(resolved,'actual.mp4');fs.writeFileSync(file,bytes);const info=JSON.parse(execFileSync(mediaTools().ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));assert(info.streams.some(x=>x.codec_type==='video'));assert(info.streams.some(x=>x.codec_type==='audio'));assert(Math.abs(Number(info.format.duration)-10)<.2);
  // Asset candidates must be confirmed before shot previews; replacing a
  // character invalidates dependent media while preserving prior MP4s.
  s=(await json('/api/mv-director/'+s.id)).value.session;
  assert.equal((await json(`/api/mv-director/${s.id}/quote?kind=shots-preview`)).status,409);
  const confirmed=await json(`/api/mv-director/${s.id}/assets-confirm`,{revision:s.revision});assert.equal(confirmed.status,200,JSON.stringify(confirmed.value));s=confirmed.value.session;
  assert(Object.values(s.assetVersions).every(x=>x.confirmed===true));
  assert.equal((await json(`/api/mv-director/${s.id}/quote?kind=shots-preview`)).status,200);
  const entityId=s.plan.characters[0].id,oldCandidate=s.assetVersions[entityId].selected;
  const img=path.join(resolved,'candidate.png');execFileSync(ff,['-v','error','-y','-f','lavfi','-i','color=c=yellow:s=512x512','-frames:v','1',img],{timeout:30000});
  const candidate=await upload(img);
  const added=await json(`/api/mv-director/${s.id}/asset-candidates`,{revision:s.revision,entity_id:entityId,material_id:candidate.id});assert.equal(added.status,200,JSON.stringify(added.value));s=added.value.session;
  assert.equal(s.assetVersions[entityId].confirmed,false);assert(s.assetVersions[entityId].versions.length>=2);assert.equal(s.importedShots[shot.id].valid,false);assert.equal(s.generated,null);assert.equal((await fetch(base+job.output.url)).status,200,'更换角色素材应保留旧成片');
  assert.equal((await json(`/api/mv-director/${s.id}/quote?kind=shots-preview`)).status,409,'更换候选后必须重新确认');
  const old=await json(`/api/mv-director/${s.id}/asset-select`,{revision:s.revision,entity_id:entityId,version_id:oldCandidate});assert.equal(old.status,200,JSON.stringify(old.value));s=old.value.session;assert.equal(s.assetVersions[entityId].selected,oldCandidate);
  const reconfirm=await json(`/api/mv-director/${s.id}/assets-confirm`,{revision:s.revision});assert.equal(reconfirm.status,200,JSON.stringify(reconfirm.value));s=reconfirm.value.session;
  // Visual edits preserve the authoritative timeline and invalidate only the
  // affected imported shot. Existing finished downloads remain accessible.
  s=(await json('/api/mv-director/'+s.id)).value.session;
  const editPath=`/api/mv-director/${s.id}/edit-script`;
  const rows=s.plan.shots.map(x=>({id:x.id,description:x.description,sceneId:x.sceneId,characterIds:x.characterIds,musicStructure:'主歌'}));
  const bad=await json(editPath,{revision:s.revision,shots:rows.map(x=>({...x,start:999}))});assert.equal(bad.status,400,'不得通过脚本编辑接口篡改歌曲时间');
  const staleEdit=await json(editPath,{revision:s.revision-1,shots:rows});assert.equal(staleEdit.status,409);
  rows[0].description='在海边停下，镜头缓缓靠近';
  const edited=await json(editPath,{revision:s.revision,shots:rows});assert.equal(edited.status,200,JSON.stringify(edited.value));
  const previousRevision=s.revision;s=edited.value.session;assert.equal(s.revision,previousRevision+1);assert.equal(s.plan.shots[0].description,rows[0].description);assert.equal(s.plan.shots[0].musicStructure,'主歌');assert.equal(s.plan.shots[0].start,shot.start);assert.equal(s.importedShots[shot.id].valid,false);assert.equal(s.generated,null);assert.equal((await fetch(base+job.output.url)).status,200,'原成片始终保留');
  const noOldClip=await json('/api/mv-director/jobs',{session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'compose-imports',input:{confirmed:true,subtitles:false}});assert.notEqual(noOldClip.status,202,'修改脚本后不得使用过期镜头合成');assert.match(noOldClip.value.error,/镜头/);
  const changed=await json(`/api/mv-director/${s.id}/lyrics`,{lines:[{start:1,end:4,text:'更新后的歌词'}]});assert.equal(changed.status,200,JSON.stringify(changed.value));s=changed.value.session;assert.equal(s.planStale,true);assert.equal(s.generated,null);assert.equal((await fetch(base+job.output.url)).status,200,'更新歌词仍保留旧成片');
  const blocked=await json(editPath,{revision:s.revision,shots:rows});assert.equal(blocked.status,409,'歌词改变后必须重新规划，不能编辑过期方案');
 }finally{await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;fs.rmSync(resolved,{recursive:true,force:true});}
});
