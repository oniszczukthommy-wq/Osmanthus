import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMVDirector} from '../mv-director.mjs';

function setup(t,mode,{includeProvider=true,duration=8,sharedMaterial=false,noLyrics=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'director-mode-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const source=path.join(data,'song.wav'),picture=path.join(data,'image.png');fs.writeFileSync(source,'fake-audio');fs.writeFileSync(picture,'fake-image');
 const p={id:crypto.randomUUID(),title:'MV',source:{id:crypto.randomUUID()+'.wav',duration},lyrics:noLyrics?[]:[{start:1,end:Math.min(3,duration),text:'歌词'}]};
 const images=new Map(),materialsMap=new Map(),submitted=[];
 const image={capabilities:()=>({available:true,remainingCny:100,estimatedCostCny:.2}),get:id=>images.get(id),submit:async x=>{const r={id:x.request_id,status:'ready',url:'/image'};images.set(r.id,r);return r;},asset:id=>images.has(id)?{file:picture}:null};
 const sharedId=crypto.randomUUID();
 const materials={upload:(name,bytes)=>{const id=sharedMaterial?sharedId:crypto.randomUUID(),material={id,name,kind:'image',bytes:bytes.length};materialsMap.set(id,{material,file:picture});return material;},asset:id=>materialsMap.get(id)};
 const v={capabilities:()=>({available:true,remainingCny:100,estimatedCostsCny:Object.fromEntries(Array.from({length:14},(_,i)=>[i+2,(i+2)*.6]))}),get:()=>null,submit:async x=>{submitted.push(x);return{status:'uncertain'};},asset:()=>null};
 const badLegacy={...v,submit:()=>{throw Error('legacy provider was used');}};
 const fetchImpl=async(_url,options)=>{const context=JSON.parse(JSON.parse(options.body).messages[1].content);return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'故事',style:'电影',characters:[],scenes:[{name:'街道',description:'夜晚街道'}],shots:context.slots.map(s=>({id:s.id,name:'镜头',description:'街道缓缓推进',sceneId:'scene-1',characterIds:[]}))})}}]})};};
 const videoProviders=includeProvider?{seedance25:v,wan3:v}:{};
 const director=createMVDirector({data,key:'test-only',image,video:badLegacy,videoProviders,materials,audioPath:()=>source,probe:async()=>({}),ffmpeg:'unused',fetchImpl,pollMs:60000,analyze:async()=>({accents:[],energy:[]})});t.after(()=>director.close());
 return{director,p,mode,submitted};
}
async function perform(f,s,kind,input){const j=f.director.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind,input});await f.director.refresh(j.id);return f.director.job(j.id);}
for(const mode of ['narrative','concept','lip-sync'])test('导演根据模式路由 '+mode+'，保留不确定状态且不重复提交',async t=>{
 const f=setup(t,mode);let s=f.director.open(f.p);
 let j=await perform(f,s,'prepare',{selection:{mode:'full'},idea:'故事',ratio:'16:9',references:[],productionMode:mode});assert.equal(j.status,'ready');s=f.director.get(s.id);assert.equal(s.productionMode,mode);
 const quote=f.director.quote(s.id,'complete');assert.equal(quote.canComplete,true);assert(quote.videoCost>0);
 j=await perform(f,s,'preview',{confirmed:true});assert.equal(j.status,'ready');s=f.director.get(s.id);
 j=await perform(f,s,'render',{confirmed:true});assert.equal(j.status,'uncertain');assert.equal(f.submitted.length,1);
 const request=f.submitted[0];if(mode==='lip-sync'){assert.equal(request.audio_source.id,f.p.source.id);assert.equal(typeof request.start,'number');assert(request.image_id);}else{assert(request.duration>=4);assert(request.image.material_id);assert.equal(request.audio_source,undefined);}
 await f.director.refresh(j.id);assert.equal(f.submitted.length,1);
});
test('未连接的新模型不会回退到旧模型或提交生成',async t=>{
 const f=setup(t,'narrative',{includeProvider:false});let s=f.director.open(f.p);const j=await perform(f,s,'prepare',{selection:{mode:'full'},idea:'故事',ratio:'16:9',references:[],productionMode:'narrative'});assert.equal(j.status,'ready');s=f.director.get(s.id);assert.throws(()=>f.director.quote(s.id,'complete'),/尚未安全接入/);assert.equal(f.submitted.length,0);
});
test('口型视频向上取整时参考音频仍严格按原镜头小数时长裁剪',async t=>{
 const f=setup(t,'lip-sync',{duration:2.4});let s=f.director.open(f.p);
 let j=await perform(f,s,'prepare',{selection:{mode:'full'},idea:'故事',ratio:'16:9',references:[],productionMode:'lip-sync'});assert.equal(j.status,'ready');s=f.director.get(s.id);
 j=await perform(f,s,'preview',{confirmed:true});assert.equal(j.status,'ready');s=f.director.get(s.id);
 j=await perform(f,s,'render',{confirmed:true});assert.equal(j.status,'uncertain');const request=f.submitted[0];assert.equal(request.start,0);assert.equal(request.duration,3);assert.equal(request.audio_duration,2.4);assert.equal(request.start+request.audio_duration,f.p.source.duration);
});
test('画面完全相同但歌曲时间不同的口型镜头必须是独立视频任务',async t=>{
 const f=setup(t,'lip-sync',{duration:14,noLyrics:true,sharedMaterial:true});let s=f.director.open(f.p);
 let j=await perform(f,s,'prepare',{selection:{mode:'full'},idea:'故事',ratio:'16:9',references:[],productionMode:'lip-sync'});assert.equal(j.status,'ready');s=f.director.get(s.id);
 j=await perform(f,s,'preview',{confirmed:true});assert.equal(j.status,'ready');s=f.director.get(s.id);
 j=await perform(f,s,'render',{confirmed:true});assert.equal(j.status,'uncertain');assert.equal(j.shots.length,2);
 assert.deepEqual(j.shots[0].spec,j.shots[1].spec);assert.notEqual(j.shots[0].start,j.shots[1].start);assert.notEqual(j.shots[0].taskId,j.shots[1].taskId);
});
