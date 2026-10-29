import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAIMVWorkflow,editableMVPlan} from '../ai-mv-workflow.mjs';

const ff=mediaTools().ffmpeg,fp=mediaTools().ffprobe;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const encode=args=>execFileSync(ff,['-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],timeout:30000});
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',timeout:10000}));
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ai-mv-chain-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 fs.mkdirSync(path.join(data,'jobs'));const audio=path.join(data,'audio.wav');encode(['-f','lavfi','-i','sine=frequency=330:sample_rate=16000','-t','10',audio]);
 const project={id:crypto.randomUUID(),source:{id:crypto.randomUUID()+'.wav',duration:10}};
 const plan={id:crypto.randomUUID(),project_id:project.id,source_sha256:sha(fs.readFileSync(audio)),source_duration:10,start:0,duration:5,ratio:'16:9',summary:'验证分镜',visualBible:'原创场景',shots:[{id:crypto.randomUUID(),label:'清晨',prompt:'太阳从海面升起，缓慢推镜',start:0,end:5,duration:5}]};
 const planner={get:id=>id===plan.id?copy(plan):null};
 return {data,audio,project,plan,planner};
}
test('分镜和原曲SHA绑定：换歌、越界或变造镜头结构在付费提交前拒绝',async t=>{
 const f=fixture(t);let calls=0;const v={capabilities:()=>({available:true}),get:()=>null,submit:()=>{calls++;throw Error('must not submit');}};
 const w=createAIMVWorkflow({...f,video:v,audioPath:()=>f.audio,probe,ffmpeg:ff});t.after(()=>w.close());
 await assert.rejects(w.start({request_id:crypto.randomUUID(),project:{...f.project,id:crypto.randomUUID()},plan_id:f.plan.id}),/不一致/);
 await assert.rejects(w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id,shots:[{id:f.plan.shots[0].id,label:'',prompt:'test'}]}),/完整/);
 fs.appendFileSync(f.audio,'tamper');await assert.rejects(w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id}),/版本已改变/);
 assert.equal(calls,0);assert.throws(()=>editableMVPlan({...f.plan,shots:[{...f.plan.shots[0],end:10}]}),/连续/);
});
test('重启恢复和同请求重复点击只提交一个镜头，真实FFmpeg合成音频并导出可验证MP4',async t=>{
 const f=fixture(t),original=sha(fs.readFileSync(f.audio));let submits=0,refreshes=0;const clips=new Map();
 const fixtureClip=path.join(f.data,'fixture.mp4');encode(['-f','lavfi','-i','testsrc2=size=96x64:rate=24','-t','5','-c:v','libx264','-pix_fmt','yuv420p',fixtureClip]);
 const video={capabilities:()=>({available:true,estimatedCostCny:1.2}),get:id=>clips.get(id)||null,
  submit:async({request_id})=>{submits++;const clip={id:request_id,status:'pending',model:'mock-wan',estimatedCostCny:1.2};clips.set(request_id,clip);return clip;},
  refresh:async id=>{refreshes++;const dir=path.join(f.data,'aliyun-video',id);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(fixtureClip,path.join(dir,'video.mp4'));const c={id,status:'ready',model:'mock-wan',estimatedCostCny:1.2,url:`/files/aliyun-video/${id}/video.mp4`,sha256:sha(fs.readFileSync(fixtureClip))};clips.set(id,c);return c;}};
 const opts={...f,video,audioPath:()=>f.audio,probe,ffmpeg:ff,pollMs:20};let w=createAIMVWorkflow(opts);
 const input={request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id};const queued=await w.start(input);w.close();
 w=createAIMVWorkflow(opts);t.after(()=>w.close());assert.equal((await w.start(input)).id,queued.id);
 assert.equal((await w.start({...input,request_id:crypto.randomUUID()})).id,queued.id);
 for(let i=0;i<400&&w.get(queued.id).status!=='ready';i++)await new Promise(r=>setTimeout(r,25));
 const result=w.get(queued.id);assert.equal(result.status,'ready',result.error);assert.equal(submits,1);assert.equal(refreshes,1);
 const output=path.join(f.data,'jobs',result.id,'mv.mp4'),info=probe(output);
 assert.equal(info.streams.find(s=>s.codec_type==='video').width,1280);assert.equal(info.streams.find(s=>s.codec_type==='video').height,720);
 assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(info.format.duration)-5)<.2);
 assert.equal(result.generated.sha256,sha(fs.readFileSync(output)));assert.equal(sha(fs.readFileSync(f.audio)),original);
 assert.ok(fs.existsSync(path.join(f.data,'ai-mv-jobs',result.id,'shot-1.jpg')));
 assert.equal(result.audioFile,undefined);assert.equal(result.source_id,f.project.source.id);
});
test('不明确的付费请求保留uncertain，重复启动不重新提交',async t=>{
 const f=fixture(t);let submits=0;const clips=new Map();const video={capabilities:()=>({available:true,estimatedCostCny:1.2}),get:id=>clips.get(id),submit:async({request_id})=>{submits++;const c={id:request_id,status:'uncertain',error:'任务提交状态待核对'};clips.set(request_id,c);return c;},refresh:async()=>{throw Error('unexpected');}};
 const w=createAIMVWorkflow({...f,video,audioPath:()=>f.audio,probe,ffmpeg:ff});t.after(()=>w.close());
 const input={request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id};await w.start(input);await w.refresh(input.request_id);
 assert.equal(w.get(input.request_id).status,'uncertain');await w.start({...input,request_id:crypto.randomUUID()});await w.refresh(input.request_id);assert.equal(submits,1);
});

