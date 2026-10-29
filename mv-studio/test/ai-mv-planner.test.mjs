import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createMVPlanner,validateMVPlan} from '../ai-mv-planner.mjs';

const key='unit-test-private-provider-key';
const request=patch=>({request_id:crypto.randomUUID(),project_id:'20000000-0000-4000-8000-000000000001',source_sha256:'a'.repeat(64),source_name:'窗外的潮汐',source_duration:90,start:12,duration:5,instruction:'在月色海边，一个穿银色外套的人把纸飞机放入潮水。安静克制。',lyrics:'海浪把灯火带走',ratio:'16:9',type:'story',...patch});
const response=(count=1,patch={})=>({summary:'纸飞机随潮水远去，人物停在海边。',visualBible:'银色短外套、深色长裤；夜色蓝灰海岸，暖白远灯，写实摄影。两镜保持人物服装和海岸方向一致。',shots:Array.from({length:count},(_,i)=>({label:i?'随潮水远去':'放下纸飞机',prompt:i?'近景跟拍同一纸飞机在蓝灰潮水中漂动，银色外套人物的手离开画面，暖白灯光倒影保持在右侧。':'中景侧拍穿银色短外套与深色长裤的人蹲在蓝灰海岸，将一架白色纸飞机轻放在潮水边，背景右侧有暖白远灯，缓慢推近。'})),...patch});
const envelope=(body=response(),patch={})=>new Response(JSON.stringify({id:'chatcmpl-test',model:'deepseek-flash',usage:{prompt_tokens:90,completion_tokens:80,total_tokens:170},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(body)}}],...patch}),{status:200,headers:{'Content-Type':'application/json'}});
function sandbox(t,options={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'ai-mv-planner-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const config={data,key,fetchImpl:async()=>{throw Error('A test must provide a mock response');},...options};return{data,folder:path.join(data,'ai-mv-plans'),config,planner:createMVPlanner(config)};}

test('真实请求结构仅含文字依据，5秒方案有一个有来源绑定的连续镜头',async t=>{
 let calls=0;const input=request(),{planner,folder}=sandbox(t,{fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+key);const payload=JSON.parse(options.body);assert.equal(payload.model,'deepseek-flash');assert.equal(payload.response_format.type,'json_object');const context=JSON.parse(payload.messages[1].content);assert.equal(context.audio_provided,false);assert.equal(context.source_sha256,input.source_sha256);assert.equal(context.shot_count,1);assert(!JSON.stringify(payload).includes(key));assert(fs.existsSync(path.join(folder,input.request_id+'.json')));return envelope();}});
 const original=JSON.stringify(input),plan=await planner.plan(input);assert.equal(calls,1);assert.equal(JSON.stringify(input),original);assert.equal(plan.project_id,input.project_id);assert.equal(plan.source_sha256,input.source_sha256);assert.equal(plan.start,12);assert.equal(plan.duration,5);assert.equal(typeof plan.visualBible,'string');assert.deepEqual(plan.shots.map(({duration,start,end})=>({duration,start,end})),[{duration:5,start:0,end:5}]);assert(plan.shots[0].prompt.includes('纸飞机'));assert.equal(plan.basis,'lyrics-and-instruction');assert.equal(plan.provider.name,'deepseek');assert.equal(validateMVPlan(plan),true);assert.equal(plan.replayed,false);
 const record=JSON.parse(fs.readFileSync(path.join(folder,input.request_id+'.json')));assert.equal(record.status,'complete');assert.equal(record.response.shots[0].prompt,plan.shots[0].prompt);assert(!JSON.stringify(record).includes(key));
});

test('10秒方案只分配两个五秒镜头；同ID并发/重放/重启均不重复调用',async t=>{
 let calls=0,resolve;const {planner,config}=sandbox(t,{fetchImpl:async()=>{calls++;await new Promise(r=>{resolve=r;});return envelope(response(2));}}),input=request({duration:10,ratio:'9:16'});
 const a=planner.plan(input),b=planner.plan(input);resolve();const[first,second]=await Promise.all([a,b]);assert.equal(calls,1);assert.deepEqual(first.shots.map(s=>[s.start,s.end,s.duration]),[[0,5,5],[5,10,5]]);assert.deepEqual(second.shots,first.shots);assert.equal(second.replayed,true);assert.equal(new Set(first.shots.map(s=>s.id)).size,2);
 const restarted=createMVPlanner({...config,key:'',fetchImpl:async()=>{throw Error('Replay must be local');}});assert.deepEqual(restarted.get(input.request_id).shots,first.shots);const replayed=await restarted.plan(input);assert.equal(replayed.replayed,true);replayed.shots[0].prompt='outside';assert.notEqual(restarted.get(input.request_id).shots[0].prompt,'outside');
 await assert.rejects(()=>planner.plan({...input,instruction:'另一个创意'}),e=>e.code==='MV_PLAN_REQUEST_CONFLICT');
});

