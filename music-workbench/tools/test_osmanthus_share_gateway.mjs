import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {localRequestAllowed} from '../../mv-studio/local-access.mjs';

test('friend gateway authenticates, enforces origins and preserves media streaming', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'osmanthus-share-test-'));
  const upstream=http.createServer(async(req,res)=>{
    if(!localRequestAllowed(req)){res.writeHead(403);res.end('local guard rejected');return;}
    if(req.url==='/stream'){
      res.writeHead(200,{'Content-Type':'audio/mpeg'});res.write('first');
      setTimeout(()=>res.end('last'),500);return;
    }
    if(req.url==='/audio'){
      res.writeHead(206,{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-2/10','Content-Length':'3'});
      res.end('mp3');return;
    }
    let body='';for await(const part of req)body+=part;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({method:req.method,url:req.url,headers:req.headers,body}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const config={origin:'https://demo.example',invite:'test-invite-only',session:'test-session-only',port:0,upstream_port:upstream.address().port};
  const cfg=path.join(root,'config.json');await fs.writeFile(cfg,JSON.stringify(config),{mode:0o600});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./osmanthus_share_gateway.mjs',import.meta.url)),cfg],{stdio:['ignore','pipe','inherit']});
  t.after(async()=>{child.kill();await once(child,'exit');upstream.closeAllConnections();upstream.close();await fs.rm(root,{recursive:true,force:true});});
  let text='';
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('gateway startup timeout')),5000);
    child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]).port);}});
    child.once('error',reject);
  });
  function request(url, {method='GET',auth=true,headers={},body=''}={}){
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{Host:'demo.example',...(auth?{Cookie:'__Host-osmanthus-demo='+config.session}:{}),...(body?{'Content-Length':Buffer.byteLength(body)}:{}),...headers}},res=>{
        let content='';res.on('data',x=>content+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:content}));
      });req.on('error',reject);req.end(body);
    });
  }
  assert.equal((await request('/api/project',{auth:false})).status,401);
  assert.equal((await request('/__invite?code=wrong',{auth:false})).status,403);
  const login=await request('/__invite?code='+config.invite,{auth:false});
  assert.equal(login.status,303);assert.equal(login.headers.location,'/');
  assert.match(login.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await request('/',{headers:{Host:'evil.example'}})).status,403);
  assert.equal((await request('/api/edit',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await request('/api/edit',{method:'POST',body:'{}'})).status,403);
  const write=await request('/api/echo',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json',Authorization:'must-not-forward','X-Forwarded-Host':'evil.example'},body:'{"x":1}'});
  assert.equal(write.status,200);
  const received=JSON.parse(write.body);assert.equal(received.body,'{"x":1}');
  assert.equal(received.headers.origin,`http://127.0.0.1:${config.upstream_port}`);
  assert.equal(received.headers.cookie,undefined);assert.equal(received.headers.authorization,undefined);assert.equal(received.headers['x-forwarded-host'],undefined);
  assert.equal(JSON.parse((await request('/mv/api/capabilities')).body).url,'/mv/api/capabilities');
  const navigation=await request('/',{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}});
  assert.equal(navigation.status,200);
  const forwarded=JSON.parse(navigation.body).headers;
  assert.equal(forwarded['sec-fetch-site'],undefined);assert.equal(forwarded['sec-fetch-mode'],undefined);
  assert.equal(forwarded.origin,`http://127.0.0.1:${config.upstream_port}`);
  assert.equal((await request('/api/edit',{method:'POST',headers:{Origin:config.origin,'Sec-Fetch-Site':'cross-site'},body:'{}'})).status,403);
  const range=await request('/audio',{headers:{Range:'bytes=0-2'}});
  assert.equal(range.status,206);assert.equal(range.headers['content-range'],'bytes 0-2/10');assert.equal(range.body,'mp3');
  await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:'/stream',headers:{Host:'demo.example',Cookie:'__Host-osmanthus-demo='+config.session}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c.toString()));res.on('error',reject);
      res.on('end',()=>{try{assert.equal(chunks[0],'first');assert.equal(chunks.join(''),'firstlast');resolve();}catch(e){reject(e);}});
    }).on('error',reject);
  });
});
