import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMVDirector} from '../mv-director.mjs';

const digest=buf=>crypto.createHash('sha256').update(buf).digest('hex');
test('蓝图参考图交给图片模型，镜头图引用角色场景，文字模型不收图片',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-blueprint-reference-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const audio=path.join(data,'audio.wav'),imageFile=path.join(data,'image.png'),bytes=Buffer.from('fake image');fs.writeFileSync(audio,'audio');fs.writeFileSync(imageFile,bytes);
 const materialsMap=new Map(),images=new Map(),submissions=[],contexts=[];
 const imageMaterial=(id=crypto.randomUUID(),overrides={})=>({id,kind:'image',name:'image.png',url:`/files/materials/${id}.png`,bytes:bytes.length,sha256:digest(bytes),...overrides});
 const sourceRef=imageMaterial();materialsMap.set(sourceRef.id,{material:sourceRef,file:imageFile});
 const materials={asset:id=>materialsMap.get(id),upload:async()=>{const material=imageMaterial();materialsMap.set(material.id,{material,file:imageFile});return material;}};
 const image={capabilities:()=>({available:true,remainingCny:20,estimatedCostCny:.2}),get:id=>images.get(id),submit:async req=>{submissions.push(req);const out={id:req.request_id,status:'ready',url:'/test-image'};images.set(out.id,out);return out;},asset:id=>images.has(id)?{file:imageFile}:null};
 const fetchImpl=async(_url,opts)=>{const context=JSON.parse(JSON.parse(opts.body).messages[1].content);contexts.push(context);const p={summary:'MV 创意',style:'电影风',characters:[{name:'旅人',description:'蓝衣角色'}],scenes:[{name:'海边',description:'清晨海边'}],shots:context.slots.map(s=>({id:s.id,name:'镜头',description:'角色看向海面',sceneId:'scene-1',characterIds:['character-1']}))};return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(p)}}]})};};
 const options={data,key:'test',image,video:{},materials,audioPath:()=>audio,ffmpeg:'unused',fetchImpl,pollMs:60000,analyze:async()=>({accents:[],energy:[]})};
 const d=createMVDirector(options);t.after(()=>d.close());const project={id:crypto.randomUUID(),title:'测试',source:{id:crypto.randomUUID()+'.wav',duration:8},lyrics:[]};let s=d.open(project);
 async function perform(kind,input){const j=d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind,input});await d.refresh(j.id);assert.equal(d.job(j.id).status,'ready',d.job(j.id).message);s=d.get(s.id);}
 const input={selection:{mode:'full'},idea:'海边',ratio:'16:9',references:[sourceRef.id],productionMode:'manual-web'};
 const invalid=(refs)=>d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'prepare',input:{...input,references:refs}});
 assert.throws(()=>invalid([crypto.randomUUID()]),/参考素材/);assert.throws(()=>invalid([sourceRef.id,sourceRef.id,sourceRef.id,sourceRef.id]),/参考图/);assert.equal(contexts.length,0);
 await perform('prepare',input);assert.deepEqual(s.references,[sourceRef.id]);assert.equal(contexts[0].reference_count,1);assert(!JSON.stringify(contexts[0]).includes(sourceRef.id));assert(!JSON.stringify(contexts[0]).includes('base64'));
 await perform('assets-preview',{confirmed:true});assert.equal(submissions.length,2);for(const request of submissions)assert.deepEqual(request.references,[{material_id:sourceRef.id}]);
 s=d.confirmAssets({session_id:s.id,revision:s.revision});await perform('shots-preview',{confirmed:true});
 const shot=submissions.at(-1);assert.equal(shot.references.length,2);assert(shot.references.every(r=>typeof r.image_id==='string'));assert(!shot.references.some(r=>r.material_id===sourceRef.id));
 d.close();const reopened=createMVDirector(options);t.after(()=>reopened.close());assert.deepEqual(reopened.get(s.id).references,[sourceRef.id]);
});