test('相同内容新ID重用已完成方案，不产生第二次付费规划',async t=>{
 let calls=0;const {planner}=sandbox(t,{fetchImpl:async()=>{calls++;return envelope();}}),input=request(),first=await planner.plan(input),second=await planner.plan({...input,request_id:crypto.randomUUID()});assert.equal(calls,1);assert.equal(second.id,first.id);assert.equal(second.replayed,true);
});

test('输入严格校验时长、范围、指纹、类型、比例、字段与字符串；无效输入零调用',async t=>{
 let calls=0;const {planner}=sandbox(t,{fetchImpl:async()=>{calls++;return envelope();}});
 for(const patch of [{duration:30},{duration:6},{start:89},{start:NaN},{source_duration:Infinity},{source_sha256:'a'},{request_id:'../bad'},{project_id:'draft'},{type:'preset'},{ratio:'5:8'},{instruction:''},{instruction:key},{instruction:'x'.repeat(4001)},{style:'x'.repeat(501)},{source_name:'bad\nname'},{extra:true},{lyrics:[{start:3,end:2,text:'bad'}]}])await assert.rejects(()=>planner.plan(request(patch)));
 assert.equal(calls,0);assert.equal(planner.get(crypto.randomUUID()),null);assert.throws(()=>planner.get('../bad'));
});

test('已有绝对时间歌词只传入选段相交部分，不捏造音频分析',async t=>{
 let context;const {planner}=sandbox(t,{fetchImpl:async(_url,options)=>{context=JSON.parse(JSON.parse(options.body).messages[1].content);return envelope();}});
 await planner.plan(request({lyrics:[{start:2,end:4,text:'范围外'},{start:11,end:14,text:'范围内'},{start:18,end:20,text:'范围后'}]}));assert(context.lyrics.includes('范围内'));assert(!context.lyrics.includes('范围外'));assert(!context.lyrics.includes('范围后'));assert.equal(context.audio_provided,false);
});

test('模型返回未知字段、错误镜数、超长提示词或听过音频声明均拒绝，不套预设补齐',async t=>{
 const variants=[response(2),response(1,{extra:'unsafe'}),response(1,{shots:[{label:'镜头',prompt:'x'.repeat(1601)}]}),response(1,{shots:[{label:'镜头',prompt:'可见动作',url:'https://example.org/video.mp4'}]}),response(1,{summary:'我已经听完音频，这是结果。'}),response(1,{visualBible:{subject:'object should not pass'}})];
 for(const[index,body]of variants.entries()){let calls=0;const {planner}=sandbox(t,{fetchImpl:async()=>{calls++;return envelope(calls===1?body:response(1));}}),input=request({instruction:'创意 '+index});await assert.rejects(()=>planner.plan(input),e=>e.code==='INVALID_MV_PLAN_RESPONSE'&&e.retryBlocked);assert.equal(calls,1);await assert.rejects(()=>planner.plan(input),e=>e.retryBlocked);assert.equal(calls,1);const repaired=await planner.plan({...input,request_id:crypto.randomUUID()});assert.equal(repaired.shots.length,1);assert.equal(calls,2);}
});

