import {RED_WEBP,RED_BLUE_GIF} from './synthetic-media.mjs';
import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {execFileSync}from 'node:child_process';
import {createMaterialStore}from '../materials.mjs';import {createCanvasFirstFrame,FIRST_FRAME_MAX_PIXELS}from '../canvas-first-frame.mjs';
const ff=mediaTools().ffmpeg,fp=mediaTools().ffprobe,id=()=>crypto.randomUUID(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const encode=args=>execFileSync(ff,['-nostdin','-y','-v','error',...args],{timeout:30000,stdio:['ignore','pipe','pipe']});
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8',timeout:20000}));
function setup(t){const data=fs.mkdtempSync(path.join(os.tmpdir(),'first-frame-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const materials=createMaterialStore({data,probe});return{data,materials,api:createCanvasFirstFrame({data,ffmpeg:ff,probe,materials}),upload(name,args){const file=path.join(data,name);encode([...args,file]);return materials.upload(name,fs.readFileSync(file));}};}

test('real public-template portrait geometry is center-cropped to 720P and original SHA stays immutable',async t=>{
 const f=setup(t),source=f.upload('portrait.jpg',['-f','lavfi','-i','color=c=red:s=1080x1440','-vf','drawbox=x=0:y=480:w=1080:h=480:color=lime:t=fill,drawbox=x=0:y=960:w=1080:h=480:color=blue:t=fill','-frames:v','1']);
 const before=sha(fs.readFileSync(f.materials.asset(source.id).file)),request_id=id();
 const result=await f.api.prepare({request_id,material_id:source.id,ratio:'16:9'});assert.notEqual(result.id,source.id);assert.deepEqual([result.width,result.height],[1280,720]);assert.match(result.name,/\.png$/);
 const output=f.materials.asset(result.id);assert.equal(probe(output.file).streams[0].codec_name,'png');const pixel=encode(['-i',output.file,'-vf','crop=1:1:640:360,format=rgb24','-frames:v','1','-f','rawvideo','pipe:1']);assert.ok(pixel[1]>200&&pixel[0]<50&&pixel[2]<50,'center green band, not top red band, must survive');
 assert.equal(sha(fs.readFileSync(f.materials.asset(source.id).file)),before);assert.equal(f.materials.get(source.id).sha256,source.sha256);
 const count=f.materials.list().length;assert.equal((await f.api.prepare({request_id,material_id:source.id,ratio:'16:9'})).id,result.id);const restarted=createCanvasFirstFrame({data:f.data,ffmpeg:ff,probe,materials:f.materials});assert.equal((await restarted.prepare({request_id,material_id:source.id,ratio:'16:9'})).id,result.id);assert.equal(f.materials.list().length,count);
 await assert.rejects(f.api.prepare({request_id,material_id:source.id,ratio:'9:16'}),/不能更换/);
});

test('five supported target ratios have exact output dimensions and matching PNG/JPEG are reused',async t=>{
 const f=setup(t),source=f.upload('wide.png',['-f','lavfi','-i','color=c=orange:s=360x240','-frames:v','1']);
 for(const[ratio,dimensions]of [['16:9',[1280,720]],['9:16',[720,1280]],['1:1',[720,720]],['4:3',[960,720]],['3:4',[720,960]]]){const prepared=await f.api.prepare({request_id:id(),material_id:source.id,ratio});assert.deepEqual([prepared.width,prepared.height],dimensions);}
 const matching=f.upload('match.jpg',['-f','lavfi','-i','color=c=green:s=320x240','-frames:v','1']),count=f.materials.list().length;assert.deepEqual(await f.api.prepare({request_id:id(),material_id:matching.id,ratio:'4:3'}),matching);assert.equal(f.materials.list().length,count);
});

test('registered WebP and animated GIF become a single real PNG even when the ratio matches',async t=>{
 const f=setup(t);
 fs.writeFileSync(path.join(f.data,'sample.webp'),RED_WEBP);fs.writeFileSync(path.join(f.data,'animated.gif'),RED_BLUE_GIF);
 const webp=f.materials.upload('sample.webp',fs.readFileSync(path.join(f.data,'sample.webp'))),gif=f.materials.upload('animated.gif',fs.readFileSync(path.join(f.data,'animated.gif')));
 for(const source of[webp,gif]){const prepared=await f.api.prepare({request_id:id(),material_id:source.id,ratio:'4:3'});assert.notEqual(prepared.id,source.id);assert.deepEqual([prepared.width,prepared.height],[960,720]);assert.match(prepared.name,/\.png$/);assert.equal(probe(f.materials.asset(prepared.id).file).streams[0].codec_name,'png');if(source.id===gif.id){const pixel=encode(['-i',f.materials.asset(prepared.id).file,'-vf','crop=1:1:480:360,format=rgb24','-frames:v','1','-f','rawvideo','pipe:1']);assert.ok(pixel[0]>200&&pixel[2]<50,'GIF must use the first red frame');}assert.ok(f.materials.asset(source.id));}
});

test('upscaled 2560x1440 source remains usable; invalid metadata, paths and over-limit pixels reject before encoding',async t=>{
 const f=setup(t),large=f.upload('large.jpg',['-f','lavfi','-i','color=c=purple:s=2560x1440','-frames:v','1']);assert.ok(large.width*large.height>3_000_000);assert.ok(large.width*large.height<FIRST_FRAME_MAX_PIXELS);assert.deepEqual((await f.api.prepare({request_id:id(),material_id:large.id,ratio:'9:16'})).width,720);
 await assert.rejects(f.api.prepare({request_id:'../bad',material_id:large.id,ratio:'16:9'}));await assert.rejects(f.api.prepare({request_id:id(),material_id:large.id,ratio:'3:2'}));
 const forged={...f.materials,asset:key=>{const found=f.materials.asset(key);return found?{...found,material:{...found.material,width:found.material.width+1}}:null;}},bad=createCanvasFirstFrame({data:path.join(f.data,'forged'),ffmpeg:ff,probe,materials:forged});await assert.rejects(bad.prepare({request_id:id(),material_id:large.id,ratio:'16:9'}),/元数据/);
 const tooLarge=f.upload('over.jpg',['-f','lavfi','-i','color=c=black:s=5000x4000','-frames:v','1']);await assert.rejects(f.api.prepare({request_id:id(),material_id:tooLarge.id,ratio:'16:9'}),/像素/);
});
