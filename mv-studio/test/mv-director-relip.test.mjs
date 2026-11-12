import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createMaterialStore} from '../materials.mjs';
import {createMVDirector} from '../mv-director.mjs';

const ff=process.env.FFMPEG_BIN||'ffmpeg',fp=process.env.FFPROBE_BIN||'ffprobe';
const encode=args=>execFileSync(ff,['-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],timeout:60000});
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
const id=()=>crypto.randomUUID();

function fixture(t,{mode='manual-web',uncertain=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-relip-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const song=path.join(data,'song.wav'),clip=path.join(data,'clip.mp4'),png=path.join(data,'frame.png');
 encode(['-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','12',song]);
 encode(['-f','lavfi','-i','color=c=blue:s=320x240:r=24','-t','12','-c:v','libx264','-pix_fmt','yuv420p',clip]);
 encode(['-f','lavfi','-i','color=c=blue:s=320x240','-frames:v','1',png]);
 const store=createMaterialStore({data,probe});let failOutputUpload=false;
 const materials={...store,upload:(name,bytes)=>{if(failOutputUpload&&name.includes('-lip-')){failOutputUpload=false;throw Error('本地素材登记失败');}return store.upload(name,bytes);}};
 const source={id:id()+'.wav',duration:12,url:'/files/uploads/test.wav',name:'test.wav'};
 const project={id:id(),title:'歌曲',source,lyrics:[{start:1,end:4,text:'第一句'},{start:7,end:10,text:'第二句'}]};
 const images=new Map(),generated=new Map(),lip=new Map(),calls=[];
 const image={capabilities:()=>({available:true,remainingCny:50,estimatedCostCny:.2}),get:id=>images.get(id),asset:id=>images.has(id)?{file:png}:null,submit:async input=>{const r={id:input.request_id,status:'ready',url:'/test.png'};images.set(r.id,r);return r;}};
 const video={capabilities:()=>({available:true,remainingCny:50,estimatedCostsCny:Object.fromEntries(Array.from({length:29},(_,i)=>[i+2,1]))}),get:id=>generated.get(id),asset:id=>generated.has(id)?{file:clip}:null,submit:async input=>{const r={id:input.request_id,status:'ready'};generated.set(r.id,r);return r;}};
 const wan={estimateRelip:({inputDuration,duration})=>({available:true,canSubmit:true,estimatedCostCny:2.4,remainingCny:5,inputDuration,outputDuration:duration}),get:id=>lip.get(id),asset:id=>lip.has(id)?{file:clip}:null,refresh:async id=>lip.get(id),submitRelip:async input=>{calls.push(input);if(uncertain)throw Object.assign(Error('不确定'),{retryBlocked:true});const r={id:input.request_id,status:'ready',providerTaskId:'remote-task-1'};lip.set(r.id,r);return r;}};
 const fetchImpl=async(_url,options)=>{const context=JSON.parse(JSON.parse(options.body).messages[1].content);const answer={summary:'故事',style:'电影',characters:[{name:'人物',description:'蓝外套'}],scenes:[{name:'场景',description:'街道'}],shots:context.slots.map(x=>({id:x.id,name:x.id,description:'人物走路',sceneId:'scene-1',characterIds:['character-1']}))};return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]})};};
 const d=createMVDirector({data,key:'mock',materials,image,video,videoProviders:{seedance25:video,wan3:wan},audioPath:()=>song,probe,ffmpeg:ff,fetchImpl,analyze:async()=>({accents:[],energy:[]}),pollMs:60000});t.after(()=>d.close());
 return{d,project,materials,clip,calls,mode,failOutput:()=>{failOutputUpload=true;}};
}
async function ready(d,s,kind,input){const j=d.start({session_id:s.id,revision:s.revision,request_id:id(),kind,input});await d.refresh(j.id);assert.equal(d.job(j.id).status,'ready',d.job(j.id).message);return d.get(s.id);}
async function prepare(f){let s=f.d.open(f.project);s=await ready(f.d,s,'prepare',{selection:{mode:'full'},productionMode:f.mode,idea:'测试',ratio:'4:3',references:[]});s=await ready(f.d,s,'preview',{confirmed:true});return s;}

