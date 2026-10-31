import path from 'node:path';
import fs from 'node:fs';
import {recoverBudgetLock} from './budget-lock.mjs';

const args=process.argv.slice(2),dataAt=args.indexOf('--data'),kindAt=args.indexOf('--kind');
const kind=kindAt<0?'all':args[kindAt+1],data=dataAt<0?null:args[dataAt+1];
if(!data||!['all','image','video','speech'].includes(kind)||!args.includes('--confirm-services-stopped')){
  console.error('先停止所有使用此数据目录的服务。用法: node recover-budget-locks.mjs --data <MV数据目录> --kind all|image|video|speech --confirm-services-stopped');process.exitCode=1;
}else{
  try{for(const name of kind==='all'?['image','video','speech']:[kind]){
    const root=path.resolve(data,'aliyun-'+name);
    if(!fs.existsSync(root))continue;
    console.log(JSON.stringify({kind:name,...recoverBudgetLock({root,confirmServicesStopped:true})}));
  }}catch(error){console.error(error.message);process.exitCode=1;}
}
