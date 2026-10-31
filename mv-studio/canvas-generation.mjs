import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {getOutputFormat} from './public/output-format.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL=new Set(['ready','failed','uncertain']);
const VIDEO_RATIOS=new Set(['16:9','9:16','1:1','4:3','3:4']);
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
const error=(m,status=400,extra={})=>Object.assign(Error(m),{status,...extra});
const child=(id,suffix)=>{const h=hash([id,suffix]);return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const state=result=>['unknown','uncertain','submitting'].includes(result?.status)?'uncertain':['canceled','cancelled','failed'].includes(result?.status)?'failed':result?.status;
const message=(result,fallback)=>typeof result?.error==='string'?result.error:result?.error?.message||result?.message||fallback;

/** Durable jobs never mutate an active project. Recovery only queries/downloads existing provider ids. */
export function createCanvasGeneration({data,image,video,imageVideo,speech,prompts,materials,prepareVideoFrame,pollIntervalMs=15000}){
 const folder=path.join(data,'canvas-generation');fs.mkdirSync(folder,{recursive:true});const running=new Set(),timers=new Map();let closed=false;
 const file=id=>path.join(folder,id+'.json');const save=j=>{const temporary=file(j.id)+'.tmp-'+crypto.randomUUID();try{fs.writeFileSync(temporary,JSON.stringify(j,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file(j.id));}finally{try{fs.unlinkSync(temporary);}catch{}}};
 const get=id=>UUID.test(id||'')?read(file(id)):null;
 const list=projectId=>fs.readdirSync(folder).filter(n=>n.endsWith('.json')&&UUID.test(n.slice(0,-5))).map(n=>read(path.join(folder,n))).filter(j=>j&&(!projectId||j.project_id===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const provider=j=>j.kind==='image'?image:j.kind==='speech'?speech:j.imageMaterial?imageVideo:video;
 function schedule(id,delay=pollIntervalMs){if(closed||timers.has(id))return;const t=setTimeout(()=>{timers.delete(id);void advance(id);},delay);t.unref();timers.set(id,t);}
 function checkCapability(adapter,cost=0){if(!adapter)throw error('生成模型尚未配置',503);const cap=adapter.capabilities?.();if(cap?.available===false)throw error(cap.reason||'生成模型尚未配置',503);if(Number.isFinite(cap?.remainingCny)&&cap.remainingCny+1e-8<cost)throw error('剩余预算不足以完成此次生成，未提交付费任务',402);return cap;}
 function preflight(input,referenceAssets){
  if(input.kind==='speech'){checkCapability(speech,Array.from(input.prompt).reduce((sum,c)=>sum+(/\p{Script=Han}/u.test(c)?2:c.length),0)*.00008);return;}
  getOutputFormat(input.ratio);
  if(input.kind==='image'){const cap=checkCapability(image,image?.capabilities?.().estimatedCostCny??.2);for(const asset of referenceAssets)if(asset.material.bytes>(cap?.referenceBytes??10_000_000))throw error('每张图片参考需在10MB以内，请先缩小或裁剪');return;}
  if(!VIDEO_RATIOS.has(input.ratio))throw error('视频生成支持16:9、9:16、1:1、4:3和3:4；请先调整画幅');
  const first=referenceAssets[0];
  if(first){const m=first.material;if(!/\.(?:png|jpe?g|webp|gif)$/i.test(first.file||'')||!Number.isInteger(m.width)||!Number.isInteger(m.height)||m.width<1||m.height<1||m.width*m.height>16_777_216||m.bytes>20_000_000)throw error('视频首帧需为20MB、1600万像素内的PNG/JPEG/WebP/GIF');const[w,h]=input.ratio.split(':').map(Number);if(typeof prepareVideoFrame!=='function'&&(Math.abs(m.width/m.height/(w/h)-1)>.025||!/\.(?:png|jpe?g)$/i.test(first.file)||m.width<240||m.height<240))throw error('首帧画幅或格式需要适配，但免费首帧适配执行端尚未配置');}
  const needsImageVideo=!!first||input.duration!==5,adapter=needsImageVideo?imageVideo:video;
  const cap=adapter?.capabilities?.(),cost=cap?.estimatedCostsCny?.[input.duration]??(needsImageVideo ? .15*input.duration : 1.2);checkCapability(adapter,cost);
  if(!first&&needsImageVideo)checkCapability(image,image.capabilities?.().estimatedCostCny??.2);
 }
 function register(j,adapter,result){
  if(j.material&&materials.get?.(j.material.id)?.sha256===j.material.sha256)return j.material;
  const asset=adapter.asset(result.id);if(!asset)throw error('生成文件尚未完成校验');
  const ext=j.kind==='image'?'.png':j.kind==='speech'?path.extname(asset.file):'.mp4';
  return materials.upload(`Osmanthus-${j.kind}-output-${j.id.slice(0,8)}${ext}`,fs.readFileSync(asset.file));
 }
 async function ensureVideoFrame(j,material){
  if(j.imageMaterial&&materials.asset(j.imageMaterial))return;
  j.originalFirstFrame=copy(material);j.status='preparing-frame';j.message='正在免费居中裁剪并适配视频首帧，原图保留';save(j);
  const prepared=typeof prepareVideoFrame==='function'?await prepareVideoFrame({request_id:child(j.id,'first-frame'),material_id:material.id,ratio:j.ratio}):material;
  if(!prepared?.id||!materials.asset(prepared.id))throw error('适配后的首帧尚未登记');j.imageMaterial=prepared.id;j.preparedFirstFrame=copy(prepared);j.firstFrameAdapted=prepared.id!==material.id;save(j);
 }
 function pending(j,result,label){const status=state(result);if(['failed','uncertain'].includes(status)){j.status=status;j.message=message(result,label+'未完成；未自动重复提交付费任务');j.error=j.message;j.retryBlocked=status==='uncertain';save(j);return true;}if(status!=='ready'){j.status='generating';j.message=result?.status==='download_failed'?label+'已生成，正在恢复原结果下载':label+'正在生成';save(j);schedule(j.id);return true;}return false;}
 async function advance(id){
  if(closed||running.has(id))return;const j=get(id);if(!j||TERMINAL.has(j.status))return;running.add(id);
  try{
   if(j.kind==='video'&&j.references.length){const original=materials.asset(j.references[0]);if(!original)throw error('原始首帧素材已失效');await ensureVideoFrame(j,original.material);}
   if(!j.compiledPrompt){j.status='compiling';j.message='正在整理完整模板与执行提示词';save(j);const c=j.kind==='speech'?{prompt:j.prompt}:await prompts.compile({request_id:child(id,'prompt'),prompt:j.prompt,kind:j.kind,max_chars:j.kind==='video'?(j.references.length||j.duration!==5?1500:800):1100});if(typeof c?.prompt!=='string'||!c.prompt.trim())throw error('执行提示词为空');j.compiledPrompt=c.prompt;save(j);}
   if(j.kind==='video'&&!j.references.length&&j.duration!==5){
    const keyframeId=child(id,'keyframe');let frame=image.get(keyframeId);
    if(!frame){j.message='正在生成视频首帧';save(j);const compiledFrame=await prompts.compile({request_id:child(id,'keyframe-prompt'),kind:'image',max_chars:1100,prompt:'生成一张视频开场关键帧，表现以下创意的起始画面，不要时间轴或分镜拼图：'+j.compiledPrompt});frame=await image.submit({request_id:keyframeId,prompt:compiledFrame.prompt,ratio:j.ratio});}
    if(!TERMINAL.has(state(frame))&&image.refresh)frame=await image.refresh(keyframeId);
    if(pending(j,frame,'视频首帧'))return;
    if(!j.keyframe||!materials.asset(j.keyframe.id)){const asset=image.asset(keyframeId);if(!asset)throw error('首帧文件校验未通过');j.keyframe=await materials.upload(`视频首帧-${id.slice(0,8)}.png`,fs.readFileSync(asset.file));save(j);}await ensureVideoFrame(j,j.keyframe);
   }
   const adapter=provider(j);if(!adapter)throw error('生成模型尚未配置',503);let result=adapter.get(id);
   if(!result){j.status='generating';j.message='正在生成'+({image:'图片',video:'视频',speech:'语音'})[j.kind];save(j);result=await adapter.submit(j.kind==='image'?{request_id:id,prompt:j.compiledPrompt,ratio:j.ratio,references:j.references.map(material_id=>({material_id}))}:j.kind==='speech'?{request_id:id,text:j.prompt,voice:j.voice,language_type:'Chinese'}:{request_id:id,prompt:j.compiledPrompt,duration:j.duration,ratio:j.ratio,...(j.imageMaterial?{image:{material_id:j.imageMaterial}}:{})});}
   if(!TERMINAL.has(state(result))&&adapter.refresh)result=await adapter.refresh(id);
   j.provider=result.model;j.providerStatus=result.status;j.estimatedCostCny=result.estimatedCostCny;
   if(pending(j,result,'媒体'))return;
   j.material=await register(j,adapter,result);j.status='ready';j.message='生成完成，已保存在素材库';j.url=j.material.url;save(j);
  }catch(e){j.status=e.retryBlocked||e.uncertain?'uncertain':'failed';j.retryBlocked=j.status==='uncertain';j.error=String(e.message).slice(0,240);j.message=j.error;save(j);}finally{running.delete(id);}
 }
 function submit(raw){
  const {request_id,project_id,kind,prompt,ratio='1:1',references=[],duration=5,voice='Cherry',node_id=null,template_id=null}=raw;
  if(!UUID.test(request_id||'')||!UUID.test(project_id||'')||!['image','video','speech'].includes(kind)||typeof prompt!=='string'||!prompt.trim()||prompt.length>12000||!Array.isArray(references)||references.length>3||references.some(id=>!UUID.test(id))||kind==='video'&&(!Number.isInteger(duration)||duration<2||duration>15))throw error('生成参数不完整或不受支持；视频单镜支持2至15整数秒');
  if(kind==='speech'&&Array.from(prompt).length>1000)throw error('每次配音最多1000字，原文未修改');
  const referenceAssets=references.map(id=>{const a=materials.asset(id);if(!a||a.material.kind!=='image')throw error('首帧与参考素材必须为本地图片');return a;});
  const input={project_id,kind,prompt,ratio,references,duration,voice,node_id,template_id},signature=hash(input),old=get(request_id);
  if(old){if(old.signature!==signature)throw error('同一生成请求不能更换内容',409);return copy(old);}
  const prior=list().find(j=>j.signature===signature&&!['ready','failed'].includes(j.status));if(prior)return copy(prior);
  preflight(input,referenceAssets);
  const j={id:request_id,...input,signature,status:'queued',message:'已保存生成需求',createdAt:new Date().toISOString()};save(j);schedule(j.id,1);return copy(j);
 }
 for(const j of list())if(!TERMINAL.has(j.status))schedule(j.id);
 return {submit,get,list,refresh:async id=>{await advance(id);return get(id);},close(){closed=true;for(const t of timers.values())clearTimeout(t);timers.clear();}};
}