test('断线结果不明时同ID/新ID/重启均阻止盲目再发',async t=>{
 let calls=0;const {planner,config,folder}=sandbox(t,{fetchImpl:async()=>{calls++;throw Error('network '+key);}}),input=request();await assert.rejects(()=>planner.plan(input),e=>e.uncertain&&e.retryBlocked&&!e.message.includes(key));assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(folder,input.request_id+'.json'))).status,'uncertain');
 await assert.rejects(()=>planner.plan(input),e=>e.uncertain&&e.replayed);await assert.rejects(()=>planner.plan({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked);await assert.rejects(()=>createMVPlanner(config).plan({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked);assert.equal(calls,1);
});

test('尚在请求中的相同内容不能换ID提交，响应读取中断也属于未确认',async t=>{
 let calls=0,release;const {planner}=sandbox(t,{fetchImpl:async()=>{calls++;await new Promise(r=>{release=r;});return{ok:true,status:200,headers:new Headers(),body:{async *[Symbol.asyncIterator](){throw Error('stream disconnected');}}};}}),input=request(),pending=planner.plan(input);
 await assert.rejects(()=>planner.plan({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked&&e.uncertain);release();await assert.rejects(()=>pending,e=>e.uncertain);assert.equal(calls,1);
});

test('明确HTTP拒绝可在新ID手动重试，同ID保留失败回执',async t=>{
 let calls=0;const {planner}=sandbox(t,{fetchImpl:async()=>{calls++;return calls===1?new Response('{}',{status:429}):envelope();}}),input=request();await assert.rejects(()=>planner.plan(input),e=>e.code==='MV_PLAN_PROVIDER_REJECTED'&&e.status===429);await assert.rejects(()=>planner.plan(input),e=>e.replayed&&e.retryBlocked);assert.equal(calls,1);const retried=await planner.plan({...input,request_id:crypto.randomUUID()});assert.equal(calls,2);assert.equal(retried.shots.length,1);
});

test('无密钥不发送；5xx、截断、非JSON与超大响应不伪造方案',async t=>{
 let calls=0;const empty=sandbox(t,{key:'',fetchImpl:async()=>{calls++;return envelope();}});await assert.rejects(()=>empty.planner.plan(request()),e=>e.status===503);assert.equal(calls,0);
 const responses=[()=>new Response('{}',{status:500}),()=>envelope(response(),{choices:[{finish_reason:'length',message:{content:'{}'}}]}),()=>new Response('not-json',{status:200}),()=>new Response('x'.repeat(65000),{status:200})];
 for(const make of responses){const {planner}=sandbox(t,{fetchImpl:async()=>make()});await assert.rejects(()=>planner.plan(request()),e=>e.retryBlocked);}
});

test('get与replay校验持久记录内容，损坏或篡改结果不能触发重发',async t=>{
 let calls=0;const {planner,folder}=sandbox(t,{fetchImpl:async()=>{calls++;return envelope();}}),input=request();await planner.plan(input);const file=path.join(folder,input.request_id+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.result.shots[0].prompt='篡改';fs.writeFileSync(file,JSON.stringify(saved));assert.throws(()=>planner.get(input.request_id),e=>e.retryBlocked);await assert.rejects(()=>planner.plan({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked);assert.equal(calls,1);
});

test('null记录或损坏的内容索引不能被当成从未请求而绕过重复保护',async t=>{
 for(const damage of ['record','index']){let calls=0;const {planner,folder}=sandbox(t,{fetchImpl:async()=>{calls++;return envelope();}}),input=request();await planner.plan(input);const record=JSON.parse(fs.readFileSync(path.join(folder,input.request_id+'.json')));const file=damage==='record'?path.join(folder,input.request_id+'.json'):path.join(folder,'content',record.input_hash+'.json');fs.writeFileSync(file,'null');if(damage==='record')assert.throws(()=>planner.get(input.request_id),e=>e.retryBlocked);await assert.rejects(()=>planner.plan({...input,request_id:crypto.randomUUID()}),e=>e.retryBlocked);assert.equal(calls,1);}
});

test('编辑后方案只允许固定五秒连续镜头；持久目录拒绝符号链接',async t=>{
 const {planner,data}=sandbox(t,{fetchImpl:async()=>envelope()}),plan=await planner.plan(request());const edited=structuredClone(plan);edited.shots[0].prompt='用户修改后：黄昏沙漠，红色围巾随风飘动。';assert.equal(validateMVPlan(edited),true);assert.equal(planner.get(plan.id).shots[0].prompt.includes('纸飞机'),true);edited.shots[0].end=6;assert.throws(()=>validateMVPlan(edited));
 const bad=path.join(data,'bad'),target=path.join(data,'target');fs.mkdirSync(bad);fs.mkdirSync(target);fs.symlinkSync(target,path.join(bad,'ai-mv-plans'));assert.throws(()=>createMVPlanner({data:bad,key}),/符号链接/);
});
