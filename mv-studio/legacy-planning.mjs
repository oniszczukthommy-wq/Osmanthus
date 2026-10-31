import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Retained legacy endpoint gets the same durable no-blind-retry contract.
export function createLegacyPlanning({data,model,generate,check=()=>{}}){
  const root=path.join(data,'legacy-planning');fs.mkdirSync(root,{recursive:true});
  const pending=new Map();
  const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  const blocked=()=>Object.assign(new Error('原规划结果未确认，请保留工程并核对原任务；未再次提交付费'),{status:409,code:'LEGACY_PLAN_UNCERTAIN'});
  function save(file,value){const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
  async function plan(project){
    const hash=crypto.createHash('sha256').update(canonical({model,project})).digest('hex'),file=path.join(root,hash+'.json');
    if(pending.has(hash))return structuredClone(await pending.get(hash));
    if(fs.existsSync(file)){
      let record;try{record=JSON.parse(fs.readFileSync(file));}catch{throw blocked();}
      if(record?.hash===hash&&record.status==='complete'&&record.project)return structuredClone(record.project);
      throw blocked();
    }
    check();
    // Exclusive create also prevents competing processes from submitting twice.
    try{fs.writeFileSync(file,JSON.stringify({hash,status:'submitting'}),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')throw blocked();throw e;}
    const job=(async()=>{try{const result=await generate(structuredClone(project));save(file,{hash,status:'complete',project:result});return result;}catch(error){try{save(file,{hash,status:'uncertain'});}catch{}throw error;}})();
    pending.set(hash,job);
    try{return structuredClone(await job);}finally{pending.delete(hash);}
  }
  return {plan};
}
