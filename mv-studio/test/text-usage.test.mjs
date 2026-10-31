import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTextUsage} from '../text-usage.mjs';
import {createLegacyPlanning} from '../legacy-planning.mjs';
const fixture=t=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'text-limits-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));return data;};
test('quota survives restart and failed attempts; day changes never reset total',async t=>{
 const data=fixture(t),environment={MV_TEXT_DAILY_LIMIT:1,MV_TEXT_TOTAL_LIMIT:2};let time=Date.UTC(2026,10,1),calls=0;
 let gate=createTextUsage({data,environment,now:()=>time});await assert.rejects(gate.run(async()=>{calls++;throw Error('network');}));
 gate=createTextUsage({data,environment,now:()=>time});await assert.rejects(gate.run(async()=>calls++),/今日/);time+=86400000;await gate.run(async()=>calls++);time+=86400000;await assert.rejects(gate.run(async()=>calls++),/累计/);assert.equal(calls,2);
});
test('shared concurrency and rate cap reject before provider; quota holds through response body',async t=>{
 const data=fixture(t),environment={MV_TEXT_MAX_CONCURRENT:1,MV_TEXT_RATE_PER_MINUTE:1};const gate=createTextUsage({data,environment});let release,calls=0;
 const fetch=gate.wrapFetch(async()=>{calls++;return new Response(new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode('{}'));controller.close();};}}));});
 const first=fetch('test');await new Promise(resolve=>setImmediate(resolve));assert.equal((await createTextUsage({data,environment}).wrapFetch(async()=>{calls++;})('test')).status,429);release();assert.equal((await first).status,200);assert.equal((await fetch('test')).status,429);assert.equal(calls,1);
});
test('zero and invalid quotas never silently enable calls',async t=>{
 const data=fixture(t);await assert.rejects(createTextUsage({data,environment:{MV_TEXT_DAILY_LIMIT:0}}).run(async()=>assert.fail()),/额度/);assert.throws(()=>createTextUsage({data,environment:{MV_TEXT_DAILY_LIMIT:'invalid'}}));
});
test('legacy identical requests replay across concurrent callers and restart; uncertain/corrupt records block',async t=>{
 const data=fixture(t);let calls=0,release;const options={data,model:'test',generate:async p=>{calls++;await new Promise(r=>release=r);return {...p,planned:true};}};
 const old=createLegacyPlanning(options),input={id:'test',title:'song'};const a=old.plan(input),b=old.plan(input);release();assert.deepEqual(await a,await b);assert.equal(calls,1);assert.equal((await createLegacyPlanning(options).plan(input)).planned,true);assert.equal(calls,1);
 const bad=createLegacyPlanning({...options,generate:async()=>{calls++;throw Error('lost response');}});await assert.rejects(bad.plan({...input,title:'new'}));await assert.rejects(createLegacyPlanning(options).plan({...input,title:'new'}),/未确认/);assert.equal(calls,2);
 const files=fs.readdirSync(path.join(data,'legacy-planning'));for(const f of files)fs.writeFileSync(path.join(data,'legacy-planning',f),'broken');await assert.rejects(old.plan(input),/未确认/);assert.equal(calls,2);
});
