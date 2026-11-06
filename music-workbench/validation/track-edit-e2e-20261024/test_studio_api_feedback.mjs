import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createCreationRequestRecovery} from './studio-creation-request.js';

const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const api=async('),source.indexOf('\nlet page='));
function makeApi(fetch){const context={fetch};vm.runInNewContext(code+';globalThis.api=api;',context);return context.api;}

test('offline GET shows a readable network message',async()=>{
 const api=makeApi(async()=>{throw new TypeError('Failed to fetch');});
 await assert.rejects(api('/api/jobs'),error=>/网络连接中断/.test(error.message)&&!/Failed to fetch/.test(error.message));
});
test('POST timeout or disconnection is uncertain and never automatically resent',async()=>{
 for(const name of ['TimeoutError','TypeError']){
  let calls=0;const api=makeApi(async()=>{calls++;throw Object.assign(new Error('private transport text'),{name});});
  await assert.rejects(api('/api/jobs',{request_id:'synthetic'}),error=>/暂时无法确认/.test(error.message)&&/检查原任务/.test(error.message)&&!/private transport/.test(error.message));
  assert.equal(calls,1);
 }
});
test('invalid JSON has clear feedback and preserves status, including uncertainty for POST',async()=>{
 const fetch=async()=>({ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token <');}}),api=makeApi(fetch);
 await assert.rejects(api('/api/jobs'),error=>error.status===502&&error.responseInvalid===true&&/服务返回异常/.test(error.message)&&!/Unexpected token/.test(error.message));
 await assert.rejects(api('/api/jobs',{}),error=>error.status===502&&/检查原任务/.test(error.message));
});

test('invalid 404 never authorizes continuing or cancelling an uncertain request',async()=>{
 const key='osmanthus-direct-generation-request',id='11111111-1111-4111-8111-111111111111',values=new Map([[key,JSON.stringify({id,payload:{mode:'simple',prompt:'test'}})]]),calls=[];
 const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const api=async(path,body)=>{calls.push({path,body});throw Object.assign(new Error('服务返回异常'),{status:404,responseInvalid:true});};
 const recovery=createCreationRequestRecovery({api,storage});
 for(const action of ['inspect','continue','cancel'])await assert.rejects(recovery[action](),/服务返回异常/);
 assert.equal(recovery.state.phase,'unknown');assert.ok(values.has(key));assert.equal(calls.length,3);assert.ok(calls.every(c=>c.body===undefined));
});

test('invalid 422 does not discard an uncertain lyric request identity',async()=>{
 const fn=source.slice(source.indexOf('async function generate('),source.indexOf('async function writeLyrics(')),values=new Map(),calls=[],id='11111111-1111-4111-8111-111111111111';
 const context={creationRecovery:{state:{pending:null}},creating:false,lyricsRequest:null,instrumental:false,mode:'advanced',creationBody:()=>({mode:'advanced',lyrics:'测试歌词'}),updateGenerateButton:()=>{},$:()=>({}),crypto:{randomUUID:()=>id},drafts:[],lyricDraftId:null,
  localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},api:async(path,body)=>{calls.push({path,body});throw Object.assign(new Error('服务返回异常'),{status:422,responseInvalid:true});},showDraftReview:()=>{},renderHomeCreation:()=>{}};
 vm.runInNewContext(fn+';globalThis.result=generate();',context);await assert.rejects(context.result,/服务返回异常/);
 const saved=JSON.parse(values.get('osmanthus-pending-lyric-start'));assert.equal(saved.request_id,id);assert.equal(calls.length,1);
});
test('server messages and HTTP status are retained, successful JSON is returned',async()=>{
 const errors=makeApi(async()=>({ok:false,status:422,json:async()=>({error:'请填写歌词。'})}));
 await assert.rejects(errors('/api/jobs',{}),error=>error.status===422&&error.message==='请填写歌词。');
 const success=makeApi(async()=>({ok:true,status:200,json:async()=>({id:'synthetic'})}));
 assert.equal((await success('/api/jobs')).id,'synthetic');
});
