import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {makeProject} from '../public/domain.js';
import {createCanvasDocument} from '../public/canvas-document.js';
import {OII_PROMPT_TEMPLATES} from '../public/oiioii-canvas-catalog.js';
const id=()=>crypto.randomUUID(),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ff=mediaTools().ffmpeg;
const encode=args=>execFileSync(ff,['-y','-v','error',...args],{timeout:30000,stdio:['ignore','pipe','pipe']});

test('new canvas routes preserve real registry/mv/edit/audio origins and import source references without paid calls',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'server-canvas-tools-')),data=path.join(root,'data');fs.mkdirSync(data);const jpg=path.join(root,'image.jpg'),video=path.join(root,'source.mp4');
 encode(['-f','lavfi','-i','color=c=orange:s=96x80','-frames:v','1',jpg]);
 encode(['-f','lavfi','-i','color=c=0x263e4f:s=96x80:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video]);
 const fixtureTemplates=Array.from({length:3},(_,index)=>({id:'synthetic-reference-'+index,name:'Synthetic reference '+index,prompt:'A plain test image',references:{images:['https://example.invalid/fixtures/fixture-'+index+'.jpg']},referenceUrls:{images:['https://api.oiioii.ai/res/read_file?file=synthetic-'+index+'.jpg']}}));OII_PROMPT_TEMPLATES.push(...fixtureTemplates);
 const previous={MV_DATA_DIR:process.env.MV_DATA_DIR,MV_DISABLE_MODELS:process.env.MV_DISABLE_MODELS},nativeFetch=globalThis.fetch;process.env.MV_DATA_DIR=data;process.env.MV_DISABLE_MODELS='1';let referenceDownloads=0,cdnDownloads=0;const redirects=new Map(),externalRequests=[];
 globalThis.fetch=async(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(['127.0.0.1','localhost'].includes(url.hostname))return nativeFetch(input,options);externalRequests.push(url.href);assert.ok(['api.oiioii.ai','res.oiioii.tv'].includes(url.hostname),'no model or unauthorized CDN may be contacted');assert.equal(options?.method||'GET','GET');assert.equal(new Headers(options?.headers).has('authorization'),false);if(url.hostname==='res.oiioii.tv'){assert.equal(options?.redirect,'manual');cdnDownloads++;return new Response(fs.readFileSync(jpg),{headers:{'Content-Type':'image/jpeg'}});}assert.equal(url.pathname,'/res/read_file');referenceDownloads++;if(redirects.has(url.href))return new Response(null,{status:302,headers:{Location:redirects.get(url.href)}});return new Response(fs.readFileSync(jpg),{headers:{'Content-Type':'image/jpeg'}});};
 const {createServer}=await import('../server.mjs');const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const project={...makeProject(),id:id(),studio:{ratio:'16:9',canvas:createCanvasDocument()}};
 const sourceId=id()+'.wav';
 encode(['-f','lavfi','-i','sine=frequency=330:sample_rate=8000','-t','90',path.join(data,'uploads',sourceId)]);
 project.source={id:sourceId,url:'/files/uploads/'+sourceId,name:'Synthetic regression source',duration:90};
 const request=async(route,input,method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return{status:response.status,data:await response.json()};};
 const tool=(route,input)=>request('/api/canvas/'+route,{project,...input});
 const upload=async(name,file)=>{const response=await fetch(base+'/api/materials',{method:'POST',headers:{'x-filename':encodeURIComponent(name)},body:fs.readFileSync(file)});assert.equal(response.status,201);return(await response.json()).material;};
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 try{
  const image=await upload('input.jpg',jpg),clip=await upload('input.mp4',video),mv=id(),shared=id();const mvDir=path.join(data,'jobs',mv);fs.mkdirSync(mvDir);fs.copyFileSync(video,path.join(mvDir,'mv.mp4'));
  write(path.join(mvDir,'job.json'),{id:mv,status:'ready',project:{...project,generated:{url:`/files/jobs/${mv}/mv.mp4`,sha256:sha(fs.readFileSync(video)),duration:2}}});
  let extracted,edited;
  await t.test('source and registered material ids resolve, then a normal ready MV becomes editable audio',async()=>{
   const registered=await tool('extract-audio',{request_id:id(),asset_id:clip.id,start:0,end:.5});assert.equal(registered.status,200);assert.equal(registered.data.job.status,'ready');assert.equal(registered.data.materials[0].kind,'audio');
   extracted=await tool('extract-audio',{request_id:shared,asset_id:'mv:'+mv,start:0,end:.5});assert.equal(extracted.status,200);assert.equal(extracted.data.job.status,'ready');assert.equal(extracted.data.materials[0].kind,'audio');
  });
  await t.test('edit: and audio: outputs remain resolvable and cache identity includes the tool namespace',async()=>{
   edited=await tool('edit',{request_id:shared,clips:[{id:'mv:'+mv,start:0,end:.5}],audio:{id:'audio:'+shared,start:0,gain:1},ratio:'16:9'});assert.equal(edited.status,200);assert.equal(edited.data.job.status,'ready');assert.equal(edited.data.materials[0].kind,'video');assert.notEqual(edited.data.materials[0].id,extracted.data.materials[0].id);
   const again=await tool('extract-audio',{request_id:id(),asset_id:'edit:'+shared,start:0,end:.5});assert.equal(again.status,200);assert.equal(again.data.job.status,'ready');
   assert.equal((await fetch(base+`/files/canvas-edits/${shared}/video.mp4`,{method:'HEAD'})).status,200);assert.equal((await fetch(base+`/files/canvas-audio/${shared}/video.mp4`)).status,404);assert.equal((await fetch(base+`/files/canvas-edits/${shared}/audio.wav`)).status,404);
   const vision=(await request('/api/capabilities',undefined,'GET')).data.canvas.vision;
   if(vision.operations['grid-split']){
    const grid=await tool('vision',{request_id:shared,material_id:image.id,operation:'grid-split',rows:2,columns:2});assert.equal(grid.status,200);assert.equal(grid.data.materials.length,4);assert.ok(grid.data.materials.every(item=>item.kind==='image'));assert.ok(grid.data.materials.every(item=>item.id!==edited.data.materials[0].id));
   }else{const grid=await tool('vision',{request_id:shared,material_id:image.id,operation:'grid-split',rows:2,columns:2});assert.equal(grid.status,503);}
  });
  await t.test('synthetic catalog URI/referenceUrls are imported once, with source MIME extension preserved',async()=>{
   const template=OII_PROMPT_TEMPLATES[0];assert.match(template.references.images[0],/\.jpg$/);const input={template_id:template.id,kind:'image',index:0};
   const responses=await Promise.all([tool('template-reference',input),tool('template-reference',input)]);for(const response of responses){assert.equal(response.status,201);assert.equal(response.data.material.kind,'image');assert.match(response.data.material.name,/\.jpg$/);}
   assert.equal(responses[0].data.material.id,responses[1].data.material.id);assert.equal(referenceDownloads,1);
  });
  await t.test('normal public API 302 to the exact verified CDN imports a JPEG without changing the source',async()=>{
   const template=OII_PROMPT_TEMPLATES.find(item=>item.references.images[0]?.endsWith('.jpg')&&item.referenceUrls.images[0]!==OII_PROMPT_TEMPLATES[0].referenceUrls.images[0]);assert.ok(template);
   const before={fixture:sha(fs.readFileSync(jpg)),source:sha(Buffer.from(await(await fetch(base+image.url)).arrayBuffer()))},apiBefore=referenceDownloads,cdnBefore=cdnDownloads;
   redirects.set(template.referenceUrls.images[0],'https://res.oiioii.tv/public-fixtures/reference.jpg?signature=fixture-only');
   const input={template_id:template.id,kind:'image',index:0},responses=await Promise.all([tool('template-reference',input),tool('template-reference',input)]);
   for(const response of responses){assert.equal(response.status,201);assert.equal(response.data.material.kind,'image');assert.match(response.data.material.name,/\.jpg$/);assert.equal(response.data.material.sha256,before.fixture);assert.equal(sha(Buffer.from(await(await fetch(base+response.data.material.url)).arrayBuffer())),before.fixture);}
   assert.equal(responses[0].data.material.id,responses[1].data.material.id);assert.equal(referenceDownloads-apiBefore,1);assert.equal(cdnDownloads-cdnBefore,1);
   assert.equal(sha(fs.readFileSync(jpg)),before.fixture);assert.equal(sha(Buffer.from(await(await fetch(base+image.url)).arrayBuffer())),before.source);
  });
  await t.test('unverified redirect hosts, HTTP, credentials and alternate ports are rejected before any target fetch',async()=>{
   const used=new Set([...redirects.keys(),OII_PROMPT_TEMPLATES[0].referenceUrls.images[0]]),template=OII_PROMPT_TEMPLATES.find(item=>item.referenceUrls.images[0]&&!used.has(item.referenceUrls.images[0]));assert.ok(template);
   const sourceHash=sha(fs.readFileSync(jpg)),materialCount=(await request('/api/materials',undefined,'GET')).data.materials.length;
   for(const location of['https://res.oiioii.tv.attacker.example/file.jpg','https://attacker.example/file.jpg','http://res.oiioii.tv/file.jpg','https://user:password@res.oiioii.tv/file.jpg','https://res.oiioii.tv:8443/file.jpg','http://127.0.0.1:1/private']){
    redirects.set(template.referenceUrls.images[0],location);const previousRequests=externalRequests.length,apiBefore=referenceDownloads,cdnBefore=cdnDownloads;
    const response=await tool('template-reference',{template_id:template.id,kind:'image',index:0});assert.equal(response.status,400);assert.match(response.data.error,/跳转地址/);
    assert.equal(referenceDownloads-apiBefore,1);assert.equal(cdnDownloads,cdnBefore);assert.deepEqual(externalRequests.slice(previousRequests),[template.referenceUrls.images[0]]);
   }
   assert.equal((await request('/api/materials',undefined,'GET')).data.materials.length,materialCount);assert.equal(sha(fs.readFileSync(jpg)),sourceHash);
  });
  await t.test('raw material ids in model, vision, edit and generation records prevent deletion',async()=>{
   for(const [folder,name,record]of[
    ['aliyun-image',id()+'.json',material=>({request:{references:[{material_id:material.id}]}})],
    ['aliyun-video',id()+'.json',material=>({request:{image:{materialId:material.id}}})],
    ['canvas-generation',id()+'.json',material=>({references:[material.id],keyframe:{id:material.id}})],
    ['canvas-vision',id()+'/result.json',material=>({material_id:material.id})],
    ['canvas-edits',id()+'/job.json',material=>({sources:[{id:material.id}]})],
    ['canvas-audio',id()+'/job.json',material=>({input:{asset_id:material.id}})],
   ]){const material=await upload('protected.jpg',jpg),file=path.join(data,folder,name);write(file,record(material));assert.equal((await request('/api/materials/'+material.id,undefined,'DELETE')).status,409,folder);fs.unlinkSync(file);assert.equal((await request('/api/materials/'+material.id,undefined,'DELETE')).status,200,folder);}
  });
  await t.test('tampered MV cannot become an unverified audio source and invalid video parameters fail before any model call',async()=>{
   const downloadsBefore=referenceDownloads;
   fs.appendFileSync(path.join(mvDir,'mv.mp4'),'changed');const response=await tool('extract-audio',{request_id:id(),asset_id:'mv:'+mv,start:0,end:.5});assert.notEqual(response.status,200);assert.equal((await fetch(base+`/files/jobs/${mv}/mv.mp4`)).status,404);
   const invalid=await tool('generation',{request_id:id(),kind:'video',prompt:'长文本'.repeat(1000),ratio:'3:2',duration:14});assert.equal(invalid.status,400);assert.match(invalid.data.error,/画幅/);assert.equal(referenceDownloads,downloadsBefore);
   assert.equal((await request('/api/canvas/generation?project_id=invalid',undefined,'GET')).status,400);
  });
 }finally{OII_PROMPT_TEMPLATES.splice(0,OII_PROMPT_TEMPLATES.length);await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});}
});