test('导入镜头二次口型有只读报价、保留原版且选中新版后可以合成',async t=>{
 const f=fixture(t);let s=await prepare(f);const material=await f.materials.upload('clip.mp4',fs.readFileSync(f.clip));
 for(const shot of s.plan.shots)s=await f.d.importShot({session_id:s.id,revision:s.revision,shot_id:shot.id,material_id:material.id});
 const old=s.importedShots[s.plan.shots[0].id].selected,first=s.plan.shots[0],before=s.revision,count=f.materials.list().length;
 const estimate=await f.d.relipQuote(s.id,first.id);assert.equal(estimate.estimatedCostCny,2.4);assert.equal(f.d.get(s.id).revision,before);assert.equal(f.materials.list().length,count);
 await assert.rejects(f.d.startRelip({session_id:s.id,revision:s.revision,request_id:id(),shot_id:first.id,confirmed:true,confirmed_max_cost_cny:2}),/重新报价/);
 const request_id=id(),args={session_id:s.id,revision:s.revision,request_id,shot_id:first.id,confirmed:true,confirmed_max_cost_cny:2.4};
 const job=await f.d.startRelip(args);const replay=await f.d.startRelip(args);assert.equal(job.id,replay.id);await f.d.refresh(job.id);assert.equal(f.d.job(job.id).status,'ready',f.d.job(job.id).message);assert.equal(f.calls.length,1);
 s=f.d.get(s.id);assert.equal(s.importedShots[first.id].selected,old);assert.equal(s.importedShots[first.id].versions.length,2);assert.equal(f.calls[0].start,first.start);assert.equal(f.calls[0].audio_duration,first.duration);
 s=f.d.selectImportedShot({session_id:s.id,revision:s.revision,shot_id:first.id,version_id:f.d.job(job.id).output.version_id});
 s=await ready(f.d,s,'compose-imports',{confirmed:true,subtitles:false});assert(s.generated);assert(probe(f.d.asset(s.generated.id).file).streams.some(x=>x.codec_type==='audio'));
});

test('已生成镜头也可二次口型，选择后与其他已生成镜头混合合成',async t=>{
 const f=fixture(t,{mode:'narrative'});let s=await prepare(f);s=await ready(f.d,s,'render',{confirmed:true,subtitles:false});const prior=s.generated.id,shot=s.plan.shots[0];
 const q=await f.d.relipQuote(s.id,shot.id),job=await f.d.startRelip({session_id:s.id,revision:s.revision,request_id:id(),shot_id:shot.id,confirmed:true,confirmed_max_cost_cny:q.estimatedCostCny});await f.d.refresh(job.id);assert.equal(f.d.job(job.id).status,'ready',f.d.job(job.id).message);
 s=f.d.get(s.id);assert.equal(s.generated.id,prior);assert.equal(s.importedShots[shot.id].versions.length,2);
 s=f.d.selectImportedShot({session_id:s.id,revision:s.revision,shot_id:shot.id,version_id:f.d.job(job.id).output.version_id});s=await ready(f.d,s,'compose-imports',{confirmed:true,subtitles:false});assert(s.generated.id!==prior);assert(f.d.asset(prior));
});

test('付费提交不明确时保留原镜头并禁止自动重试',async t=>{
 const f=fixture(t,{uncertain:true});let s=await prepare(f);const material=await f.materials.upload('clip.mp4',fs.readFileSync(f.clip));s=await f.d.importShot({session_id:s.id,revision:s.revision,shot_id:s.plan.shots[0].id,material_id:material.id});
 const shot=s.plan.shots[0],selected=s.importedShots[shot.id].selected,q=await f.d.relipQuote(s.id,shot.id),args={session_id:s.id,revision:s.revision,request_id:id(),shot_id:shot.id,confirmed:true,confirmed_max_cost_cny:q.estimatedCostCny};
 const j=await f.d.startRelip(args);await f.d.refresh(j.id);assert.equal(f.d.job(j.id).status,'uncertain');await f.d.refresh(j.id);assert.equal(f.calls.length,1);assert.equal(f.d.get(s.id).importedShots[shot.id].selected,selected);assert.equal((await f.d.startRelip(args)).id,j.id);
 await assert.rejects(f.d.startRelip({...args,request_id:id(),confirmed_max_cost_cny:3}),/尚未确认/);assert.equal(f.calls.length,1);
});

test('远端已完成但本地保存失败时只恢复原任务，绝不再次付费提交',async t=>{
 const f=fixture(t);let s=await prepare(f);const material=await f.materials.upload('clip.mp4',fs.readFileSync(f.clip));s=await f.d.importShot({session_id:s.id,revision:s.revision,shot_id:s.plan.shots[0].id,material_id:material.id});
 const shot=s.plan.shots[0],q=await f.d.relipQuote(s.id,shot.id),j=await f.d.startRelip({session_id:s.id,revision:s.revision,request_id:id(),shot_id:shot.id,confirmed:true,confirmed_max_cost_cny:q.estimatedCostCny});
 f.failOutput();await f.d.refresh(j.id);assert.equal(f.d.job(j.id).status,'failed');assert.equal(f.calls.length,1);
 assert.throws(()=>f.d.recover(j.id),/确认/);f.d.recover(j.id,{confirmed:true});await f.d.refresh(j.id);
 assert.equal(f.d.job(j.id).status,'ready',f.d.job(j.id).message);assert.equal(f.calls.length,1);
});
