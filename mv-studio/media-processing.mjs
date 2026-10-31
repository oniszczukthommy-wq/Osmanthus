import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

const busy=()=>Object.assign(Error('媒体处理中，请等待当前上传完成后再试'),{status:503,code:'MEDIA_BUSY'});
const integer=(value,fallback,min,max)=>{const n=Number(value??fallback);if(!Number.isInteger(n)||n<min||n>max)throw Error('媒体处理并发/队列配置无效');return n;};
const execute=(file,args,options)=>new Promise((resolve,reject)=>execFile(file,args,options,(error,stdout)=>error?reject(error):resolve(stdout)));

/** Bounded asynchronous ffprobe/FFmpeg work; HTTP handlers never block on exec. */
export function createMediaProcessing({ffmpeg,ffprobe,environment=process.env,run=execute}={}){
  const concurrent=integer(environment.MV_MEDIA_CONCURRENCY,2,1,8),waiting=integer(environment.MV_MEDIA_QUEUE_LIMIT,8,0,32);
  const queue=[],cache=new Map(),pending=new Map();let active=0,uploads=0;
  function pump(){
    while(active<concurrent&&queue.length){const item=queue.shift();clearTimeout(item.timer);active++;
      Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(()=>{active--;pump();});}
  }
  function schedule(work){
    if(active>=concurrent&&queue.length>=waiting)return Promise.reject(busy());
    return new Promise((resolve,reject)=>{
      const item={work,resolve,reject};item.timer=setTimeout(()=>{const index=queue.indexOf(item);if(index>=0){queue.splice(index,1);reject(busy());}},30000);
      queue.push(item);pump();
    });
  }
  function fingerprint(file){const s=fs.statSync(file,{bigint:true});return `${path.resolve(file)}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;}
  async function cached(kind,file,operation){
    const identity=fingerprint(file),key=kind+':'+identity;
    if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return structuredClone(value);}
    if(pending.has(key))return structuredClone(await pending.get(key));
    const job=schedule(async()=>{const value=await operation();if(fingerprint(file)!==identity)throw Error('媒体在处理期间已改变，请重新选择');cache.set(key,value);while(cache.size>64)cache.delete(cache.keys().next().value);return value;});
    pending.set(key,job);try{return structuredClone(await job);}finally{pending.delete(key);}
  }
  const options={timeout:20000,killSignal:'SIGKILL',windowsHide:true,maxBuffer:1_000_000,encoding:'utf8'};
  function probe(file){return cached('probe',file,async()=>JSON.parse(await run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file],options)));}
  function waveform(file){return cached('wave',file,async()=>{
    const a=await run(ffmpeg,['-v','error','-i',file,'-vn','-ac','1','-ar','400','-f','f32le','-'],{...options,encoding:null,maxBuffer:20_000_000}),bins=[];
    const frames=Math.floor(a.length/4);
    for(let i=0;i<100;i++){const start=Math.floor(frames*i/100),end=Math.floor(frames*(i+1)/100);let sum=0;for(let j=start;j<end;j++){const n=a.readFloatLE(j*4);if(Number.isFinite(n))sum+=n*n;}bins.push(Math.sqrt(sum/Math.max(1,end-start)));}
    const max=Math.max(.001,...bins);return bins.map(x=>Math.round(x/max*100)/100);
  });}
  function admitUpload(){if(uploads>=concurrent+waiting)throw busy();uploads++;let released=false;return()=>{if(!released){released=true;uploads--;}};}
  return {probe,waveform,admitUpload,status:()=>({active,queued:queue.length,uploads,concurrent,waiting})};
}
