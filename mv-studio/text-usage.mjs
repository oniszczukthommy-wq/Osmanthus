import fs from 'node:fs';
import path from 'node:path';

const active = new Map();
const fail = message => Object.assign(new Error(message), {status:429, code:'TEXT_USAGE_LIMIT'});
const number = (value,fallback) => {
  const n=Number(value??fallback);
  if(!Number.isSafeInteger(n)||n<0||n>10000)throw Error('MV文字调用限额需为0至10000的整数');
  return n;
};

// Exclusive, immutable tickets survive restarts. No stale mutex can block a
// future day. A failed/uncertain provider attempt still consumes its ticket.
export function createTextUsage({data,environment=process.env,now=()=>Date.now()}={}) {
  const root=path.resolve(data,'text-usage');
  const limits={daily:number(environment.MV_TEXT_DAILY_LIMIT,40),total:number(environment.MV_TEXT_TOTAL_LIMIT,300),minute:number(environment.MV_TEXT_RATE_PER_MINUTE,8),concurrent:number(environment.MV_TEXT_MAX_CONCURRENT,2)};
  function directory(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())throw Error('文字额度记录目录无效');return dir;}
  function buckets(){const date=new Date(now()).toISOString();return [[path.join(root,'total'),limits.total,'累计'],[path.join(root,'days',date.slice(0,10)),limits.daily,'今日'],[path.join(root,'minutes',date.slice(0,16).replace(/:/g,'-')),limits.minute,'本分钟']];}
  function count(dir){return fs.readdirSync(directory(dir)).filter(n=>/^\d+\.ticket$/.test(n)).length;}
  function check(){if((active.get(root)||0)>=limits.concurrent)throw fail('文字创作请求较多，请等待当前请求完成');for(const[dir,limit,label]of buckets())if(count(dir)>=limit)throw fail(`${label}文字调用额度已用完；请稍后或由本机管理员调整限额`);}
  async function run(operation){
    check();const owned=[];active.set(root,(active.get(root)||0)+1);
    try{
      for(const[dir,limit,label]of buckets()){
        let reserved=false;
        for(let i=1;i<=limit;i++)try{const file=path.join(directory(dir),i+'.ticket');const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);owned.push(file);reserved=true;break;}catch(e){if(e.code!=='EEXIST')throw e;}
        if(!reserved)throw fail(`${label}文字调用额度已用完，请稍后再试`);
      }
    }catch(e){for(const file of owned)fs.unlinkSync(file);active.set(root,active.get(root)-1);throw e;}
    try{return await operation();}finally{active.set(root,active.get(root)-1);}
  }
  function wrapFetch(fetchImpl){return async(...args)=>{
    try{return await run(async()=>{
      const response=await fetchImpl(...args);
      // Keep the concurrency slot until the JSON body is fully received.
      const chunks=[];let size=0;
      if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>1_000_000)throw Error('文字模型响应过大');chunks.push(Buffer.from(chunk));}
      const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
      return new Response(Buffer.concat(chunks),{status:response.status,headers});
    });}catch(error){if(error.code!=='TEXT_USAGE_LIMIT')throw error;return new Response(JSON.stringify({error:{code:error.code,message:error.message}}),{status:429,headers:{'Content-Type':'application/json'}});}
  };}
  function status(){const values=buckets();return{...limits,usedTotal:count(values[0][0]),usedToday:count(values[1][0]),timezone:'UTC',unit:'provider_attempts'};}
  return {check,run,wrapFetch,status};
}
