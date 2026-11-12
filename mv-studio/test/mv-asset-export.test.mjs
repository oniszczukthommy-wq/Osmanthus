import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {mediaTools} from '../runtime-config.mjs';
test('HTTP 打包当前 MV 资源、列出缺失项并拒绝过期工程版本',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mv-export-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=path.join(dir,'fixture');execFileSync(process.execPath,[path.join(process.cwd(),'test','bridge-fixture-20261111.mjs')],{env:{...process.env,BRIDGE_FIXTURE_ROOT:fixture},timeout:30000});
 const meta=JSON.parse(fs.readFileSync(path.join(fixture,'fixture.json'),'utf8')),ff=mediaTools().ffmpeg;
 const clip=path.join(dir,'clip.mp4');execFileSync(ff,['-v','error','-y','-f','lavfi','-i','color=c=red:s=320x180:r=24','-t','10','-c:v','libx264','-pix_fmt','yuv420p',clip]);
 process.env.MV_DATA_DIR=path.join(fixture,'data');process.env.MV_DISABLE_MODELS='1';const {createServer}=await import('../server.mjs');const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`,json=async(url,body)=>{const r=await fetch(base+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 assert.equal((await json('/api/capabilities')).value.mvDirectorAssetExport,true);
 const id=meta.sessionId,route=`/api/mv-director/${id}/export-assets`;let s=(await json(`/api/mv-director/${id}`)).value.session;
 fs.writeFileSync(path.join(fixture,'data','private-secret.txt'),'private-canary');assert.equal((await json('/api/mv-director/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/export-assets/manifest')).status,404);
 let m=(await json(route+'/manifest')).value.manifest;assert.deepEqual(m.items.map(x=>x.kind),['audio','character','scene']);assert.equal(m.missing.filter(x=>x.kind==='shot').length,1);
 assert(!JSON.stringify(m).includes(fixture),'对外清单不得泄露本机路径');assert.equal((await json(route+`/manifest?revision=${s.revision+1}`)).status,409);
 const uploaded=await fetch(base+'/api/materials',{method:'POST',headers:{'x-filename':'clip.mp4'},body:fs.readFileSync(clip)});assert.equal(uploaded.status,201);const material=(await uploaded.json()).material;
 const imported=await json(`/api/mv-director/${id}/import-shot`,{revision:s.revision,shot_id:s.plan.shots[0].id,material_id:material.id});assert.equal(imported.status,200);s=imported.value.session;
 m=(await json(route+'/manifest')).value.manifest;assert.equal(m.missing.length,0);assert.deepEqual(m.items.map(x=>x.kind),['audio','character','scene','shot']);
 // Preview jobs can update a session without changing its revision. Simulate
 // the same state transition in the isolated fixture and require reapproval.
 const sessionFile=path.join(fixture,'data','mv-director','sessions',id+'.json'),originalSession=fs.readFileSync(sessionFile),partial=JSON.parse(originalSession);delete partial.previews['character-1'];fs.writeFileSync(sessionFile,JSON.stringify(partial));
 const during=(await json(route+'/manifest')).value.manifest;assert.equal(during.revision,s.revision);assert.notEqual(during.signature,m.signature);assert.equal((await fetch(base+route+'?revision='+s.revision+'&signature='+m.signature)).status,409);fs.writeFileSync(sessionFile,originalSession);
 assert.match(m.signature,/^[a-f0-9]{64}$/);assert.equal((await fetch(base+route+'?revision='+s.revision)).status,400);
 const response=await fetch(base+route+'?revision='+s.revision+'&signature='+m.signature);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/zip/);const zipped=path.join(dir,'assets.zip');fs.writeFileSync(zipped,Buffer.from(await response.arrayBuffer()));
 const py='import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; n=z.namelist(); assert n==["manifest.json","Audio/source.wav","Assets/Characters/001.png","Assets/Scenes/001.png","Storyboard/001.mp4"], n; assert json.loads(z.read("manifest.json"))["missing"]==[]; assert all(b"private-canary" not in z.read(k) for k in n); print("ok")';
 assert.equal(execFileSync('python',['-c',py,zipped],{encoding:'utf8'}).trim(),'ok');
 assert.equal((await fetch(base+route+'?revision='+(s.revision-1)+'&signature='+m.signature)).status,409);
 // Local media may disappear while a job changes nothing about revision.
 // The confirmed list must not silently turn into a different archive.
 const clipAsset=path.join(fixture,'data','materials',material.id+'.mp4');fs.writeFileSync(clipAsset,'tampered');
 const changed=await json(route+'/manifest');assert.equal(changed.value.manifest.revision,s.revision);assert.notEqual(changed.value.manifest.signature,m.signature);assert(changed.value.manifest.missing.some(x=>x.kind==='shot'));
 assert.equal((await fetch(base+route+'?revision='+s.revision+'&signature='+m.signature)).status,409);
});
