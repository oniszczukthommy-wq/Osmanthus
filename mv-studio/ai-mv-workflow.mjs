import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {getOutputFormat} from './public/output-format.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const copy=x=>JSON.parse(JSON.stringify(x));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const json=(f,v)=>{fs.writeFileSync(f+'.tmp',JSON.stringify(v,null,2));fs.renameSync(f+'.tmp',f);};
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const error=(s,status=400)=>Object.assign(Error(s),{status});
const terminal=new Set(['ready','failed','uncertain']);
const childId=(id,index)=>{const h=hash(`${id}:shot:${index}`);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

export function editableMVPlan(stored,edits){
 if(!stored||!UUID.test(stored.id||'')||!Array.isArray(stored.shots)||![1,2].includes(stored.shots.length))throw error('找不到可用的AI分镜方案，请先生成分镜');
 const p=copy(stored);
 if(edits){
  if(!Array.isArray(edits)||edits.length!==p.shots.length)throw error('分镜数量已改变，请重新生成方案');
  p.shots=p.shots.map((shot,i)=>{const e=edits[i];if(e.id!==shot.id||typeof e.prompt!=='string'||!e.prompt.trim()||e.prompt.length>1600||typeof e.label!=='string'||!e.label.trim()||e.label.length>100)throw error('镜头描述需要完整，提示词最多1600字');return {...shot,label:e.label.trim(),prompt:e.prompt.trim()};});
 }
 if(![5,10].includes(p.duration)||p.shots.length!==p.duration/5||p.shots.some((s,i)=>s.duration!==5||Math.abs(s.start-i*5)>.01||Math.abs(s.end-(i+1)*5)>.01))throw error('短流程需由连续的5秒镜头组成');
 if(!['16:9','9:16','1:1','4:3','3:4'].includes(p.ratio))throw error('当前阿里视频短测支持16:9、9:16、1:1、4:3和3:4');
 return p;
}

function run(program,args){return new Promise((resolve,reject)=>{const p=spawn(program,args,{stdio:['ignore','ignore','pipe']});let log='';p.stderr.on('data',b=>log=(log+String(b)).slice(-4000));p.on('error',()=>reject(error('本地视频合成器无法启动')));p.on('close',code=>code===0?resolve():reject(error('本地视频合成未通过，请保留现有镜头后重试')));});}

/** Paid generation survives page closure; retries only query existing provider tasks. */
export function createAIMVWorkflow({data,planner,video,audioPath,probe,ffmpeg,pollMs=15000}){
 const folder=path.join(data,'ai-mv-jobs');fs.mkdirSync(folder,{recursive:true});
 const working=new Set(),timers=new Map();let closed=false;
 const file=id=>path.join(folder,id,'state.json');
 const save=j=>{j.updatedAt=new Date().toISOString();json(file(j.id),j);};
 function get(id){if(!UUID.test(id||''))return null;return read(file(id));}
 function publicJob(j){if(!j)return null;const result=copy(j);delete result.signature;delete result.audioFile;delete result.project;return result;}
 const list=projectId=>fs.readdirSync(folder).filter(n=>UUID.test(n)).map(get).filter(j=>j&&(!projectId||j.project_id===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicJob);
 function bound(project,plan){
  if(project.id!==plan.project_id||!Number.isFinite(plan.start)||plan.start<0||plan.start+plan.duration>project.source.duration+.1)throw error('分镜与当前歌曲或片段不一致，请重新生成分镜',409);
  const source=audioPath(project.source);if(hash(fs.readFileSync(source))!==plan.source_sha256)throw error('原歌曲版本已改变，请重新生成分镜',409);
  return source;
 }
 function schedule(id,delay=pollMs){if(closed||timers.has(id))return;const timer=setTimeout(()=>{timers.delete(id);void advance(id);},delay);timer.unref();timers.set(id,timer);}
 async function compose(j){
  j.status='composing';j.message='镜头已生成，正在合成原曲';j.progress=90;save(j);
  const outFolder=path.join(data,'jobs',j.id);fs.mkdirSync(outFolder,{recursive:true});
  const format=getOutputFormat(j.plan.ratio),inputs=[],filters=[];
  for(let i=0;i<j.shots.length;i++){
   const clip=video.get(j.shots[i].task_id),clipPath=path.join(data,'aliyun-video',clip.id,'video.mp4');
   if(clip.status!=='ready'||!fs.existsSync(clipPath)||hash(fs.readFileSync(clipPath))!==clip.sha256)throw error('生成镜头文件未通过完整性校验');
   inputs.push('-i',clipPath);
   filters.push(`[${i}:v:0]trim=duration=5,setpts=PTS-STARTPTS,scale=${format.width}:${format.height}:force_original_aspect_ratio=decrease,pad=${format.width}:${format.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24[v${i}]`);
   const poster=path.join(folder,j.id,`shot-${i+1}.jpg`);
   if(!fs.existsSync(poster))await run(ffmpeg,['-v','error','-y','-i',clipPath,'-frames:v','1','-q:v','3',poster]);
   j.shots[i].thumbnailUrl=`/files/ai-mv-jobs/${j.id}/shot-${i+1}.jpg`;
  }
  const labels=j.shots.map((_,i)=>`[v${i}]`).join('');
  filters.push(`${labels}concat=n=${j.shots.length}:v=1:a=0[outv]`);
  const target=path.join(outFolder,'mv.mp4');
  await run(ffmpeg,['-v','error','-y',...inputs,'-ss',String(j.plan.start),'-i',j.audioFile,'-filter_complex',filters.join(';'),'-map','[outv]','-map',`${j.shots.length}:a:0`,'-t',String(j.plan.duration),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',target]);
  const info=await probe(target),v=info.streams?.find(x=>x.codec_type==='video'),a=info.streams?.find(x=>x.codec_type==='audio');
  if(!v||!a||v.width!==format.width||v.height!==format.height||Math.abs(Number(info.format?.duration)-j.plan.duration)>.2)throw error('成片的时长、声音或画面尺寸检查未通过');
  j.generated={url:`/files/jobs/${j.id}/mv.mp4`,sha256:hash(fs.readFileSync(target)),duration:j.plan.duration,dimensions:format,provider:'aliyun-wan',kind:'ai-generated-mv',jobId:j.id,source_sha256:j.plan.source_sha256};
  j.status='ready';j.progress=100;j.message='AI镜头与原歌曲已合成，可试听与下载';save(j);
 }
 async function advance(id){
  if(closed||working.has(id))return;const j=get(id);if(!j||terminal.has(j.status))return;working.add(id);
  try{
   for(let i=0;i<j.shots.length;i++){
    const item=j.shots[i];let clip=video.get(item.task_id);
    if(!clip){j.message=`正在提交第${i+1}个AI镜头`;j.status='generating';save(j);clip=await video.submit({request_id:item.task_id,prompt:item.prompt,duration:5,ratio:j.plan.ratio});}
    if(!['ready','failed','uncertain'].includes(clip.status))clip=await video.refresh(item.task_id);
    item.status=clip.status;item.model=clip.model;item.estimatedCostCny=clip.estimatedCostCny;
    if(clip.status==='ready'){item.url=clip.url;item.sha256=clip.sha256;j.progress=Math.round((i+1)/j.shots.length*85);save(j);continue;}
    if(['failed','uncertain','unknown','canceled'].includes(clip.status)){j.status=['unknown','uncertain'].includes(clip.status)?'uncertain':'failed';j.message=(typeof clip.error==='string'?clip.error:clip.error?.message)||clip.message||'镜头生成没有完成，已有任务和费用记录已保留';j.error=j.message;save(j);return;}
    j.message=clip.status==='download_failed'?`第${i+1}个AI镜头已生成，正在恢复原任务的下载：${clip.error?.message||'结果下载未完成'}`:`第${i+1}/${j.shots.length}个镜头生成中，可关闭面板后继续编辑画布`;save(j);schedule(id);return;
   }
   await compose(j);
  }catch(e){j.status=e.uncertain?'uncertain':'failed';j.error=String(e.message||'MV制作未完成').slice(0,240);j.message=j.error;save(j);}
  finally{working.delete(id);}
 }
 async function start({request_id,project,plan_id,shots}){
  if(!UUID.test(request_id||''))throw error('制作请求标识无效');
  const stored=planner.get(plan_id),plan=editableMVPlan(stored,shots),source=bound(project,plan);
  const signature=hash(JSON.stringify({plan,project_id:project.id}));const existing=get(request_id);
  if(existing){if(existing.signature!==signature)throw error('同一制作请求不能改用其他分镜',409);return publicJob(existing);}
  const previous=fs.readdirSync(folder).filter(n=>UUID.test(n)).map(get).filter(Boolean),prior=previous.find(j=>j.signature===signature);
  if(prior)return publicJob(prior);
  if(list().some(j=>!terminal.has(j.status)))throw error('已有AI视频制作任务在运行，请先等它完成',409);
  const reusable=previous.filter(j=>j.status==='ready'&&j.project_id===project.id&&j.source_sha256===plan.source_sha256&&j.plan.ratio===plan.ratio).flatMap(j=>j.shots);
  const nextShots=plan.shots.map((s,i)=>{const saved=reusable.find(x=>x.prompt===s.prompt&&video.get(x.task_id)?.status==='ready');return {...s,task_id:saved?.task_id||childId(request_id,i),status:saved?'ready':'queued',reused:!!saved};});
  const caps=video.capabilities(),estimate=Number(caps.estimatedCostCny||1.2)*nextShots.filter(s=>!s.reused).length;
  if(caps.available===false)throw error(caps.reason||'阿里视频模型尚未配置',503);
  if(Number.isFinite(caps.remainingCny)&&caps.remainingCny+.001<estimate)throw error('剩余视频测试预算不足以完成全部镜头，本次未提交付费任务',402);
  const dir=path.join(folder,request_id);fs.mkdirSync(dir);const audioFile=path.join(dir,'source'+path.extname(source));fs.copyFileSync(source,audioFile);
  if(hash(fs.readFileSync(audioFile))!==plan.source_sha256)throw error('音频冻结校验未通过');
  const j={id:request_id,project_id:project.id,source_id:project.source.id,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'已保存分镜和原曲，准备生成AI镜头',signature,plan,audioFile,source_sha256:plan.source_sha256,estimatedCostCny:estimate,shots:nextShots};save(j);schedule(j.id,1);return publicJob(j);
 }
 for(const name of fs.readdirSync(folder))if(UUID.test(name)&&get(name)&&!terminal.has(get(name).status))schedule(name,50);
 return {start,get:id=>publicJob(get(id)),list,refresh:async id=>{await advance(id);return publicJob(get(id));},close(){closed=true;for(const t of timers.values())clearTimeout(t);timers.clear();}};
}
