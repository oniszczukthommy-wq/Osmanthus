import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA='osmanthus-budget-lock-v1';
const OWNER=/^owner-([1-9]\d*)-([a-f0-9-]{36})\.json$/;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

/** A synchronous, short accounting transaction; never held during a provider call.
 * Only a positively dead local PID is automatically reclaimed. A reused PID or
 * an inaccessible process is conservatively considered busy. No age-based TTL.
 */
export function createBudgetLock({root,label='生成',codePrefix='BUDGET'}={}) {
  const directory=path.resolve(root),identity=fs.lstatSync(directory),lock=path.join(directory,'.budget-lock');
  if(!identity.isDirectory()||identity.isSymbolicLink())throw Error('预算目录无效');
  function assertRoot(){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!same(stat,identity))throw Error('预算目录已改变');}
  function inspect(){
    assertRoot();let stat;
    try{stat=fs.lstatSync(lock);}catch(error){if(error.code==='ENOENT')return {state:'free'};throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())return {state:'invalid',stat};
    const entries=fs.readdirSync(lock);
    if(entries.length!==1||!OWNER.test(entries[0]))return {state:'owner_unknown',stat};
    const filename=entries[0],file=path.join(lock,filename),match=OWNER.exec(filename);let fd;
    try{
      const before=fs.lstatSync(file);
      if(!before.isFile()||before.isSymbolicLink()||before.size>4096)return {state:'invalid',stat};
      fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      if(!same(before,fs.fstatSync(fd)))return {state:'invalid',stat};
      const owner=JSON.parse(fs.readFileSync(fd,'utf8'));
      if(owner.schema!==SCHEMA||!Number.isSafeInteger(owner.pid)||owner.pid<1||String(owner.pid)!==match[1]||owner.token!==match[2]||typeof owner.host!=='string'||!owner.host)return {state:'invalid',stat};
      if(owner.host!==os.hostname())return {state:'foreign_owner',stat,filename,owner};
      const live=alive(owner.pid);
      return {state:live===false?'dead':live===true?'busy':'unverified',stat,filename,owner};
    }catch(error){if(error.code==='ENOENT')return {state:'changed',stat};return {state:'invalid',stat};}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function discardOwner(snapshot){
    // Deleting only the unique owner filename is the reclamation election:
    // losers get ENOENT and MUST NOT rmdir a replacement owner's directory.
    const now=fs.lstatSync(lock);
    if(!same(now,snapshot.stat)||!now.isDirectory()||now.isSymbolicLink())return false;
    try{fs.unlinkSync(path.join(lock,snapshot.filename));}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
    fs.rmdirSync(lock);return true;
  }
  function status(){
    try{
      for(let attempt=0;attempt<3;attempt++){
        const snapshot=inspect();
        if(snapshot.state==='dead'){try{discardOwner(snapshot);}catch(error){if(error.code!=='ENOENT')throw error;}continue;}
        if(snapshot.state==='changed')continue;
        if(snapshot.state==='free')return {available:true,state:'free',recoveryNeeded:false};
        const busy=snapshot.state==='busy';
        return {available:false,state:snapshot.state,recoveryNeeded:!busy,
          ...(snapshot.owner?{ownerPid:snapshot.owner.pid}:{}),
          reason:busy?`${label}预算由仍在运行的进程登记，请稍后查询原任务`:
            `${label}预算锁的持有者无法安全确认，已暂停新提交；请停止所有共用此数据目录的服务后，按 docs/budget-lock-recovery.md 恢复，勿删除任务或预算记录`};
      }
      return {available:false,state:'changing',recoveryNeeded:false,reason:`${label}预算登记正在切换，请稍后重试`};
    }catch{return {available:false,state:'unavailable',recoveryNeeded:true,reason:`${label}预算锁无法校验，已停止新提交；请检查目录权限并按 docs/budget-lock-recovery.md 恢复`};}
  }
  const blocked=state=>Object.assign(new Error(state.reason),{status:409,code:codePrefix+'_BUDGET_LOCKED',retryBlocked:true,budgetLock:state});
  function run(operation){
    assertRoot();const token=crypto.randomUUID(),filename=`owner-${process.pid}-${token}.json`;let acquired=false;
    for(let attempt=0;attempt<3&&!acquired;attempt++){
      try{fs.mkdirSync(lock,{mode:0o700});acquired=true;}
      catch(error){if(error.code!=='EEXIST')throw error;const state=status();if(!state.available)throw blocked(state);}
    }
    if(!acquired)throw blocked({reason:`${label}预算正在登记，请稍后重试`,state:'busy'});
    // If the process dies before this file is durable, the unowned directory is
    // deliberately left blocked for explicit offline recovery.
    const file=path.join(lock,filename),fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({schema:SCHEMA,pid:process.pid,host:os.hostname(),token}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const owned={stat:fs.lstatSync(lock),filename};
    try{return operation();}finally{discardOwner(owned);}
  }
  return {run,status};
}

/** Explicit local maintenance only. No HTTP endpoint calls this operation.
 * Legacy locks contain no PID; stop EVERY process sharing data first. Preserve
 * the entire unknown lock by renaming it, never erase accounting/task files.
 */
export function recoverBudgetLock({root,confirmServicesStopped=false}={}) {
  if(confirmServicesStopped!==true)throw Error('请先停止所有共用此目录的服务，并显式确认后恢复');
  const directory=path.resolve(root),lock=path.join(directory,'.budget-lock');
  const rootStat=fs.lstatSync(directory);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('预算目录无效');
  let stat;try{stat=fs.lstatSync(lock);}catch(error){if(error.code==='ENOENT')return {recovered:false};throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('锁路径不是普通目录，请人工核对，未改动任何文件');
  for(const name of fs.readdirSync(lock)){
    const match=OWNER.exec(name);
    if(match&&alive(Number(match[1]))!==false)throw Error('锁持有者仍运行或无法确认已退出，未恢复；请停止该进程后重试');
  }
  const archived=path.join(directory,'.budget-lock.orphaned-'+crypto.randomUUID());
  fs.renameSync(lock,archived);
  return {recovered:true,archived};
}
