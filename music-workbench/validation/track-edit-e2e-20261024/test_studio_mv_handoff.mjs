import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
const start=source.indexOf('let mvLaunching=false;'),end=source.indexOf('function expandLyrics()',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
const songId='20000000-0000-4000-8000-000000000002',legacyId='10000000-0000-4000-8000-000000000001';
const base={source_kind:'current_mix',revision:4,fingerprint:'a'.repeat(64),metadata_fingerprint:'b'.repeat(64)};
const key=(prefix,meta=base.metadata_fingerprint)=>[prefix,songId,base.source_kind,base.revision,base.fingerprint,...(prefix.endsWith('v3')?[meta]:[])].join('-');

function fixture({previous,legacy=legacyId,createError}={}){
 const data=new Map();if(legacy)data.set(key('osmanthus-mv-v2'),legacy);
 const requests=[],navigations=[];
 const context={songMetadata:()=>({id:songId}),engine:{settle:async()=>true,getProject:()=>({id:songId,revision:base.revision,fingerprint:base.fingerprint})},
  all:()=>[],localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},crypto:webcrypto,TextEncoder,
  window:{},player:{pause(){}},location:{assign:url=>navigations.push(url)},
  api:async(path,body)=>{requests.push({path,body});if(path.startsWith('/api/mv/source/'))return {...base};
   if(path===`/api/mv/handoffs/${legacyId}`){if(previous instanceof Error)throw previous;return previous;}
   if(path==='/api/mv/handoffs'){if(createError)throw createError;return{url:`/mv/?music=${body.request_id}#canvas`};}
   throw Error('unexpected request '+path);}};
 vm.createContext(context);vm.runInContext(code,context);
 return {data,requests,navigations,context,run:()=>vm.runInContext(`openMV('${songId}')`,context)};
}

test('matching previous metadata resumes the existing handoff and canvas',async()=>{
 const f=fixture({previous:{...base,project_id:songId}});await f.run();
 assert.equal(f.requests.at(-1).body.request_id,legacyId);
 assert.equal(f.requests.at(-1).body.metadata_fingerprint,base.metadata_fingerprint);
 assert.equal(f.data.get(key('osmanthus-mv-v3')),legacyId);
 assert.equal(f.data.get(key('osmanthus-mv-v2')),legacyId);
 assert.equal(f.navigations[0],`/mv/?music=${legacyId}#canvas`);
});

test('changed lyrics metadata creates a new handoff without deleting old identity',async()=>{
 const f=fixture({previous:{...base,project_id:songId,metadata_fingerprint:'c'.repeat(64)}});await f.run();
 const freshId=f.requests.at(-1).body.request_id;
 assert.match(freshId,/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.notEqual(freshId,legacyId);
 assert.equal(f.data.get(key('osmanthus-mv-v2')),legacyId);
 assert.equal(f.data.get(key('osmanthus-mv-v3')),freshId);
 await f.run();assert.equal(f.requests.at(-1).body.request_id,freshId);
 assert.equal(f.requests.filter(x=>x.path===`/api/mv/handoffs/${legacyId}`).length,1);
});

test('legacy record for a different song never overwrites or resumes that canvas',async()=>{
 const f=fixture({previous:{...base,project_id:'40000000-0000-4000-8000-000000000004'}});await f.run();
 assert.notEqual(f.requests.at(-1).body.request_id,legacyId);
 assert.equal(f.data.get(key('osmanthus-mv-v2')),legacyId);
});

test('unavailable legacy metadata fails safely without allocating a new ID',async()=>{
 const error=Object.assign(Error('无法连接'),{status:502});
 const f=fixture({previous:error});await assert.rejects(f.run(),/无法连接/);
 assert.equal(f.data.get(key('osmanthus-mv-v2')),legacyId);
 assert.equal(f.data.has(key('osmanthus-mv-v3')),false);
 assert.equal(f.requests.some(x=>x.path==='/api/mv/handoffs'),false);
});

test('invalid 404 response does not silently abandon legacy canvas',async()=>{
 const error=Object.assign(Error('无效响应'),{status:404,responseInvalid:true});
 const f=fixture({previous:error});await assert.rejects(f.run(),/无效响应/);
 assert.equal(f.data.has(key('osmanthus-mv-v3')),false);
 assert.equal(f.requests.some(x=>x.path==='/api/mv/handoffs'),false);
});

test('missing legacy record is kept and a separate handoff is allocated',async()=>{
 const f=fixture({previous:Object.assign(Error('不存在'),{status:404})});await f.run();
 assert.equal(f.data.get(key('osmanthus-mv-v2')),legacyId);
 assert.notEqual(f.requests.at(-1).body.request_id,legacyId);
 assert.equal(f.requests.at(-1).body.request_id,f.data.get(key('osmanthus-mv-v3')));
});

test('failed POST keeps the request ID for safe retry',async()=>{
 const f=fixture({legacy:null,createError:Error('结果未知')});
 await assert.rejects(f.run(),/结果未知/);await assert.rejects(f.run(),/结果未知/);
 const calls=f.requests.filter(x=>x.path==='/api/mv/handoffs');
 assert.equal(calls.length,2);assert.equal(calls[0].body.request_id,calls[1].body.request_id);
 assert.equal(f.data.get(key('osmanthus-mv-v3')),calls[0].body.request_id);
});

test('concurrent tabs derive the same ID for the same song and metadata',async()=>{
 const left=fixture({legacy:null}),right=fixture({legacy:null});
 await Promise.all([left.run(),right.run()]);
 assert.equal(left.requests.at(-1).body.request_id,right.requests.at(-1).body.request_id);
});

test('missing Web Crypto fails safely without posting or generating a random ID',async()=>{
 const f=fixture({legacy:null});f.context.crypto={};
 await assert.rejects(f.run(),/Web Crypto/);
 assert.equal(f.data.has(key('osmanthus-mv-v3')),false);
 assert.equal(f.requests.some(x=>x.path==='/api/mv/handoffs'),false);
});

test('existing MV editors are reminded to save before starting a handoff',async()=>{
 const html=await readFile(new URL('./studio.html',import.meta.url),'utf8');
 const build=await readFile(new URL('./studio_build.py',import.meta.url),'utf8');
 const notice='创作 MV：如另一页面正在编辑画布，请先保存。';
 assert.equal(html.split(notice).length-1,1);
 assert.equal(build.split(notice).length-1,1);
 assert.match(source,/创作 MV 前，如另一页面正在编辑画布，请先保存/);
 assert.match(source,/如另一页面正在编辑画布，请先保存/);
});
