import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCanvasVision} from '../canvas-vision.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const VALIDATION=process.env.MV_VISION_TEST_FIXTURES||path.resolve(HERE,'../test/fixtures/vision');
const PYTHON=process.env.MV_VISION_PYTHON||path.resolve(HERE,'../.venv/bin/python');
const FIXTURE=path.join(VALIDATION,'synthetic-subject.png');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function context(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-vision-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id=crypto.randomUUID(),file=path.join(root,'input.png');
  fs.copyFileSync(FIXTURE,file);
  const sha256=hash(fs.readFileSync(file));
  const material={id,kind:'image',sha256};
  return {root,id,file,sha256,vision:createCanvasVision({data:root,resolveMaterial:key=>key===id?{file,material}:null})};
}
const installed=fs.existsSync(FIXTURE)&&fs.existsSync(PYTHON);

test('real U2NETP yields nonconstant alpha, four PNG layers and keeps source immutable',{skip:!installed&&'Optional local vision model environment/fixture is not configured; no download',timeout:60_000},async t=>{
  const c=context(t),request_id=crypto.randomUUID();
  assert.equal(c.vision.capabilities().operations['remove-background'],true);
  const result=await c.vision.process({request_id,material_id:c.id,operation:'layer-split'});
  assert.equal(result.status,'ready');
  assert.deepEqual(result.outputs.map(x=>x.role),['foreground','background-visible-region','alpha','segmentation-mask']);
  assert.equal(result.metadata.hiddenBackgroundReconstructed,false);
  assert.ok(result.metadata.alphaMax>result.metadata.alphaMin+32);
  for(const o of result.outputs){assert.deepEqual([o.width,o.height],[96,80]);assert.ok(c.vision.asset(result.id,o.filename));}
  assert.equal(hash(fs.readFileSync(c.file)),c.sha256);
  const replay=await c.vision.process({request_id,material_id:c.id,operation:'layer-split'});
  assert.equal(replay.replayed,true);
  assert.equal(replay.outputs[0].sha256,result.outputs[0].sha256);
});

test('official neural Real-ESRGAN produces 2x and 4x pixels, not plain Lanczos resizing',{skip:!installed&&'Optional local vision model environment/fixture is not configured; no download',timeout:120_000},async t=>{
  const c=context(t);
  for(const scale of [2,4]){
    const result=await c.vision.process({request_id:crypto.randomUUID(),material_id:c.id,operation:'upscale',scale});
    const output=result.outputs[0],asset=c.vision.asset(result.id,output.filename);
    assert.deepEqual([output.width,output.height],[96*scale,80*scale]);
    assert.equal(result.metadata.model,'realesr-general-x4v3');
    assert.equal(result.metadata.nativeScale,4);
    const difference=JSON.parse(execFileSync(PYTHON,['-c',"from PIL import Image,ImageChops;import sys,json;a=Image.open(sys.argv[1]).convert('RGB');b=Image.open(sys.argv[2]).convert('RGB');d=ImageChops.difference(a.resize(b.size,Image.Resampling.LANCZOS),b);print(json.dumps({'different':d.getbbox() is not None}))",c.file,asset.file],{encoding:'utf8'}));
    assert.equal(difference.different,true);
  }
  assert.equal(hash(fs.readFileSync(c.file)),c.sha256);
});

test('grid splitting covers all pixels with exact nonoverlapping crops',{skip:!installed&&'Optional local vision model environment/fixture is not configured; no download',timeout:30_000},async t=>{
  const c=context(t),result=await c.vision.process({request_id:crypto.randomUUID(),material_id:c.id,operation:'grid-split',rows:3,columns:5});
  assert.equal(result.outputs.length,15);
  assert.equal(result.outputs.reduce((sum,x)=>sum+x.width*x.height,0),96*80);
  for(const o of result.outputs){assert.ok(c.vision.asset(result.id,o.filename));const[x0,y0,x1,y1]=o.crop;assert.equal(o.width,x1-x0);assert.equal(o.height,y1-y0);}
  assert.equal(result.metadata.method,'exact-integer-grid-crops');
});

test('official Depth Anything Small predicts relative inverse depth with genuine 16-bit output',{skip:!installed&&'Optional local vision model environment/fixture is not configured; no download',timeout:90_000},async t=>{
  const c=context(t);assert.equal(c.vision.capabilities().operations.depth,true);
  const result=await c.vision.process({request_id:crypto.randomUUID(),material_id:c.id,operation:'depth'});
  assert.equal(result.metadata.model,'Depth-Anything-V2-Small');
  assert.equal(result.metadata.metric,false);assert.equal(result.metadata.whiteMeans,'nearer');
  assert.ok(result.metadata.rawMax>result.metadata.rawMin);
  assert.equal(result.outputs.length,2);
  for(const output of result.outputs){assert.deepEqual([output.width,output.height],[96,80]);assert.ok(c.vision.asset(result.id,output.filename));}
  const depth=fs.readFileSync(c.vision.asset(result.id,'depth.png').file);
  assert.equal(depth[24],16);
});

test('safe IDs, source hash, idempotency and registered output hash are enforced',{skip:!installed&&'Optional local vision model environment/fixture is not configured; no download',timeout:30_000},async t=>{
  const c=context(t);
  for(const bad of [
    {request_id:'../escape',material_id:c.id,operation:'grid-split'},
    {request_id:crypto.randomUUID(),material_id:'https://example.com/img.png',operation:'grid-split'},
    {request_id:crypto.randomUUID(),material_id:c.id,operation:'grid-split',rows:20},
    {request_id:crypto.randomUUID(),material_id:c.id,operation:'upscale',scale:3},
  ])await assert.rejects(c.vision.process(bad));
  const request_id=crypto.randomUUID(),result=await c.vision.process({request_id,material_id:c.id,operation:'grid-split'});
  await assert.rejects(c.vision.process({request_id,material_id:c.id,operation:'grid-split',rows:3}),/同一请求/);
  assert.equal(c.vision.asset(request_id,'../../input.png'),null);
  fs.appendFileSync(c.vision.asset(request_id,result.outputs[0].filename).file,'tamper');
  assert.equal(c.vision.asset(request_id,result.outputs[0].filename),null);
  fs.appendFileSync(c.file,'tamper');
  await assert.rejects(c.vision.process({request_id:crypto.randomUUID(),material_id:c.id,operation:'grid-split'}),/哈希不匹配/);
});
