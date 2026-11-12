import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMVDirector} from '../mv-director.mjs';
import {MV_VISUAL_STYLES,findVisualStyle} from '../public/mv-style-catalog.js';

function setup(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-visual-style-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const audio=path.join(data,'song.wav'),picture=path.join(data,'picture.png'),clip=path.join(data,'clip.mp4');fs.writeFileSync(audio,'test audio');fs.writeFileSync(picture,'test image');fs.writeFileSync(clip,'test video');
 const contexts=[],images=new Map(),materialsMap=new Map(),imageSubmissions=[];
 const fetchImpl=async(_url,options)=>{const c=JSON.parse(JSON.parse(options.body).messages[1].content);contexts.push(c);const plan={summary:'故事',style:'柔和画面',characters:[],scenes:[{name:'海边',description:'清晨海岸'}],shots:c.slots.map(x=>({id:x.id,name:'远景',description:'海面缓缓展开',sceneId:'scene-1',characterIds:[]}))};return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]})};};
 const image={capabilities:()=>({available:true,remainingCny:20,estimatedCostCny:.2}),get:id=>images.get(id),submit:async x=>{imageSubmissions.push(x);const r={id:x.request_id,status:'ready',url:'/test'};images.set(r.id,r);return r;},asset:id=>images.has(id)?{file:picture}:null};
 const materials={upload:(name,bytes)=>{const id=crypto.randomUUID(),material={id,name,kind:'image',bytes:bytes.length};materialsMap.set(id,{material,file:picture});return material;},asset:id=>materialsMap.get(id)};
 const clipId=crypto.randomUUID(),clipMaterial={id:clipId,kind:'video',duration:8,url:'/test-video',sha256:crypto.createHash('sha256').update(fs.readFileSync(clip)).digest('hex')};materialsMap.set(clipId,{material:clipMaterial,file:clip});
 const options={data,key:'test',image,video:{},materials,audioPath:()=>audio,probe:async()=>({streams:[{codec_type:'video',duration:8,width:320,height:180}]}),ffmpeg:'unused',fetchImpl,pollMs:60000,analyze:async()=>({accents:[],energy:[]})};
 const d=createMVDirector(options);t.after(()=>d.close());
 const project={id:crypto.randomUUID(),title:'测试',source:{id:crypto.randomUUID()+'.wav',duration:8},lyrics:[]};
 return{d,options,project,contexts,imageSubmissions,clipId};
}
async function perform(d,s,kind,input){const j=d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind,input});await d.refresh(j.id);assert.equal(d.job(j.id).status,'ready',d.job(j.id).message);return d.get(s.id);}
const input={selection:{mode:'full'},idea:'用户原有创意',ratio:'16:9',references:[],productionMode:'manual-web'};

test('风格提交后独立持久，参与规划与生图且不修改用户创意',async t=>{
 const f=setup(t);let s=f.d.open(f.project);
 s=await perform(f.d,s,'prepare',{...input,visualStyle:'cinematic'});
 assert.equal(s.visualStyle,'cinematic');assert.equal(s.idea,input.idea);assert.equal(f.contexts[0].idea,input.idea);
 assert.equal(f.contexts[0].visual_style,findVisualStyle('cinematic').description);
 f.d.close();const resumed=createMVDirector(f.options);t.after(()=>resumed.close());s=resumed.get(s.id);
 assert.equal(s.visualStyle,'cinematic');assert.equal(s.idea,input.idea);
 s=await perform(resumed,s,'assets-preview',{confirmed:true});
 assert(f.imageSubmissions[0].prompt.includes(findVisualStyle('cinematic').description));
 s=await perform(resumed,s,'prepare',{...input,visualStyle:'cinematic'});
 assert.equal(s.idea,input.idea);assert.equal(f.contexts[1].idea,input.idea);assert.equal(f.contexts[1].visual_style,findVisualStyle('cinematic').description);
});
test('旧请求与自动风格不虚构风格，非法风格在模型调用前拒绝',async t=>{
 const f=setup(t);let s=f.d.open(f.project);assert.equal(s.visualStyle,undefined);
 assert.throws(()=>f.d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'prepare',input:{...input,visualStyle:'invalid'}}),/视觉风格/);assert.equal(f.contexts.length,0);
 s=await perform(f.d,s,'prepare',input);assert.equal(s.visualStyle,'auto');assert.equal(f.contexts[0].visual_style,undefined);
 s=await perform(f.d,s,'prepare',{...input,visualStyle:'auto'});assert.equal(s.visualStyle,'auto');assert.equal(f.contexts[1].visual_style,undefined);
 assert.equal(MV_VISUAL_STYLES.length,5);assert(MV_VISUAL_STYLES.every(v=>typeof v.gradient==='string'&&v.gradient.startsWith('linear-gradient(')));
});
test('风格变化会失效旧导入镜头，自动风格保留旧版签名兼容',async t=>{
 const f=setup(t);let s=f.d.open(f.project);
 s=await perform(f.d,s,'prepare',input);const shot=s.plan.shots[0];
 s=await f.d.importShot({session_id:s.id,revision:s.revision,shot_id:shot.id,material_id:f.clipId});
 const oldVersion=s.importedShots[shot.id].selected;assert.equal(s.importedShots[shot.id].valid,true);
 s=await perform(f.d,s,'prepare',{...input,visualStyle:'cinematic'});
 assert.equal(s.plan.style,'柔和画面','模拟 AI 返回相同风格');assert.equal(s.importedShots[shot.id].valid,false);
 s=await f.d.importShot({session_id:s.id,revision:s.revision,shot_id:shot.id,material_id:f.clipId});assert.equal(s.importedShots[shot.id].valid,true);
 s=await perform(f.d,s,'prepare',{...input,visualStyle:'auto'});assert.equal(s.importedShots[shot.id].valid,false);
 s=f.d.selectImportedShot({session_id:s.id,revision:s.revision,shot_id:shot.id,version_id:oldVersion});assert.equal(s.importedShots[shot.id].valid,true,'旧自动风格签名仍可使用');
});
