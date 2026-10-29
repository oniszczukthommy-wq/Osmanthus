import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {createCanvasPrompts} from '../canvas-prompts.mjs';
test('long template is compiled once in full, short prompt is untouched, persisted data contains no key',async()=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'prompts-'));const calls=[];try{const api=createCanvasPrompts({data,key:'private-test-key',model:'test',materials:{asset:()=>null},fetchImpl:async(url,request)=>{calls.push({url,body:JSON.parse(request.body)});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({prompt:'完整保留角色与镜头要求'})}}]}));}});assert.equal((await api.compile({request_id:crypto.randomUUID(),prompt:'猫坐窗边'})).prompt,'猫坐窗边');const input={request_id:crypto.randomUUID(),prompt:'长模板'.repeat(1200),kind:'video'};const r=await api.compile(input);assert.equal(r.compiled,true);assert.equal(JSON.parse(calls[0].body.messages[1].content).instruction,input.prompt);assert.deepEqual(await api.compile(input),r);assert.equal(calls.length,1);assert(!fs.readFileSync(path.join(data,'canvas-prompts',input.request_id+'.json'),'utf8').includes('private-test-key'));}finally{fs.rmSync(data,{recursive:true,force:true});}});

test('concurrent identical compilation shares one call and source signature remains immutable',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'prompts-concurrent-'));let calls=0,finish;try{
  const api=createCanvasPrompts({data,key:'test-only',materials:{asset:()=>null},fetchImpl:async()=>{calls++;return await new Promise(resolve=>{finish=()=>resolve(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({prompt:'完整执行描述'})}}]})));});}});
  const input={request_id:crypto.randomUUID(),prompt:'完整长模板'.repeat(400)};const first=api.compile(input),second=api.compile(input),same=api.compile({...input,request_id:crypto.randomUUID()});
  await assert.rejects(api.compile({...input,prompt:'另一份完整长模板'.repeat(400)}),/不能改变/);assert.equal(calls,1);finish();assert.deepEqual(await second,await first);assert.deepEqual(await same,await first);
  const short={request_id:crypto.randomUUID(),prompt:'短文字'};await api.compile(short);await assert.rejects(api.compile({...short,prompt:'修改文字'}),/不能改变/);assert.equal(calls,1);
 }finally{fs.rmSync(data,{recursive:true,force:true});}
});

test('uncertain compilation preserves original text and cannot silently repeat under another request id',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'prompts-uncertain-'));let calls=0;try{
  const api=createCanvasPrompts({data,key:'test-only',materials:{asset:()=>null},fetchImpl:async()=>{calls++;throw Error('connection interrupted');}}),input={request_id:crypto.randomUUID(),prompt:'完整长模板'.repeat(400)};
  await assert.rejects(api.compile(input),e=>e.retryBlocked===true&&e.uncertain===true);await assert.rejects(api.compile({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked===true);assert.equal(calls,1);
 }finally{fs.rmSync(data,{recursive:true,force:true});}
});

