import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
test('actual MV HTTP server rejects foreign authority/origins for reads and writes',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'local-host-test-'));process.env.MV_DATA_DIR=data;process.env.MV_DISABLE_MODELS='1';
 const {createServer}=await import('../server.mjs'),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(data,{recursive:true,force:true});});
 const port=server.address().port,local=`127.0.0.1:${port}`;
 const request=(method,headers,target='/api/capabilities')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port,path:target,method,headers},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.on('error',reject);q.end();});
 for(const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS'])for(const headers of [
  {Host:'evil.example'},{Host:'evil.example',Origin:'http://evil.example'},
  {Host:local,Origin:'null'},{Host:local,Origin:'http://evil.example'},
  {Host:local,'Sec-Fetch-Site':'cross-site'},{Host:'evil.example','X-Forwarded-Host':local},
  {Host:local+':80'},{Host:`127.0.0.1.evil.example:${port}`}
 ])assert.equal(await request(method,headers),403,JSON.stringify({method,headers}));
 for(const host of [local,`localhost:${port}`])assert.equal(await request('GET',{Host:host,Origin:`http://${host}`}),200);
 assert.equal(await request('GET',{Host:local},'http://evil.example/api/capabilities'),403);
 assert.equal(await request('GET',{Host:local},'//evil.example/api/capabilities'),403);
 assert.equal(await request('POST',{Host:'evil.example',Origin:'http://evil.example','x-filename':'test.wav'},'/api/upload'),403);
 assert.equal(fs.readdirSync(path.join(data,'uploads')).length,0);
});
