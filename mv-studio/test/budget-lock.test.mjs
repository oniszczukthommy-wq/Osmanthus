import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createBudgetLock,recoverBudgetLock} from '../budget-lock.mjs';
import {createAliImage} from '../aliyun-image.mjs';
import {createAliVideo} from '../aliyun-video.mjs';
import {createAliSpeech} from '../aliyun-speech.mjs';

const helper=new URL('../budget-lock.mjs',import.meta.url).href;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osmanthus-budget-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const seed=root=>{const token=crypto.randomUUID(),dir=path.join(root,'.budget-lock');fs.mkdirSync(dir);const file=path.join(dir,`owner-${process.pid}-${token}.json`);fs.writeFileSync(file,JSON.stringify({schema:'osmanthus-budget-lock-v1',pid:process.pid,host:os.hostname(),token}));return {dir,file};};
function crashedLock(root){
  const program=`import {createBudgetLock} from ${JSON.stringify(helper)}; createBudgetLock({root:process.argv[1]}).run(()=>process.exit(0));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',program,root],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert(fs.existsSync(path.join(root,'.budget-lock')));
}

test('new lock records live owner and never expires by age or explicit recovery',t=>{
  const root=fixture(t),guard=createBudgetLock({root});
  guard.run(()=>{
    const status=createBudgetLock({root}).status();assert.equal(status.state,'busy');assert.equal(status.ownerPid,process.pid);
    fs.utimesSync(path.join(root,'.budget-lock'),new Date(0),new Date(0));
    assert.equal(guard.status().available,false);
    assert.throws(()=>createBudgetLock({root}).run(()=>assert.fail('must remain exclusive')),e=>e.status===409);
    assert.throws(()=>recoverBudgetLock({root,confirmServicesStopped:true}),/仍运行/);
  });
  assert.equal(guard.status().available,true);
  assert.throws(()=>guard.run(()=>{throw Error('fixture failure');}),/fixture failure/);
  assert.equal(guard.status().available,true);
});

test('legacy/invalid owner is unavailable until explicit offline quarantine; no task or budget bytes change',t=>{
  const root=fixture(t),guard=createBudgetLock({root}),record=path.join(root,'original.json');
  fs.writeFileSync(record,'original budget and uncertain receipt');fs.mkdirSync(path.join(root,'.budget-lock'));
  const state=guard.status();assert.equal(state.available,false);assert.equal(state.recoveryNeeded,true);assert.match(state.reason,/停止所有/);
  assert.throws(()=>recoverBudgetLock({root}),/显式确认/);
  const recovered=recoverBudgetLock({root,confirmServicesStopped:true});assert(fs.statSync(recovered.archived).isDirectory());
  assert.equal(fs.readFileSync(record,'utf8'),'original budget and uncertain receipt');assert.equal(guard.status().available,true);
  fs.mkdirSync(path.join(root,'.budget-lock'));fs.writeFileSync(path.join(root,'.budget-lock','broken'),'bad');
  assert.equal(guard.status().available,false);
  const invalid=recoverBudgetLock({root,confirmServicesStopped:true});assert.equal(fs.readFileSync(path.join(invalid.archived,'broken'),'utf8'),'bad');
});

test('dead child process lock is recovered but foreign host and unverified PID are preserved',t=>{
  const root=fixture(t);crashedLock(root);const guard=createBudgetLock({root});assert.equal(guard.status().available,true);
  const {file}=seed(root),original=JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file,JSON.stringify({...original,host:'another-host.invalid'}));
  assert.equal(guard.status().state,'foreign_owner');assert(fs.existsSync(file));
  fs.writeFileSync(file,JSON.stringify(original));
  t.mock.method(process,'kill',()=>{throw Object.assign(Error('access denied'),{code:'EPERM'});});
  assert.equal(guard.status().state,'unverified');assert(fs.existsSync(file));
});

test('live child stays protected; killing only that test child permits safe recovery',async t=>{
  const root=fixture(t),program=`import {createBudgetLock} from ${JSON.stringify(helper)}; createBudgetLock({root:process.argv[1]}).run(()=>{console.log('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',program,root],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  await once(child.stdout,'data');const guard=createBudgetLock({root});assert.equal(guard.status().state,'busy');
  const exited=once(child,'exit');child.kill();await exited;
  assert.equal(guard.status().available,true);
});

test('competing reapers never remove a replacement owner or overlap accounting transactions',async t=>{
  const root=fixture(t);crashedLock(root);const counter=path.join(root,'count');fs.writeFileSync(counter,'0');
  const program=`import fs from 'node:fs';import path from 'node:path';import {createBudgetLock} from ${JSON.stringify(helper)};
    const root=process.argv[1],lock=createBudgetLock({root}),sleep=n=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,n);
    for(let n=0;n<500;n++){try{lock.run(()=>{const critical=path.join(root,'critical');const fd=fs.openSync(critical,'wx');try{const count=path.join(root,'count'),value=Number(fs.readFileSync(count,'utf8'));sleep(8);fs.writeFileSync(count,String(value+1));}finally{fs.closeSync(fd);fs.unlinkSync(critical);}});process.exit(0);}catch(e){if(e.code!=='BUDGET_BUDGET_LOCKED')throw e;sleep(3);}}throw Error('lock never released');`;
  const children=Array.from({length:6},()=>spawn(process.execPath,['--input-type=module','-e',program,root],{stdio:['ignore','ignore','pipe']}));
  t.after(()=>children.forEach(child=>{if(child.exitCode===null&&child.signalCode===null)child.kill();}));
  await Promise.all(children.map(async child=>{let errors='';child.stderr.on('data',data=>{errors+=data;});const [code]=await once(child,'exit');assert.equal(code,0,errors);}));
  assert.equal(fs.readFileSync(counter,'utf8'),'6');assert.equal(createBudgetLock({root}).status().available,true);
});

test('offline recovery CLI requires confirmation and archives only a legacy lock',t=>{
  const data=fixture(t),root=path.join(data,'aliyun-image');fs.mkdirSync(root);fs.mkdirSync(path.join(root,'.budget-lock'));
  const cli=new URL('../recover-budget-locks.mjs',import.meta.url);
  const invoke=extra=>spawnSync(process.execPath,[fileURLToPath(cli),'--data',data,'--kind','image',...extra],{encoding:'utf8',timeout:10000});
  assert.equal(invoke([]).status,1);assert(fs.existsSync(path.join(root,'.budget-lock')));
  const result=invoke(['--confirm-services-stopped']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).recovered,true);
});