const reply=prompt=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({prompt})}}],usage:{prompt_tokens:20,completion_tokens:30}}));
function fixture(t,fetchImpl){const data=fs.mkdtempSync(path.join(os.tmpdir(),'prompts-v3-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const options={data,key:'private-test-key',materials:{asset:()=>null},fetchImpl};return{data,options,api:createCanvasPrompts(options),file:id=>path.join(data,'canvas-prompts',id+'.json'),state(id){return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}};}
const longInput=patch=>({request_id:crypto.randomUUID(),prompt:'萌宠发布会：保留主持猫、发光展台、完整动作顺序、屏幕文字与结尾。'.repeat(50),kind:'video',...patch});

test('oversized complete candidate compacts once with full source/candidate, persists attempts before POST and replays without more requests',async t=>{
 const posts=[],oversized='完整候选、猫与展台及镜头顺序。'.repeat(90),compact='紧凑且完整的执行描述。'.repeat(50),input=longInput();let f;
 f=fixture(t,async(_url,request)=>{const body=JSON.parse(request.body),stored=f.state(input.request_id);posts.push(body);assert.equal(stored.attempts,posts.length);assert.equal(stored.sourcePrompt,input.prompt);if(posts.length===1){assert.equal(stored.status,'pending');assert(body.messages[0].content.includes('300–500'));assert(body.messages[0].content.includes('总字符'));assert.equal(JSON.parse(body.messages[1].content).instruction,input.prompt);return reply(oversized);}assert.equal(stored.status,'compacting');assert.deepEqual(stored.candidates,[oversized]);const user=JSON.parse(body.messages[1].content);assert.equal(user.instruction,input.prompt);assert.equal(user.candidate,oversized);assert.equal(user.purpose,'compact');return reply(compact);});
 const first=await f.api.compile(input);assert.equal(first.prompt,compact);assert.equal(first.status,'ready');assert.equal(first.compacted,true);assert.equal(first.attempts,2);assert.equal(first.compilerVersion,'v3');assert.deepEqual(first.candidates,[oversized,compact]);assert.equal(first.responses.length,2);assert.equal(posts.length,2);
 const restarted=createCanvasPrompts({...f.options,fetchImpl:()=>{throw Error('restart must use saved result');}});assert.deepEqual(await restarted.compile(input),first);assert.deepEqual(await restarted.compile({...input,request_id:crypto.randomUUID()}),first);assert.equal(posts.length,2);assert(!fs.readFileSync(f.file(input.request_id),'utf8').includes('private-test-key'));
});

test('second request timeout remains uncertain with its full first candidate and blocks all automatic replays after restart',async t=>{
 let posts=0;const candidate='需要保留的完整首轮候选。'.repeat(120),input=longInput(),f=fixture(t,async()=>{if(++posts===1)return reply(candidate);throw new DOMException('timeout','TimeoutError');});
 await assert.rejects(f.api.compile(input),e=>e.uncertain===true&&e.retryBlocked===true);const stored=f.state(input.request_id);assert.equal(stored.status,'uncertain');assert.equal(stored.stage,'compact');assert.equal(stored.attempts,2);assert.equal(stored.sourcePrompt,input.prompt);assert.deepEqual(stored.candidates,[candidate]);
 const restarted=createCanvasPrompts({...f.options,fetchImpl:()=>{posts++;throw Error('must not resend');}});await assert.rejects(restarted.compile(input),e=>e.uncertain&&e.retryBlocked);await assert.rejects(restarted.compile({...input,request_id:crypto.randomUUID()}),e=>e.uncertain&&e.retryBlocked);assert.equal(posts,2);
});

test('second complete oversized candidate definitively fails, keeps both candidates, never starts a third request',async t=>{
 const candidates=['首轮完整内容'.repeat(250),'第二轮仍然完整但太长'.repeat(180)],input=longInput();let posts=0;const f=fixture(t,async()=>reply(candidates[(posts++)%candidates.length]));
 await assert.rejects(f.api.compile(input),e=>e.definitiveFailure===true&&!e.uncertain&&!e.retryBlocked&&/仍超过1100/.test(e.message));const stored=f.state(input.request_id);assert.equal(stored.status,'failed');assert.equal(stored.definitiveFailure,true);assert.equal(stored.attempts,2);assert.deepEqual(stored.candidates,candidates);assert.equal(stored.sourcePrompt,input.prompt);
 const restarted=createCanvasPrompts({...f.options,fetchImpl:()=>{posts++;throw Error('same ID must not resend');}});await assert.rejects(restarted.compile(input),e=>e.definitiveFailure&&!e.uncertain&&!e.retryBlocked);assert.equal(posts,2);await assert.rejects(f.api.compile({...input,request_id:crypto.randomUUID()}),e=>e.definitiveFailure&&!e.uncertain);assert.equal(posts,4,'新的明确重试意图最多再做两次文本请求');
});

test('confirmed HTTP/JSON/output failures are failed, incomplete network body remains uncertain',async t=>{
 for(const fetcher of [async()=>new Response('service error',{status:503}),async()=>new Response('not json'),async()=>new Response(JSON.stringify({choices:[{message:{content:'{"prompt":null}'}}]})),async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"prompt":"已结束但可能不完整"}'}}]}))]){const f=fixture(t,fetcher),input=longInput();await assert.rejects(f.api.compile(input),e=>e.definitiveFailure&&!e.uncertain&&!e.retryBlocked);assert.equal(f.state(input.request_id).status,'failed');assert.equal(f.state(input.request_id).attempts,1);}
 const f=fixture(t,async()=>({ok:true,status:200,text:async()=>{throw Error('body connection interrupted');}})),input=longInput();await assert.rejects(f.api.compile(input),e=>e.uncertain&&e.retryBlocked);assert.equal(f.state(input.request_id).status,'uncertain');
});

test('v3 bypasses legacy failure signature for a new ID, preserves old ready cache and never retries an unknown old ID',async t=>{
 let posts=0;const f=fixture(t,async()=>{posts++;return reply('新的完整压缩结果');}),input=longInput(),legacySignature=crypto.createHash('sha256').update(JSON.stringify({prompt:input.prompt,kind:input.kind,reverse:false,refs:[]})).digest('hex'),oldId=crypto.randomUUID();
 fs.writeFileSync(f.file(oldId),JSON.stringify({id:oldId,signature:legacySignature,status:'uncertain',billable:true,error:'旧版本结果未知'}));await assert.rejects(f.api.compile({...input,request_id:oldId}),e=>e.uncertain&&e.retryBlocked);assert.equal(posts,0);const fresh=await f.api.compile(input);assert.equal(fresh.status,'ready');assert.equal(fresh.compilerVersion,'v3');assert.notEqual(fresh.signature,legacySignature);assert.equal(posts,1);assert.equal(f.state(oldId).status,'uncertain');
 const readyInput=longInput({prompt:'另一份应保留旧ready的完整源模板'.repeat(140)}),readyId=crypto.randomUUID(),readySignature=crypto.createHash('sha256').update(JSON.stringify({prompt:readyInput.prompt,kind:readyInput.kind,reverse:false,refs:[]})).digest('hex'),legacyReady={id:readyId,signature:readySignature,status:'ready',prompt:'旧版本已验证的执行描述',compiled:true,billable:true};fs.writeFileSync(f.file(readyId),JSON.stringify(legacyReady));assert.deepEqual(await f.api.compile(readyInput),legacyReady);assert.deepEqual(await f.api.compile({...readyInput,request_id:readyId}),legacyReady);assert.equal(posts,1);
});

test('50-call budget counts each compaction attempt; short prompts remain free even at the cap',async t=>{
 let posts=0;const f=fixture(t,async()=>++posts===1?reply('首轮太长'.repeat(300)):reply('压缩后完整结果'));
 for(let n=0;n<24;n++){const id=crypto.randomUUID();fs.writeFileSync(f.file(id),JSON.stringify({id,status:'ready',billable:true,attempts:2,signature:'older-'+n}));}
 const compiled=await f.api.compile(longInput());assert.equal(compiled.attempts,2);assert.equal(posts,2);await assert.rejects(f.api.compile(longInput({prompt:'下一份独立长模板'.repeat(180)})),e=>e.status===402&&e.definitiveFailure);assert.equal(posts,2);
 const short=await f.api.compile({request_id:crypto.randomUUID(),prompt:'  不裁剪的短文字  '});assert.equal(short.prompt,'不裁剪的短文字');assert.equal(short.sourcePrompt,'  不裁剪的短文字  ');assert.equal(short.compiled,false);assert.equal(short.billable,false);assert.equal(short.attempts,0);assert.equal(posts,2);
});

test('last remaining request cannot fund a second compaction and fails before that POST',async t=>{
 let posts=0;const f=fixture(t,async()=>{posts++;return reply('完整长候选'.repeat(250));});
 for(let n=0;n<49;n++){const id=crypto.randomUUID();fs.writeFileSync(f.file(id),JSON.stringify({id,status:'ready',billable:true,signature:'legacy-'+n}));}
 const input=longInput();await assert.rejects(f.api.compile(input),e=>e.status===402&&e.definitiveFailure&&!e.uncertain);assert.equal(posts,1);const record=f.state(input.request_id);assert.equal(record.status,'failed');assert.equal(record.attempts,1);assert.equal(record.candidates.length,1);assert.equal(record.sourcePrompt,input.prompt);
});

test('generation records definitive compiler validation failure as failed and never reaches a video provider',async t=>{
 const {createCanvasGeneration}=await import('../canvas-generation.mjs');let posts=0,providerCalls=0;const f=fixture(t,async()=>{posts++;return reply('仍然超过执行接口上限的完整候选。'.repeat(90));}),adapter={capabilities:()=>({available:true}),get:()=>null,submit:async()=>{providerCalls++;throw Error('video provider must not be reached');}};
 const generation=createCanvasGeneration({data:f.data,prompts:f.api,materials:f.options.materials,video:adapter,imageVideo:adapter,image:adapter});
 try{const job=generation.submit({...longInput(),project_id:crypto.randomUUID(),duration:5,ratio:'16:9'});let result;for(let n=0;n<100;n++){result=generation.get(job.id);if(['failed','uncertain','ready'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(result.status,'failed');assert.match(result.message,/仍超过\d+字符硬上限/);assert.equal(posts,2);assert.equal(providerCalls,0);}finally{generation.close();}
});

test('v3 accepts a complete 1118-character first candidate under the 1500 I2V limit without paying for compaction',async t=>{
 let posts=0;const candidate='候'.repeat(1118),input=longInput({prompt:'源'.repeat(1506),max_chars:1500}),f=fixture(t,async(url,request)=>{posts++;const body=JSON.parse(request.body);assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(JSON.parse(body.messages[1].content).max_chars,1500);assert(body.messages[0].content.includes('硬上限1500'));return reply(candidate);}),api=createCanvasPrompts({...f.options,aliKey:'fake-ali-key'});
 const result=await api.compile(input);assert.equal(result.prompt,candidate);assert.equal(result.attempts,1);assert.equal(result.provider,'deepseek-flash');assert.equal(result.compacted,false);assert.equal(posts,1);assert.equal(result.max_chars,1500);assert.equal(result.compactProvider,'aliyun:qwen3.5-flash');
});

test('800-character limit routes only its second request to Qwen pure text and persists each actual provider before POST',async t=>{
 const input=longInput({prompt:'源'.repeat(1506),max_chars:800}),candidate='候'.repeat(1118),short='紧'.repeat(480),calls=[];let f;
 f=fixture(t,async(url,request)=>{const body=JSON.parse(request.body),state=f.state(input.request_id);calls.push({url,body});assert.equal(state.requests.length,calls.length);assert.equal(state.requests.at(-1).provider,body.model);assert.equal(typeof body.messages[1].content,'string');assert(!JSON.stringify(body.messages).includes('image_url'));
  if(calls.length===1){assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});return reply(candidate);}
  assert.equal(url,'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');assert.equal(body.model,'qwen3.5-flash');assert.equal(body.enable_thinking,false);assert.equal(body.thinking,undefined);assert.equal(state.status,'compacting');assert.equal(state.attempts,2);assert.equal(state.requests[1].service,'aliyun');const user=JSON.parse(body.messages[1].content);assert.equal(user.instruction,input.prompt);assert.equal(user.candidate,candidate);assert.equal(user.max_chars,800);assert(body.messages[0].content.includes('最多600'));return reply(short);
 });
 const api=createCanvasPrompts({...f.options,aliKey:'fake-ali-key',workspace:'test-workspace'}),ready=await api.compile(input);assert.equal(ready.prompt,short);assert.equal(ready.provider,'qwen3.5-flash');assert.equal(ready.service,'aliyun');assert.deepEqual(ready.requests.map(r=>r.provider),['deepseek-flash','qwen3.5-flash']);assert.deepEqual(ready.responses.map(r=>r.provider),['deepseek-flash','qwen3.5-flash']);assert.equal(calls.length,2);assert(!fs.readFileSync(f.file(input.request_id),'utf8').includes('fake-ali-key'));
 const restarted=createCanvasPrompts({...f.options,aliKey:'fake-ali-key',workspace:'test-workspace',fetchImpl:()=>{throw Error('ready must replay');}});assert.deepEqual(await restarted.compile(input),ready);
});

test('missing Ali key uses DeepSeek for the sole compaction; Qwen timeout blocks instead of falling back to a third call',async t=>{
 const input=longInput({max_chars:800}),calls=[],f=fixture(t,async(url,request)=>{calls.push({url,body:JSON.parse(request.body)});return reply(calls.length===1?'长'.repeat(1118):'短'.repeat(500));});const ready=await f.api.compile(input);assert.equal(ready.compactProvider,'deepseek:deepseek-flash');assert.equal(ready.provider,'deepseek-flash');assert.equal(calls.length,2);assert(calls.every(c=>c.url==='https://api.deepseek.com/chat/completions'));assert(calls.every(c=>c.body.model==='deepseek-flash'));
 let count=0;const g=fixture(t,async()=>{if(++count===1)return reply('长'.repeat(1118));throw new DOMException('qwen timeout','TimeoutError');}),qwen=createCanvasPrompts({...g.options,aliKey:'fake-ali-key'}),other=longInput({max_chars:800});await assert.rejects(qwen.compile(other),e=>e.uncertain&&e.retryBlocked);const state=g.state(other.request_id);assert.equal(state.requests[1].provider,'qwen3.5-flash');assert.equal(state.requests[1].service,'aliyun');assert.equal(state.attempts,2);assert.equal(state.status,'uncertain');const restarted=createCanvasPrompts({...g.options,aliKey:'fake-ali-key',fetchImpl:()=>{count++;throw Error('must not retry');}});await assert.rejects(restarted.compile(other),e=>e.uncertain);await assert.rejects(restarted.compile({...other,request_id:crypto.randomUUID()}),e=>e.uncertain);assert.equal(count,2);
});

test('v3 signature binds model limit and compactor, bypasses v2 failed cache, and safely reuses only verified v2 length candidates',async t=>{
 const input=longInput({prompt:'源'.repeat(1506),max_chars:1500}),candidate='候'.repeat(1118);let posts=0;const f=fixture(t,async()=>{posts++;return reply('短结果');}),oldId=crypto.randomUUID(),signature=crypto.createHash('sha256').update(JSON.stringify({prompt:input.prompt,kind:'video',reverse:false,refs:[],compilerVersion:'v2'})).digest('hex');
 const original={id:oldId,signature,compilerVersion:'v2',status:'failed',definitiveFailure:true,error:'已完成一次文本压缩，结果仍超过1100字符硬上限',sourcePrompt:input.prompt,kind:'video',reverse:false,billable:true,attempts:2,references:[],candidates:[candidate,candidate],responses:[{stage:'compile',provider:'deepseek-flash',text:JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({prompt:candidate})}}]})}]};fs.writeFileSync(f.file(oldId),JSON.stringify(original));
 const ready=await f.api.compile(input);assert.equal(ready.prompt,candidate);assert.equal(ready.attempts,0);assert.equal(ready.billable,false);assert.equal(ready.reusedFrom,oldId);assert.equal(ready.provider,'deepseek-flash');assert.equal(posts,0);assert.deepEqual(f.state(oldId),original,'原失败审计未修改');
 const tighter=await f.api.compile({...input,request_id:crypto.randomUUID(),max_chars:800});assert.equal(tighter.prompt,'短结果');assert.equal(tighter.attempts,1);assert.notEqual(tighter.signature,ready.signature);assert.equal(posts,1);
 const ali=createCanvasPrompts({...f.options,aliKey:'fake-ali-key'}),different=await ali.compile({...input,request_id:crypto.randomUUID(),max_chars:800});assert.notEqual(different.signature,tighter.signature);assert.equal(different.compactProvider,'aliyun:qwen3.5-flash');assert.equal(posts,2);
});

