import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createAliImage,ALI_IMAGE_OUTPUT_HOSTS} from '../aliyun-image.mjs';
import {createMaterialStore} from '../materials.mjs';

const remote='https://dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com/image.png?Expires=9999999999&Signature=private-signed-result';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const input=(patch={})=>({request_id:crypto.randomUUID(),prompt:'原创水彩纸叶，柔和侧光，纯色背景。',size:'512*512',...patch});
function png(width=512,height=512){
  const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(type,body)=>{const name=Buffer.from(type),out=Buffer.alloc(body.length+12);out.writeUInt32BE(body.length);name.copy(out,4);body.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([name,body])),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const imageInfo=(width=512,height=512)=>({format:{format_name:'png_pipe'},streams:[{codec_type:'video',codec_name:'png',width,height}]});
function sandbox(t,options={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-aliyun-image-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const config={data,key:'server-only-image-secret',workspace:'llm-test',probe:()=>imageInfo(),fetchImpl:async()=>{throw Error('Every call needs an explicit mock');},...options};return{data,folder:path.join(data,'aliyun-image'),config,adapter:createAliImage(config)};}
function flow({url=remote,bytes=png(),post,download}={}){const calls=[];const fetchImpl=async(urlValue,init)=>{calls.push({url:String(urlValue),init});if(init.method==='POST')return post?post(urlValue,init):json({request_id:'provider-image-1',output:{choices:[{finish_reason:'stop',message:{role:'assistant',content:[{image:url}]}}]},usage:{image_count:1,width:512,height:512}});return download?download(urlValue,init):new Response(bytes,{headers:{'Content-Type':'image/png','Content-Length':String(bytes.length)}});};return{calls,fetchImpl};}

test('async image probe is awaited before publishing ready and permits event-loop progress',async t=>{
  let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const mock=flow(),{adapter}=sandbox(t,{fetchImpl:mock.fetchImpl,probe:async()=>{entered();await gate;return imageInfo();}}),request=input();
  const pending=adapter.submit(request);await started;
  assert.equal(adapter.get(request.request_id).status,'downloading');await new Promise(setImmediate);
  release();assert.equal((await pending).status,'ready');
});

test('官方Qwen2.0同步文生图、持久幂等、真实PNG副本与密钥/结果URL不明文落盘',async t=>{
  const mock=flow(),{adapter,folder,config}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();
  assert.equal(adapter.capabilities().estimatedCostCny,.2);assert.equal(adapter.capabilities().budgetCny,4);
  const ready=await adapter.submit(request);assert.equal(ready.status,'ready');assert.equal(ready.url,`/files/aliyun-image/${request.request_id}/image.png`);assert.equal(ready.width,512);assert.equal(ready.kind,'image');
  const call=mock.calls[0],body=JSON.parse(call.init.body);assert.equal(call.url,'https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');assert.equal(call.init.headers.Authorization,'Bearer server-only-image-secret');assert.equal(call.init.headers['X-DashScope-Async'],undefined);assert.deepEqual(body.input.messages,[{role:'user',content:[{text:request.prompt}]}]);assert.deepEqual(body.parameters,{n:1,size:'512*512',prompt_extend:false,watermark:true});
  assert.equal(mock.calls[1].init.headers,undefined);assert.equal(mock.calls[1].init.redirect,'manual');assert.equal(ready.sha256,crypto.createHash('sha256').update(png()).digest('hex'));
  const recordText=fs.readFileSync(path.join(folder,request.request_id+'.json'),'utf8'),record=JSON.parse(recordText);assert(!recordText.includes('server-only-image-secret'));assert(!recordText.includes('private-signed-result'));assert(!recordText.includes('https://'));assert(record.sealedResult.data);assert.equal(record.resultHost,new URL(remote).hostname);
  const restarted=createAliImage(config);assert.equal((await restarted.submit(request)).replayed,true);assert.equal(mock.calls.length,2);assert.equal(restarted.capabilities().usedCny,.2);assert(fs.readFileSync(restarted.asset(request.request_id).file).equals(png()));
  await assert.rejects(adapter.submit({...request,prompt:'不同内容'}),error=>error.status===409);
});

test('参考编辑只读注册素材和自有输出；最多3张，未指定size时保留末图画幅',async t=>{
  let outputs=0;const square=png(),landscape=png(640,480);
  const mock=flow({download:()=>new Response(++outputs===1?square:landscape)});
  const probe=file=>file.includes(path.sep+'materials'+path.sep)?imageInfo(640,480):outputs===1?imageInfo():imageInfo(640,480);
  const{adapter,data,folder}=sandbox(t,{fetchImpl:mock.fetchImpl,probe});
  const first=await adapter.submit(input());const material=createMaterialStore({data,probe}).upload('reference.png',landscape);
  const edit=input({size:undefined,prompt:'保持构图，只把光照改为清晨柔和侧光。',references:[{image_id:first.id},{material_id:material.id}]});
  const ready=await adapter.submit(edit);assert.equal(ready.status,'ready');assert.equal(ready.width,640);assert.equal(ready.height,480);
  const body=JSON.parse(mock.calls[2].init.body),content=body.input.messages[0].content;assert.equal(content.length,3);assert.match(content[0].image,/^data:image\/png;base64,/);assert.match(content[1].image,/^data:image\/png;base64,/);assert.equal(content[2].text,edit.prompt);assert.equal(body.parameters.size,undefined);
  const record=fs.readFileSync(path.join(folder,ready.id+'.json'),'utf8');assert(!record.includes('data:image'));assert(fs.readFileSync(path.join(data,'materials',path.basename(material.url))).equals(landscape));
  await assert.rejects(adapter.submit(input({references:[{url:'https://example.test/a.png'}]})),/参考图/);
  await assert.rejects(adapter.submit(input({references:[{file:'/etc/passwd'}]})),/参考图/);
  await assert.rejects(adapter.submit(input({references:Array(4).fill({material_id:material.id})})),/最多/);
});

test('4元内持久预算，确认失败释放0.2元，模型n及尺寸不能由用户越权提升',async t=>{
  let posts=0,failNext=false;const mock=flow({post:()=>{posts++;return failNext?json({code:'InvalidParameter',message:'bad input'},400):json({output:{choices:[{finish_reason:'stop',message:{content:[{image:remote}]}}]}});}}),{adapter,config}=sandbox(t,{fetchImpl:mock.fetchImpl,budgetCny:.4});
  await adapter.submit(input({prompt:'第一张'}));failNext=true;const failed=await adapter.submit(input({prompt:'确定失败'}));assert.equal(failed.status,'failed');assert.equal(failed.accountedCostCny,0);failNext=false;await createAliImage(config).submit(input({prompt:'第二张'}));
  await assert.rejects(adapter.submit(input({prompt:'第三张'})),error=>error.status===402);assert.equal(posts,3);assert.equal(adapter.capabilities().usedCny,.4);
  for(const patch of[{n:6},{model:'qwen-image-2.0-pro'},{size:'2048*4096'},{size:'513*512'},{size:'256*256'},{size:'1024*1024',ratio:'16:9'},{source:{id:'sample'}}])await assert.rejects(adapter.submit(input(patch)));
  assert.equal(posts,3);assert.throws(()=>createAliImage({...config,budgetCny:4.01}));
});

test('官方允许的长边超过2048可用，总像素仍受2048平方和16倍数限制',async t=>{
  for(const[width,height]of[[2688,1536],[2560,1440]]){
    const mock=flow({bytes:png(width,height)}),{adapter}=sandbox(t,{fetchImpl:mock.fetchImpl,probe:()=>imageInfo(width,height)}),request=input({size:`${width}*${height}`,ratio:'16:9'});
    const ready=await adapter.submit(request);assert.equal(ready.status,'ready');assert.equal(ready.width,width);assert.equal(ready.height,height);assert.equal(JSON.parse(mock.calls[0].init.body).parameters.size,request.size);
    await assert.rejects(adapter.submit(input({size:'8192*1024'})),/总像素/);await assert.rejects(adapter.submit(input({size:'2561*1440'})),/16/);await assert.rejects(adapter.submit(input({size:'2560*1440',ratio:'1:1'})),/不一致/);
  }
});

test('响应连接中断计入预算且同ID/换ID同内容均不重复付费',async t=>{
  let calls=0;const{adapter,config}=sandbox(t,{fetchImpl:async()=>{calls++;throw new DOMException('mock timeout','TimeoutError');}}),request=input();
  await assert.rejects(adapter.submit(request),error=>error.retryBlocked&&error.status===409);assert.equal(adapter.get(request.request_id).status,'uncertain');assert.equal(adapter.capabilities().usedCny,.2);
  await assert.rejects(createAliImage(config).submit(request),error=>error.retryBlocked);await assert.rejects(adapter.submit({...request,request_id:crypto.randomUUID()}),error=>error.retryBlocked);assert.equal(calls,1);
});

test('并发同ID只发一次付费请求，发送前已持久登记预算',async t=>{
  let release,posts=0;const mock=flow({post:async()=>{posts++;return await new Promise(resolve=>{release=resolve;});}}),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();
  const one=adapter.submit(request),two=adapter.submit(request);assert.equal(JSON.parse(fs.readFileSync(path.join(folder,request.request_id+'.json'))).status,'submitting');
  await assert.rejects(createAliImage(config).submit(request),error=>error.retryBlocked);
  release(json({output:{choices:[{finish_reason:'stop',message:{content:[{image:remote}]}}]}}));const[a,b]=await Promise.all([one,two]);assert.equal(a.url,b.url);assert.equal(b.replayed,true);assert.equal(posts,1);
});

test('同步生成结果下载失败可解密恢复，仅重GET原结果；密钥变更不会重POST',async t=>{
  let downloading=false;const mock=flow({download:()=>downloading?new Response(png()):new Response('',{status:503})}),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();
  assert.equal((await adapter.submit(request)).status,'download_failed');assert.equal(mock.calls.filter(call=>call.init.method==='POST').length,1);
  const wrongKey=createAliImage({...config,key:'different-key'});assert.equal((await wrongKey.refresh(request.request_id)).status,'download_failed');assert.equal(mock.calls.length,2);
  downloading=true;assert.equal((await createAliImage(config).refresh(request.request_id)).status,'ready');assert.equal(mock.calls.length,3);
  const text=fs.readFileSync(path.join(folder,request.request_id+'.json'),'utf8');assert(!text.includes('private-signed-result'));assert(!text.includes('server-only-image-secret'));
});

test('未知官方结果域名先阻止下载，认证后精确加白可恢复，不重生成；redirect不携带key',async t=>{
  const host='dashscope-result-confirmed.oss-cn-beijing.aliyuncs.com',url=`https://${host}/image.png?Signature=private`;
  const mock=flow({url}),{adapter,config}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();assert.equal((await adapter.submit(request)).status,'download_failed');assert.equal(mock.calls.length,1);assert.equal(adapter.get(request.request_id).resultHost,host);
  const confirmed=createAliImage({...config,allowedOutputHosts:[...ALI_IMAGE_OUTPUT_HOSTS,host]});assert.equal((await confirmed.refresh(request.request_id)).status,'ready');assert.equal(mock.calls.length,2);assert.equal(mock.calls[1].init.headers,undefined);
  const redirect=flow({download:()=>new Response(null,{status:302,headers:{Location:'https://evil.test/image.png'}})}),other=sandbox(t,{fetchImpl:redirect.fetchImpl}),second=input();assert.equal((await other.adapter.submit(second)).status,'download_failed');assert.equal(redirect.calls.length,2);
});

test('SVG伪装、PNG截断、过大输出或错误像素不能成为ready；局部中断可恢复',async t=>{
  for(const bytes of[Buffer.from('<svg onload="alert(1)"></svg>'),png().subarray(0,png().length-12),png(640,480)]){
    const mock=flow({bytes}),{adapter,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();assert.equal((await adapter.submit(request)).status,'download_failed');assert.deepEqual(fs.readdirSync(path.join(folder,request.request_id)),[]);
  }
  const mock=flow(),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();const link=fs.linkSync;let breakOnce=true;t.mock.method(fs,'linkSync',(...args)=>{if(breakOnce){breakOnce=false;throw Error('mock interrupted finalization');}return link(...args);});
  assert.equal((await adapter.submit(request)).status,'download_failed');assert(JSON.parse(fs.readFileSync(path.join(folder,request.request_id+'.json'))).pendingOutput);assert.equal((await createAliImage(config).refresh(request.request_id)).status,'ready');assert.equal(mock.calls.length,2);
});

test('缺key、非法路径、预算篡改与输出符号链接拒绝，外部用户文件保留',async t=>{
  const mock=flow(),{adapter,config,data,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();await assert.rejects(createAliImage({...config,key:''}).submit(request),error=>error.status===503);await assert.rejects(adapter.submit({...request,request_id:'../unsafe'}));assert.equal(mock.calls.length,0);
  await adapter.submit(request);const output=adapter.asset(request.request_id).file,external=path.join(data,'external.png');fs.renameSync(output,external);fs.symlinkSync(external,output);assert.throws(()=>adapter.asset(request.request_id));assert.equal(adapter.get(request.request_id).status,'download_failed');assert(fs.readFileSync(external).equals(png()));
  const file=path.join(folder,request.request_id+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.accountedCents=0;fs.writeFileSync(file,JSON.stringify(saved));assert.equal(adapter.capabilities().available,false);await assert.rejects(adapter.submit(input()),error=>error.status===503);assert.equal(mock.calls.filter(call=>call.init.method==='POST').length,1);
});