test('all paid adapters report legacy locks and retain shared-data budgets and uncertain submissions after recovery',async t=>{
  const data=fixture(t);let posts=0;
  const cases=[['image',createAliImage,{prompt:'offline-original',size:'512*512'},.2],
    ['video',createAliVideo,{prompt:'offline-original',duration:5,ratio:'16:9'},1.2],
    ['speech',createAliSpeech,{text:'离线测试',voice:'Cherry'},.00064]];
  for(const [kind,make,content,budget] of cases){
    const config={data,key:'mock-only',budgetCny:budget,fetchImpl:async()=>{posts++;throw Error('simulated uncertain provider response');}},adapter=make(config),root=path.join(data,'aliyun-'+kind),request={request_id:crypto.randomUUID(),...content};
    fs.mkdirSync(path.join(root,'.budget-lock'));
    assert.equal(adapter.capabilities().available,false);const before=posts;
    await assert.rejects(adapter.submit(request),e=>e.status===503);assert.equal(posts,before);
    recoverBudgetLock({root,confirmServicesStopped:true});
    await assert.rejects(adapter.submit(request),e=>e.retryBlocked);assert.equal(posts,before+1);
    const file=path.join(root,request.request_id+'.json'),saved=fs.readFileSync(file),used=adapter.capabilities().usedCny;
    crashedLock(root);const restarted=make(config);assert.equal(restarted.capabilities().available,true);assert.equal(restarted.capabilities().usedCny,used);assert(fs.readFileSync(file).equals(saved));
    await assert.rejects(restarted.submit(request),e=>e.retryBlocked);
    await assert.rejects(restarted.submit({...request,request_id:crypto.randomUUID()}),e=>e.retryBlocked);
    const different=kind==='speech'?{text:'另一段落'}:{prompt:'another-original'};
    await assert.rejects(restarted.submit({...request,...different,request_id:crypto.randomUUID()}),e=>e.status===402);
    assert.equal(posts,before+1);assert.equal((await restarted.refresh(request.request_id)).status,'uncertain');assert.equal(posts,before+1);
  }
});