test('unknown v2 results and unfinished/mismatched candidates cannot be reused as ready, max_chars validates before any POST',async t=>{
 for(const mutate of [record=>{record.status='uncertain';},record=>{record.sourcePrompt+='改变';},record=>{record.references=[{material_id:crypto.randomUUID(),sha256:'changed'}];},record=>{const raw=JSON.parse(record.responses[0].text);raw.choices[0].finish_reason='length';record.responses[0].text=JSON.stringify(raw);}]){
  let posts=0;const input=longInput({prompt:'源'.repeat(1506),max_chars:1500}),f=fixture(t,async()=>{posts++;return reply('新的安全结果');}),id=crypto.randomUUID(),candidate='候'.repeat(1118),signature=crypto.createHash('sha256').update(JSON.stringify({prompt:input.prompt,kind:'video',reverse:false,refs:[],compilerVersion:'v2'})).digest('hex'),record={id,signature,compilerVersion:'v2',status:'failed',definitiveFailure:true,error:'结果仍超过1100字符硬上限',sourcePrompt:input.prompt,kind:'video',reverse:false,references:[],attempts:2,candidates:[candidate],responses:[{stage:'compile',provider:'deepseek-flash',text:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({prompt:candidate})}}]})}]};mutate(record);fs.writeFileSync(f.file(id),JSON.stringify(record));const ready=await f.api.compile(input);assert.equal(ready.prompt,'新的安全结果');assert.equal(ready.reusedFrom,undefined);assert.equal(posts,1);
 }
 const f=fixture(t,()=>{throw Error('invalid input must not post');});for(const max_chars of [399,1501,800.5,'1500',NaN])await assert.rejects(f.api.compile(longInput({max_chars})),/max_chars/);
});

test('confirmed HTTP429 allows a new explicit request ID retry while replaying its failed ID never repeats',async t=>{
 let posts=0;const input=longInput(),f=fixture(t,async()=>++posts===1?new Response('rate limited',{status:429}):reply('新的明确重试已完成'));
 await assert.rejects(f.api.compile(input),e=>e.definitiveFailure&&!e.uncertain);assert.equal(f.state(input.request_id).status,'failed');assert.equal(posts,1);await assert.rejects(f.api.compile(input),e=>e.definitiveFailure&&!e.uncertain);assert.equal(posts,1);
 const restarted=createCanvasPrompts(f.options),ready=await restarted.compile({...input,request_id:crypto.randomUUID()});assert.equal(ready.status,'ready');assert.equal(ready.attempts,1);assert.equal(posts,2);assert.equal(f.state(input.request_id).status,'failed');
});