test('剩余预算虽够一镜但不足整项10秒时，在任何付费提交前拒绝',async t=>{
 const f=fixture(t);f.plan.duration=10;
 f.plan.shots.push({id:crypto.randomUUID(),label:'海浪',prompt:'近景拍摄海浪轻轻掠过沙滩，保持清晨柔光',start:5,end:10,duration:5});
 let submits=0;const clips=new Map(),video={
  capabilities:()=>({available:true,estimatedCostCny:1.2,remainingCny:1.5}),
  get:id=>clips.get(id)||null,
  submit:async({request_id})=>{submits++;const clip={id:request_id,status:'uncertain',error:'模拟提交回执待核对'};clips.set(request_id,clip);return clip;},
  refresh:async()=>{throw Error('uncertain tasks must not be polled automatically');}
 };
 const w=createAIMVWorkflow({...f,video,audioPath:()=>f.audio,probe,ffmpeg:ff});t.after(()=>w.close());
 await assert.rejects(w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id}),e=>e.status===402&&/全部镜头/.test(e.message));
 assert.equal(submits,0);assert.deepEqual(w.list(),[]);
 assert.deepEqual(fs.readdirSync(path.join(f.data,'ai-mv-jobs')),[],'预算拒绝不留下已接受的部分制作任务');

 // The same remaining allowance genuinely permits the five-second alternative.
 f.plan.duration=5;f.plan.shots=f.plan.shots.slice(0,1);
 const allowed=await w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id});
 assert.equal(allowed.estimatedCostCny,1.2);assert.equal(allowed.shots.length,1);
 const submitted=await w.refresh(allowed.id);assert.equal(submits,1);assert.equal(submitted.status,'uncertain');
});

test('两镜已完成后只改一镜：新任务复用未改镜头，只多提交一次并合成完整10秒',async t=>{
 const f=fixture(t);f.plan.duration=10;
 f.plan.shots.push({id:crypto.randomUUID(),label:'沿岸细节',prompt:'近景跟拍蓝色海浪掠过浅色沙滩，清晨柔光，缓慢平移',start:5,end:10,duration:5});
 const sourceHash=sha(fs.readFileSync(f.audio)),fixtureClip=path.join(f.data,'reuse-fixture.mp4');
 encode(['-f','lavfi','-i','testsrc2=size=96x64:rate=24','-t','5','-c:v','libx264','-pix_fmt','yuv420p',fixtureClip]);
 const clips=new Map(),submissions=[],clipHash=sha(fs.readFileSync(fixtureClip));
 const video={
  capabilities:()=>({available:true,estimatedCostCny:1.2,remainingCny:4-submissions.length*1.2}),
  get:id=>clips.get(id)||null,
  submit:async({request_id,prompt})=>{
   assert.equal(clips.has(request_id),false,'同一子任务不能再次提交');submissions.push({id:request_id,prompt});
   const dir=path.join(f.data,'aliyun-video',request_id);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(fixtureClip,path.join(dir,'video.mp4'));
   const clip={id:request_id,status:'ready',model:'mock-wan',estimatedCostCny:1.2,url:`/files/aliyun-video/${request_id}/video.mp4`,sha256:clipHash};clips.set(request_id,clip);return clip;
  },
  refresh:async()=>{throw Error('ready child clips must be reused directly');}
 };
 const w=createAIMVWorkflow({...f,video,audioPath:()=>f.audio,probe,ffmpeg:ff,pollMs:20});t.after(()=>w.close());
 const first=await w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id}),ready=await w.refresh(first.id);
 assert.equal(ready.status,'ready',ready.error);assert.equal(submissions.length,2);assert.equal(ready.shots.length,2);
 const edits=f.plan.shots.map(s=>({id:s.id,label:s.label,prompt:s.prompt}));
 edits[0].prompt='清晨海面上空，一只白色海鸟低空掠过，镜头从中景缓慢拉远';
 const queued=await w.start({request_id:crypto.randomUUID(),project:f.project,plan_id:f.plan.id,shots:edits});
 assert.notEqual(queued.id,ready.id);assert.equal(queued.estimatedCostCny,1.2,'只为新镜头预留预算');
 assert.equal(queued.shots[0].reused,false);assert.notEqual(queued.shots[0].task_id,ready.shots[0].task_id);
 assert.equal(queued.shots[1].reused,true);assert.equal(queued.shots[1].task_id,ready.shots[1].task_id);
 const result=await w.refresh(queued.id);assert.equal(result.status,'ready',result.error);
 assert.equal(submissions.length,3);assert.equal(clips.size,3);
 assert.equal(submissions.filter(s=>s.prompt===f.plan.shots[1].prompt).length,1,'未修改的第二镜只生成一次');
 assert.equal(submissions.at(-1).prompt,edits[0].prompt);
 const output=path.join(f.data,'jobs',result.id,'mv.mp4'),info=probe(output),v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio');
 assert.equal(result.generated.duration,10);assert.ok(Math.abs(Number(info.format.duration)-10)<.2);
 assert.equal(v.width,1280);assert.equal(v.height,720);assert.equal(Number(v.nb_frames),240);
 assert.ok(a);assert.ok(Math.abs(Number(a.duration)-10)<.2);
 assert.equal(result.generated.sha256,sha(fs.readFileSync(output)));
 assert.equal(sha(fs.readFileSync(path.join(f.data,'jobs',ready.id,'mv.mp4'))),ready.generated.sha256,'首次成片保持不变');
 assert.equal(sha(fs.readFileSync(f.audio)),sourceHash,'原歌曲保持不变');
});
