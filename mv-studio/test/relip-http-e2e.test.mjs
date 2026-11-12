import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mediaTools} from '../runtime-config.mjs';

test('HTTP 二次口型报价、保留原版、选择新版与合成只通过模拟提供商',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mv-relip-http-'));
  const baseTemp=path.resolve(os.tmpdir())+path.sep;
  assert(path.resolve(root).startsWith(baseTemp));
  const fixture=path.join(root,'fixture');
  execFileSync(process.execPath,[path.join(process.cwd(),'test','bridge-fixture-20261111.mjs')],{env:{...process.env,BRIDGE_FIXTURE_ROOT:fixture},timeout:30000});
  const meta=JSON.parse(fs.readFileSync(path.join(fixture,'fixture.json'),'utf8'));
  const tools=mediaTools(),original=path.join(root,'original.mp4'),output=path.join(root,'output.mp4');
  for(const [file,color] of [[original,'red'],[output,'blue']])execFileSync(tools.ffmpeg,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x240:r=24`,'-t','10','-c:v','libx264','-pix_fmt','yuv420p',file],{timeout:30000});
  const resultBytes=fs.readFileSync(output),realFetch=globalThis.fetch;
  let paidPosts=0,uploads=0,submittedBody;
  const jsonResponse=x=>new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(input,opts={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(['127.0.0.1','localhost'].includes(url.hostname))return realFetch(input,opts);
    if(url.hostname==='dashscope.aliyuncs.com'&&url.pathname==='/api/v1/uploads')return jsonResponse({data:{upload_host:'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/account/folder',policy:'p',signature:'s',oss_access_key_id:'k',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});
    if(url.hostname==='dashscope-file-test.oss-cn-beijing.aliyuncs.com'){uploads++;return new Response('',{status:200});}
    if(url.hostname==='dashscope.aliyuncs.com'&&url.pathname==='/api/v1/services/aigc/video-generation/video-synthesis'){
      paidPosts++;submittedBody=JSON.parse(opts.body);return jsonResponse({output:{task_id:'mock-task-1',task_status:'PENDING'}});
    }
    if(url.hostname==='dashscope.aliyuncs.com'&&url.pathname==='/api/v1/tasks/mock-task-1')return jsonResponse({output:{task_id:'mock-task-1',task_status:'SUCCEEDED',video_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/mock.mp4'}});
    if(url.hostname==='dashscope-result-bj.oss-cn-beijing.aliyuncs.com')return new Response(resultBytes,{status:200,headers:{'content-length':String(resultBytes.length)}});
    throw Error('隔离测试拒绝访问其他网络地址');
  };
  process.env.MV_DATA_DIR=path.join(fixture,'data');
  process.env.MV_ENABLE_WAN3='1';process.env.WAN3_BUDGET_CNY='20';process.env.DASHSCOPE_API_KEY='test-only';
  delete process.env.MV_DISABLE_MODELS;
  const {createServer}=await import('../server.mjs');
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const req=async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
  try{
    assert.equal((await req('/api/capabilities')).value.mvDirectorRelip,true);
    assert.equal((await fetch(base+'/tunee-workspace.html')).status,200);
    assert.equal((await fetch(base+'/tunee-shot-editor.js')).status,200);
    let s=(await req('/api/mv-director/'+meta.sessionId)).value.session;
    const shot=s.plan.shots[0],upload=await fetch(base+'/api/materials',{method:'POST',headers:{'x-filename':'original.mp4'},body:fs.readFileSync(original)});
    assert.equal(upload.status,201);const material=(await upload.json()).material;
    const imported=await req(`/api/mv-director/${s.id}/import-shot`,{revision:s.revision,shot_id:shot.id,material_id:material.id});
    assert.equal(imported.status,200,JSON.stringify(imported.value));s=imported.value.session;
    const prior=s.importedShots[shot.id].selected,priorRevision=s.revision;
    const quote=await req(`/api/mv-director/${s.id}/relip-quote?shot_id=${shot.id}`);
    assert.equal(quote.status,200,JSON.stringify(quote.value));assert.equal(quote.value.estimate.canSubmit,true);
    assert.equal(paidPosts,0,'报价必须只读且不调用模型');assert.equal(uploads,0);
    assert.equal((await req('/api/mv-director/'+s.id)).value.session.revision,priorRevision);
    const input={revision:s.revision,request_id:crypto.randomUUID(),shot_id:shot.id,confirmed:true,confirmed_max_cost_cny:quote.value.estimate.estimatedCostCny};
    const missing=await req(`/api/mv-director/${s.id}/relip`,{...input,request_id:crypto.randomUUID(),confirmed:false});assert.notEqual(missing.status,202);
    const cheap=await req(`/api/mv-director/${s.id}/relip`,{...input,request_id:crypto.randomUUID(),confirmed_max_cost_cny:.01});assert.notEqual(cheap.status,202);assert.equal(paidPosts,0);
    const started=await req(`/api/mv-director/${s.id}/relip`,input);assert.equal(started.status,202,JSON.stringify(started.value));
    const replay=await req(`/api/mv-director/${s.id}/relip`,input);assert.equal(replay.status,202);assert.equal(replay.value.job.id,started.value.job.id);
    let job=started.value.job;for(let i=0;i<200&&!['ready','failed','uncertain'].includes(job.status);i++){await new Promise(r=>setTimeout(r,100));job=(await req('/api/mv-director/jobs/'+job.id)).value.job;}
    assert.equal(job.status,'ready',job.message);assert.equal(paidPosts,1);assert.equal(uploads,2);
    assert.deepEqual(submittedBody.input.media.map(x=>x.type),['reference_video','reference_audio']);
    s=(await req('/api/mv-director/'+s.id)).value.session;assert.equal(s.importedShots[shot.id].selected,prior,'原镜头继续选中');assert.equal(s.importedShots[shot.id].versions.length,2);
    const selected=await req(`/api/mv-director/${s.id}/select-import`,{revision:s.revision,shot_id:shot.id,version_id:job.output.version_id});assert.equal(selected.status,200,JSON.stringify(selected.value));s=selected.value.session;
    const compose=await req('/api/mv-director/jobs',{session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'compose-imports',input:{confirmed:true,subtitles:false}});assert.equal(compose.status,202,JSON.stringify(compose.value));
    let final=compose.value.job;for(let i=0;i<200&&!['ready','failed','uncertain'].includes(final.status);i++){await new Promise(r=>setTimeout(r,100));final=(await req('/api/mv-director/jobs/'+final.id)).value.job;}
    assert.equal(final.status,'ready',final.message);const download=await fetch(base+final.output.url);assert.equal(download.status,200);
    const mp4=path.join(root,'final.mp4');fs.writeFileSync(mp4,Buffer.from(await download.arrayBuffer()));const info=JSON.parse(execFileSync(tools.ffprobe,['-v','error','-show_streams','-of','json',mp4],{encoding:'utf8'}));assert(info.streams.some(x=>x.codec_type==='audio'));assert(info.streams.some(x=>x.codec_type==='video'));
    s=(await req('/api/mv-director/'+s.id)).value.session;
    const rows=s.plan.shots.map(x=>({id:x.id,description:x.description+' 修改',sceneId:x.sceneId,characterIds:x.characterIds}));
    const edit=await req(`/api/mv-director/${s.id}/edit-script`,{revision:s.revision,shots:rows});assert.equal(edit.status,200);s=edit.value.session;assert.equal(s.importedShots[shot.id].valid,false);
    const blocked=await req(`/api/mv-director/${s.id}/relip-quote?shot_id=${shot.id}`);assert.notEqual(blocked.status,200,'修改分镜后旧镜头不能继续口型');
    assert.equal((await fetch(base+final.output.url)).status,200,'原先成片保留');
  } finally {await new Promise(r=>server.close(r));globalThis.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true});}
});
