import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {validateProject,clone,resizePlan} from './public/domain.js';
import {createMusicBridge} from './music-bridge.mjs';
import {createMaterialStore,MATERIAL_LIMITS} from './materials.mjs';
import {createCanvasProjects,MAX_CANVAS_RECORD_BYTES} from './canvas-projects.mjs';
import {getOutputFormat,validateOutputDimensions} from './public/output-format.js';
import {validateCanvasDocument,createCanvasDocument,addNode} from './public/canvas-document.js';
import {validateCanvasDrawings} from './public/canvas-preferences.js';
import {createAliVideo} from './aliyun-video.mjs';
import {createMVPlanner} from './ai-mv-planner.mjs';
import {createAIMVWorkflow} from './ai-mv-workflow.mjs';
import {createMVDirector} from './mv-director.mjs';
import {createAliImage} from './aliyun-image.mjs';
import {createAliSpeech} from './aliyun-speech.mjs';
import {createCanvasPrompts} from './canvas-prompts.mjs';
import {createCanvasGeneration} from './canvas-generation.mjs';
import {createCanvasFirstFrame} from './canvas-first-frame.mjs';
import {createCanvasVideoEditor} from './canvas-video-editor.mjs';
import {createCanvasAudioTools} from './canvas-audio-tools.mjs';
import {createCanvasVision} from './canvas-vision.mjs';
import {getOiiPromptTemplate} from './public/oiioii-canvas-catalog.js';
import {mediaTools,readOptionalEnv} from './runtime-config.mjs';
import {createTextUsage} from './text-usage.mjs';
import {createLegacyPlanning} from './legacy-planning.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),PUBLIC=path.join(ROOT,'public');
const env=readOptionalEnv(process.env.MV_ENV_FILE,ROOT);
// Explicit process configuration takes priority over the optional chosen file.
for(const[name,value]of Object.entries(env))if(process.env[name]===undefined)process.env[name]=value;
const DATA=process.env.MV_DATA_DIR||path.join(ROOT,'data');
const {ffmpeg:ff,ffprobe:fp}=mediaTools();
for(const x of ['uploads','jobs','versions'])fs.mkdirSync(path.join(DATA,x),{recursive:true});
const json=(file,value)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file)},read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file))}catch{return fallback}},uid=()=>crypto.randomUUID(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const key=process.env.MV_DISABLE_MODELS==='1'?'':process.env.DEEPSEEK_API_KEY||env.DEEPSEEK_API_KEY||'',model=process.env.DEEPSEEK_MODEL||env.DEEPSEEK_MODEL||'deepseek-flash';
const aliKey=process.env.MV_DISABLE_MODELS==='1'?'':process.env.DASHSCOPE_API_KEY||env.DASHSCOPE_API_KEY||'';
const textUsage=createTextUsage({data:DATA}),textFetch=textUsage.wrapFetch(globalThis.fetch);
const legacyPlanning=createLegacyPlanning({data:DATA,model,generate:enrich,check:textUsage.check});
const aliVideo=createAliVideo({data:DATA,key:aliKey,workspace:process.env.DASHSCOPE_WORKSPACE_ID||env.DASHSCOPE_WORKSPACE_ID||'',model:process.env.MV_VIDEO_MODEL||env.MV_VIDEO_MODEL||'wanx2.1-t2v-turbo',region:process.env.MV_VIDEO_REGION||env.MV_VIDEO_REGION||'cn-beijing',budgetCny:Number(process.env.MV_VIDEO_BUDGET_CNY||20),probe});
const aiPlanner=createMVPlanner({data:DATA,key,model,fetchImpl:textFetch});
const aiMV=createAIMVWorkflow({data:DATA,planner:aiPlanner,video:aliVideo,audioPath,probe,ffmpeg:ff});
const tasks=new Map();
function capability(){return{kind:'local-ai-music-video-workspace',freeRender:fs.existsSync(ff)&&fs.existsSync(fp),deepseek:!!key,aliyunVideo:aliVideo.capabilities(),canvas:{image:imageModel.capabilities(),imageVideo:imageVideo.capabilities(),speech:speechModel.capabilities(),vision:canvasVision.capabilities(),asr:canvasAudio.capabilities(),editing:fs.existsSync(ff)&&fs.existsSync(fp),visualAnalysis:!!aliKey},asr:canvasAudio.capabilities().available,platformLinks:false,comfy:{available:false,reason:'当前视频使用阿里万相API。'},sample:fs.existsSync(path.join(PUBLIC,'assets/sample-song.mp3'))};}
function audioPath(source){if(source.id!=='sample'&&!/^[a-f0-9-]{36}\.(mp3|wav|m4a|aac|flac|ogg|opus)$/.test(source.id))throw Error('音频来源无效');const p=source.id==='sample'?path.join(PUBLIC,'assets/sample-song.mp3'):path.join(DATA,'uploads',source.id);let stat;try{stat=fs.lstatSync(p);}catch{throw Error('找不到原音频，请重新上传');}if(!stat.isFile()||stat.isSymbolicLink())throw Error('原音频文件无效，请重新上传');return p;}
function probe(file){return JSON.parse(execFileSync(fp,['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',timeout:20000,maxBuffer:1e6}));}
function waveform(file){if(!fs.existsSync(file))return[];try{const a=execFileSync(ff,['-v','error','-i',file,'-vn','-ac','1','-ar','400','-f','f32le','-'],{timeout:20000,maxBuffer:20e6});const bins=[];for(let i=0;i<100;i++){const start=Math.floor(a.length/4*i/100),end=Math.floor(a.length/4*(i+1)/100);let sum=0;for(let j=start;j<end;j++){const n=a.readFloatLE(j*4);sum+=n*n;}bins.push(Math.sqrt(sum/Math.max(1,end-start)));}const max=Math.max(.001,...bins);return bins.map(x=>Math.round(x/max*100)/100);}catch{return[];}}
const sampleWave=fs.existsSync(path.join(PUBLIC,'assets/sample-song.mp3'))?waveform(path.join(PUBLIC,'assets/sample-song.mp3')):[];
function version(p,label,output=null){const id=uid(),v={id,createdAt:new Date().toISOString(),label,project:clone(p),output};json(path.join(DATA,'versions',id+'.json'),v);return v;}
const activeProjectFile=path.join(DATA,'project.json'),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const materials=createMaterialStore({data:DATA,probe,write:json});
const imageModel=createAliImage({data:DATA,key:aliKey,workspace:process.env.DASHSCOPE_WORKSPACE_ID||env.DASHSCOPE_WORKSPACE_ID||'',probe,budgetCny:Number(process.env.MV_IMAGE_BUDGET_CNY||4),maxBudgetCny:Number(process.env.MV_IMAGE_BUDGET_CNY||4)});
const imageVideo=createAliVideo({data:DATA,key:aliKey,workspace:process.env.DASHSCOPE_WORKSPACE_ID||env.DASHSCOPE_WORKSPACE_ID||'',model:'wan2.6-i2v-flash',probe,budgetCny:Number(process.env.MV_VIDEO_BUDGET_CNY||20)});
const speechModel=createAliSpeech({data:DATA,key:aliKey,workspace:process.env.DASHSCOPE_WORKSPACE_ID||env.DASHSCOPE_WORKSPACE_ID||'',probe,budgetCny:1});
const canvasPrompts=createCanvasPrompts({data:DATA,key,aliKey,visionModel:process.env.DASHSCOPE_VISION_MODEL||env.DASHSCOPE_VISION_MODEL||'qwen3.5-flash',workspace:process.env.DASHSCOPE_WORKSPACE_ID||env.DASHSCOPE_WORKSPACE_ID||'',model,materials,fetchImpl:textFetch});
const firstFrames=createCanvasFirstFrame({data:DATA,ffmpeg:ff,probe,materials});
const canvasGeneration=createCanvasGeneration({data:DATA,image:imageModel,video:aliVideo,imageVideo,speech:speechModel,prompts:canvasPrompts,materials,prepareVideoFrame:input=>firstFrames.prepare(input)});
const canvasVision=createCanvasVision({data:DATA,resolveMaterial:id=>materials.asset(id)});
const canvasEditor=createCanvasVideoEditor({data:DATA,ffmpeg:ff,probe,resolveAsset:resolveCanvasAsset});
const canvasAudio=createCanvasAudioTools({data:DATA,ffmpeg:ff,probe,resolveAsset:resolveCanvasAsset});
const mvDirector=createMVDirector({data:DATA,key,model,image:imageModel,video:imageVideo,materials,audioPath,probe,ffmpeg:ff,fetchImpl:textFetch});
function resolveCanvasAsset(id){
 if(UUID.test(id||'')){const local=materials.asset(id);if(local)return local;const video=aliVideo.asset(id);if(video)return video;const picture=imageModel.asset(id);if(picture)return picture;const speech=speechModel.asset(id);if(speech)return speech;}
 if(id==='sample')return{file:path.join(PUBLIC,'assets/sample-song.mp3'),kind:'audio'};
 const source=String(id).match(/^source:([a-f0-9-]{36}\.(?:mp3|wav|m4a|aac|flac|ogg|opus))$/);if(source)return{file:audioPath({id:source[1]}),kind:'audio'};
 const reference=String(id).match(/^(mv|edit|audio):([a-f0-9-]{36})$/);if(reference){const[kind,identifier]=reference.slice(1);let record,file;if(kind==='mv'){const ai=aiMV.get(identifier),legacy=read(path.join(DATA,'jobs',identifier,'job.json'));record=ai?.status==='ready'?ai.generated:legacy?.status==='ready'?legacy.project?.generated:null;file=path.join(DATA,'jobs',identifier,'mv.mp4');if(record?.url!==`/files/jobs/${identifier}/mv.mp4`)record=null;}if(kind==='edit'){record=canvasEditor.get(identifier);file=path.join(DATA,'canvas-edits',identifier,'video.mp4');}if(kind==='audio'){record=canvasAudio.get(identifier);file=path.join(DATA,'canvas-audio',identifier,'audio.wav');}if(record?.sha256&&fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&sha(fs.readFileSync(file))===record.sha256)return{file,kind:kind==='audio'?'audio':'video'};}}
 throw Error('找不到已登记的本地素材，请重新上传或选择');
}
function toolMaterials(id,items,namespace){
 const directory=path.join(DATA,'canvas-output-materials');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,namespace+'-'+id+'.json'),saved=read(file,{materials:[]});
 const sources=items.map(({file,name})=>({file,name,bytes:fs.readFileSync(file)})),signature=sha(Buffer.from(JSON.stringify(sources.map(x=>({name:x.name,sha256:sha(x.bytes)})))));
 if(saved.signature===signature&&saved.materials.length===items.length&&saved.materials.every(m=>materials.get(m.id)?.sha256===m.sha256))return saved.materials;
 const result=sources.map(({name,bytes})=>materials.upload(name,bytes));json(file,{id,namespace,signature,materials:result});return result;
}
const templateReferenceImports=new Map();
async function importTemplateReference(templateId,kind,index){
 const template=getOiiPromptTemplate(templateId);if(!template)throw Error('找不到公开模板');if(!['image','video','audio'].includes(kind))throw Error('模板参考类型无效');
 const reference=kind==='image'?template.references.images[index]:template.references[kind],referenceUrl=kind==='image'?template.referenceUrls.images[index]:template.referenceUrls[kind];
 if(typeof reference!=='string'||typeof referenceUrl!=='string')throw Error('模板没有这一项参考素材');const url=new URL(referenceUrl);if(url.protocol!=='https:'||url.hostname!=='api.oiioii.ai'||url.username||url.password||url.port||!['/res/read_file','/res/first_frame'].includes(url.pathname))throw Error('示例素材地址不在已核实的公开来源');
 const extensions={image:['.png','.jpg','.jpeg','.webp','.gif'],video:['.mp4','.mov','.webm'],audio:['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus']},extension=path.extname(new URL(reference).pathname).toLowerCase();if(!extensions[kind].includes(extension))throw Error('模板参考格式尚未支持，请上传自己的素材');
 const cache=path.join(DATA,'template-reference-imports');fs.mkdirSync(cache,{recursive:true});const signature=sha(Buffer.from(kind+'\0'+referenceUrl)),file=path.join(cache,signature+'.json'),old=read(file);if(old&&materials.get(old.material.id)?.sha256===old.material.sha256)return old.material;
 if(templateReferenceImports.has(signature))return await templateReferenceImports.get(signature);
 const task=(async()=>{let target=url,response;for(let redirects=0;redirects<4;redirects++){if(target.protocol!=='https:'||target.username||target.password||target.port&&!['443'].includes(target.port)||!['api.oiioii.ai','res.oiioii.tv'].includes(target.hostname))throw Error('模板示例跳转地址不在已核实的公开素材来源');response=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(45000)});if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');if(response.body)await response.body.cancel();if(!next)throw Error('模板示例跳转信息不完整');target=new URL(next,target);response=null;continue;}break;}if(!response?.ok)throw Error('模板示例素材当前无法下载，可上传自己的参考素材');const limit=kind==='image'?10e6:80e6,chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('模板示例素材超过当前导入大小限制');chunks.push(Buffer.from(chunk));}
 const material=materials.upload(`${template.name} · 参考${index+1}${extension}`,Buffer.concat(chunks));json(file,{material,source:'OiiOii公开模板参考',template_id:template.id});return material;})();templateReferenceImports.set(signature,task);try{return await task;}finally{templateReferenceImports.delete(signature);}
}
const canvasProjects=createCanvasProjects({data:DATA,validate:project=>{validateProject(project);getOutputFormat(project.studio?.ratio);validateCanvasDrawings(project.studio?.canvasDrawings??[]);return true;},write:json});
// The bridge also activates imported/reused songs. Register its active snapshot
// before writing either active-project or song-cache files, including on import.
const musicBridge=createMusicBridge({data:DATA,probe,waveform,write:(file,value)=>{
 if(file===activeProjectFile){validateServerProject(value);const record=canvasProjects.save(value);value.title=record.project.title;}
 json(file,value);
},version});
let legacyDraftId,canvasAssistant;
function materialFilename(value){
 if(typeof value!=='string')return null;
 let pathname;try{pathname=new URL(value,'http://127.0.0.1').pathname;}catch{return null;}
 const match=pathname.match(/^\/(?:mv\/)?files\/materials\/([^/]+)$/);
 if(!match)return null;
 try{return decodeURIComponent(match[1]);}catch{throw Error('素材路径无效');}
}
function walkValues(value,visit){
 if(typeof value==='string')visit(value);
 else if(Array.isArray(value))for(const item of value)walkValues(item,visit);
 else if(value&&typeof value==='object')for(const item of Object.values(value))walkValues(item,visit);
}
function validateServerProject(project){
 validateProject(project);getOutputFormat(project.studio?.ratio);audioPath(project.source);
 const sourceUrl=project.source.id==='sample'?'/assets/sample-song.mp3':'/files/uploads/'+project.source.id;
 if(!Number.isFinite(project.source.duration)||project.source.duration<3||project.source.duration>1200||![sourceUrl,'/mv'+sourceUrl].includes(project.source.url))throw Error('音乐来源地址或时长无效，请重新选择音乐');
 if(project.generated!=null&&(typeof project.generated.url!=='string'||!/^\/(?:mv\/)?files\/jobs\/[a-f0-9-]{36}\/mv\.mp4$/.test(project.generated.url)))throw Error('成片引用无效');
 if(project.studio?.canvas!=null)validateCanvasDocument(project.studio.canvas);
 validateCanvasDrawings(project.studio?.canvasDrawings??[]);
 const handoff=project.musicHandoff;
 if(handoff!=null){
  if(!UUID.test(handoff.id||'')||!UUID.test(handoff.project_id||'')||!/^[a-f0-9]{64}$/.test(handoff.audio_sha256||'')||!project.source.id.endsWith('.mp3')||sha(fs.readFileSync(audioPath(project.source)))!==handoff.audio_sha256)throw Error('关联歌曲来源校验失败，请创建独立MV方案');
 }
 walkValues(project,value=>{const filename=materialFilename(value);if(filename&&!materials.asset(filename))throw Error('画布引用的素材不存在或校验失败');});
 return true;
}
function normalizedProject(input){
 const project=clone(input);
 // Preserve the old draft API while giving its catalogue entry a stable UUID.
 if(project.id==='draft')project.id=legacyDraftId||(legacyDraftId=uid());
 return project;
}
function persistProject(input){const project=normalizedProject(input);musicBridge.persist(project);return project;}
function projectResponse(record){let wave=[];try{wave=waveform(audioPath(record.project.source));}catch{}return{record,project:record.project,waveform:wave};}
function requiredCanvas(id,includeArchived=false){const record=canvasProjects.get(id,{includeArchived});if(!record){const archived=canvasProjects.get(id,{includeArchived:true});const e=Error(archived?'画布已归档，请先恢复':'找不到可用的画布项目');e.status=archived?409:404;throw e;}return record;}
function detachedProject(input){
 const project=clone(input);project.id=uid();
 if(project.musicHandoff){project.studio||={};project.studio.originMusicSnapshot={...clone(project.musicHandoff),mv_project_id:input.id};}
 delete project.musicHandoff;return project;
}
function syncRenamedProject(record){
 validateServerProject(record.project);
 if(read(activeProjectFile)?.id===record.id)musicBridge.persist(record.project);
 else if(record.project.musicHandoff)json(path.join(DATA,'music-projects',record.project.musicHandoff.id+'.json'),record.project);
}
function materialIsReferenced(material){
 const files=[activeProjectFile];
 for(const folder of ['canvas-projects','music-projects','versions','canvas-generation','canvas-output-materials','canvas-first-frames','aliyun-image','aliyun-video','canvas-prompts','mv-director/sessions','mv-director/jobs','mv-director/versions']){
  const directory=path.join(DATA,folder);
  if(!fs.existsSync(directory))continue;
  for(const name of fs.readdirSync(directory))if(name.endsWith('.json'))files.push(path.join(directory,name));
 }
 for(const [folder,recordName]of [['canvas-vision','result.json'],['canvas-edits','job.json'],['canvas-audio','job.json']]){
  const directory=path.join(DATA,folder);if(!fs.existsSync(directory))continue;
  for(const name of fs.readdirSync(directory))if(UUID.test(name))files.push(path.join(directory,name,recordName));
 }
 for(const name of fs.readdirSync(path.join(DATA,'jobs')))if(UUID.test(name))files.push(path.join(DATA,'jobs',name,'job.json'));
 for(const file of files){
  if(!fs.existsSync(file))continue;
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_CANVAS_RECORD_BYTES)throw Object.assign(Error('工程引用信息无法校验，暂不能删除素材'),{status:409});
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Object.assign(Error('工程引用信息无法校验，暂不能删除素材'),{status:409});}
  let found=false;walkValues(value,item=>{const filename=materialFilename(item);if(item===material.id||filename===material.id||filename===path.basename(material.url))found=true;});
  if(found)return true;
 }
 return false;
}
function storeJob(j){const {process:_,...safe}=j;json(path.join(DATA,'jobs',j.id,'job.json'),safe);}
function cancel(j,reason='已停止，完成的历史版本仍保留'){if(!j||['ready','failed','cancelled'].includes(j.status))return;j.status='cancelled';j.message=reason;if(j.process)j.process.kill('SIGTERM');storeJob(j);}
for(const d of fs.readdirSync(path.join(DATA,'jobs'))){const j=read(path.join(DATA,'jobs',d,'job.json'));if(j&&!['ready','failed','cancelled'].includes(j.status)){j.status='cancelled';j.message='服务重启后停止了未完成任务，可手动重试。';json(path.join(DATA,'jobs',d,'job.json'),j);}}
const leases=setInterval(()=>{for(const j of tasks.values())if(!['ready','failed','cancelled'].includes(j.status)&&Date.now()-j.heartbeat>20000)cancel(j,'页面连接已断开，本次制作停止；可从历史版本继续。');},4000);leases.unref();
function clientJob(j){return{id:j.id,status:j.status,received:j.received,total:j.total,progress:j.progress||0,message:j.message||'',url:j.url,versionId:j.versionId,error:j.error,dimensions:j.dimensions,projectId:j.project.id,generated:j.status==='ready'?j.project.generated:undefined};}
function encode(j){
 j.status='encoding';j.progress=90;j.message='合成原曲与字幕';storeJob(j);
 const p=j.project,folder=path.join(DATA,'jobs',j.id),target=path.join(folder,'mv.mp4');
 const proc=spawn(ff,['-y','-v','error','-framerate','24','-i',path.join(folder,'frame-%05d.jpg'),'-ss',String(p.start),'-i',audioPath(p.source),'-map','0:v:0','-map','1:a:0','-t',String(p.duration),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:1',target],{stdio:['ignore','pipe','pipe']});j.process=proc;let err='';
 proc.stderr.on('data',b=>{err=(err+b).slice(-5000)});proc.stdout.on('data',b=>{const m=String(b).match(/out_time_us=(\d+)/);if(m)j.progress=Math.min(99,90+9*Number(m[1])/1e6/p.duration)});
 proc.on('error',()=>{j.status='failed';j.error='视频编码器无法启动，请检查本地FFmpeg。';storeJob(j)});
 proc.on('close',code=>{delete j.process;if(j.status==='cancelled')return;if(code!==0){j.status='failed';j.error='视频合成失败，已保留当前方案，可手动重试。';fs.writeFileSync(path.join(folder,'encode.log'),err);storeJob(j);return;}
  try{const info=probe(target),v=info.streams.find(x=>x.codec_type==='video'),a=info.streams.find(x=>x.codec_type==='audio');if(!v||!a||Number(v.nb_frames)!==j.total)throw Error('成片轨道或帧数不完整');const dimensions=validateOutputDimensions(j.dimensions?.ratio||p.studio?.ratio,v.width,v.height);if(j.dimensions&&(dimensions.width!==j.dimensions.width||dimensions.height!==j.dimensions.height))throw Error('制作任务尺寸不一致');p.generated={url:`/files/jobs/${j.id}/mv.mp4`,sha256:sha(fs.readFileSync(target)),duration:p.duration,dimensions};persistProject(p);const vSaved=version(p,'生成代码MV',p.generated);j.versionId=vSaved.id;json(path.join(folder,'ffprobe.json'),info);j.status='ready';j.progress=100;j.url=p.generated.url;for(const name of fs.readdirSync(folder))if(/^frame-\d+\.jpg$/.test(name))fs.unlinkSync(path.join(folder,name));storeJob(j);}catch{j.status='failed';j.error='成片检查未通过，可从当前方案手动重试。';storeJob(j);}
 });
}
async function body(req,max=2e6){let size=0,arr=[];for await(const b of req){size+=b.length;if(size>max){const e=Error('文件或请求过大');e.status=413;throw e;}arr.push(b);}return Buffer.concat(arr);}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
function serveFile(req,res,file,mime){if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}const size=fs.statSync(file).size,range=req.headers.range;let start=0,end=size-1,status=200;if(range){const m=range.match(/^bytes=(\d+)-(\d*)$/);if(!m||Number(m[1])>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}start=Number(m[1]);end=m[2]?Math.min(size-1,Number(m[2])):size-1;if(end<start){res.writeHead(416);return res.end();}status=206;}
 const headers={'Content-Type':mime||MIME[path.extname(file)]||'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;res.writeHead(status,headers);if(req.method==='HEAD')return res.end();fs.createReadStream(file,{start,end}).pipe(res);
}
async function enrich(p){
 if(!key){const e=Error('故事助手尚未配置，当前可以使用已准备好的故事方案。');e.status=503;throw e;}
 const input={story:p.plan.title,summary:p.plan.summary,creativeBrief:typeof p.studio?.prompt==='string'?p.studio.prompt.slice(0,2000):'',mvType:p.studio?.type||'story',lyrics:p.lyrics.filter(l=>l.end>p.start&&l.start<p.start+p.duration).map(l=>l.text),manualLyrics:String(p.manualLyrics||'').slice(0,4000),shots:p.plan.shots.map(({id,action,label})=>({id,action,label}))};
 const response=await textFetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model,thinking:{type:'disabled'},max_tokens:1400,temperature:.6,response_format:{type:'json_object'},messages:[{role:'system',content:'你是中文MV导演。已有可执行的8镜头故事，按歌词主题与整体情绪优化镜头表达。保持镜头id、动作、顺序和数量不变。返回JSON {"summary":"一句话情感逻辑","shots":[{"id":1,"caption":"此镜可见行动与情绪目的，30字内","camera":"wide或medium或close","warm":0到1}]}。摄影支持拉近、全景，不能描述未提供的新动作。不输出其他字段，不声称直接听过音频。'},{role:'user',content:JSON.stringify(input)}]}),signal:AbortSignal.timeout(60000)});
 if(!response.ok){const e=Error(response.status===429?'文字调用额度或并发已达上限，请稍后或由管理员核对限额':'故事助手本次没有完成，请保留当前方案并核对原任务。');e.status=response.status===429?429:502;throw e;}const raw=await response.json();const record={id:uid(),at:new Date().toISOString(),model:raw.model,usage:raw.usage,response:raw};fs.mkdirSync(path.join(DATA,'model-calls'),{recursive:true});json(path.join(DATA,'model-calls',record.id+'.json'),record);
 let d;try{d=JSON.parse(raw.choices[0].message.content)}catch{throw Error('故事助手返回格式不完整，未覆盖当前方案。');}if(d.shots?.length!==8)throw Error('故事助手未提供8个完整镜头，原方案仍保留。');const next=clone(p);
 for(const [i,x]of d.shots.entries()){if(x.id!==i+1||!['wide','medium','close'].includes(x.camera)||typeof x.caption!=='string'||x.caption.length>90||!Number.isFinite(x.warm)||x.warm<0||x.warm>1)throw Error('镜头内容校验未通过，原方案仍保留。');Object.assign(next.plan.shots[i],{caption:x.caption,camera:x.camera,warm:x.warm});}
 next.planningSource='deepseek';if(typeof d.summary==='string')next.plan.summary=d.summary.slice(0,160);validateProject(next);return next;
}
export function createServer(){return http.createServer(async(req,res)=>{
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
 try{
  const u=new URL(req.url,'http://127.0.0.1'),route=u.pathname,method=req.method;
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host&&method!=='GET')return send(403,{error:'请从当前本地页面操作'});
  if(method==='GET'&&route==='/api/capabilities')return send(200,{...capability(),sampleWave});
  if(method==='POST'&&route==='/api/canvas/generation'){
   const {project,...input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);return send(202,{job:canvasGeneration.submit({...input,project_id:project.id})});
  }
  if(method==='GET'&&route==='/api/canvas/generation'){const id=u.searchParams.get('project_id');if(id&&!UUID.test(id))return send(400,{error:'工程标识无效'});return send(200,{jobs:canvasGeneration.list(id)});}
  const generationRoute=route.match(/^\/api\/canvas\/generation\/([a-f0-9-]{36})$/);if(method==='GET'&&generationRoute){const job=await canvasGeneration.refresh(generationRoute[1]);return job?send(200,{job}):send(404,{error:'生成任务不存在'});}
  if(method==='POST'&&route==='/api/canvas/analyze'){const {project,request_id,prompt,references}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);return send(200,await canvasPrompts.compile({request_id,prompt:prompt||'反推参考图的创作提示词',references,reverse:true}));}
  if(method==='POST'&&route==='/api/canvas/template-reference'){const {project,template_id,kind='image',index=0}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);if(!Number.isInteger(index)||index<0||index>100)throw Error('参考素材序号无效');return send(201,{material:await importTemplateReference(template_id,kind,index)});}
  if(method==='POST'&&route==='/api/canvas/vision'){
   const {project,...input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);const job=await canvasVision.process(input);const registered=toolMaterials(job.id,job.outputs.map(output=>({file:canvasVision.asset(job.id,output.filename).file,name:`${input.operation}-${output.role||output.filename}.png`})),'vision');
   return send(200,{job,materials:registered});
  }
  if(method==='POST'&&route==='/api/canvas/edit'){
   const {project,...input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);const job=await canvasEditor.render({...input,project_id:project.id});let registered=[];if(job.status==='ready')registered=toolMaterials(job.id,[{file:path.join(DATA,'canvas-edits',job.id,'video.mp4'),name:'Osmanthus-剪辑-'+job.id.slice(0,8)+'.mp4'}],'edit');return send(200,{job,materials:registered});
  }
  if(method==='POST'&&(route==='/api/canvas/extract-audio'||route==='/api/canvas/transcribe')){
   const {project,...input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);const job=await canvasAudio[route.endsWith('transcribe')?'transcribe':'extract']({...input,project_id:project.id});let registered=[];if(job.status==='ready')registered=toolMaterials(job.id,[{file:path.join(DATA,'canvas-audio',job.id,'audio.wav'),name:'Osmanthus-'+(route.endsWith('transcribe')?'字幕原声':'分离原声')+'.wav'}],'audio');return send(200,{job,materials:registered});
  }
  if(method==='POST'&&route==='/api/mv-director/open'){
   const {project_id}=JSON.parse(await body(req));const p=requiredCanvas(project_id).project;validateServerProject(p);return send(200,{session:mvDirector.open(p)});
  }
  if(method==='POST'&&route==='/api/mv-director/canvas'){
   const {session_id}=JSON.parse(await body(req)),s=mvDirector.get(session_id);if(!s)return send(404,{error:'找不到MV方案'});
   const project=clone(requiredCanvas(s.project_id).project);validateServerProject(project);let canvas=createCanvasDocument(project.studio?.canvas||{});
   const nodes=[];for(const item of s.plan?[...s.plan.characters,...s.plan.scenes,...s.plan.shots]:[]){const p=s.previews[item.id],material=p&&materials.get(p.materialId);if(material)nodes.push({id:'director-'+p.imageId,type:'image',title:item.name,content:item.description,asset:{id:material.id,url:material.url,name:material.name}});}
   if(s.generated){const asset=mvDirector.asset(s.generated.id);if(asset){const media=toolMaterials(s.generated.id,[{file:asset.file,name:s.title+'-MV.mp4'}],'director')[0];nodes.push({id:'director-movie-'+s.generated.id,type:'video',title:s.title+' · MV',asset:{id:media.id,url:media.url,name:media.name,duration:s.generated.duration}});}}
   const offset=canvas.nodes.reduce((max,n)=>Math.max(max,n.y+n.height),0)+80;
   for(const [i,node] of nodes.entries())if(!canvas.nodes.some(n=>n.id===node.id))canvas=addNode(canvas,{...node,x:(i%4)*380,y:offset+Math.floor(i/4)*310});
   project.studio={...project.studio,canvas,freeCanvas:true,directorSession:s.id,ratio:s.ratio||project.studio?.ratio||'16:9'};persistProject(project);
   return send(200,{url:`/index.html?canvas=${project.id}&director=${s.id}#canvas`});
  }
  if(method==='GET'&&route==='/api/mv-director')return send(200,{sessions:mvDirector.list()});
  if(method==='POST'&&route==='/api/mv-director/jobs')return send(202,{job:mvDirector.start(JSON.parse(await body(req)))});
  if(method==='POST'&&route==='/api/mv-director/recover'){const {job_id}=JSON.parse(await body(req));return send(202,{job:mvDirector.recover(job_id)});}
  const directorJob=route.match(/^\/api\/mv-director\/jobs\/([a-f0-9-]{36})$/);
  if(method==='GET'&&directorJob){const job=mvDirector.job(directorJob[1]);return job?send(200,{job}):send(404,{error:'找不到MV任务'});}
  const directorSession=route.match(/^\/api\/mv-director\/([a-f0-9-]{36})(\/quote)?$/);
  if(method==='GET'&&directorSession){const session=mvDirector.get(directorSession[1]);if(!session)return send(404,{error:'找不到MV方案'});return send(200,directorSession[2]?{estimate:mvDirector.quote(session.id,u.searchParams.get('kind'))}:{session});}
  if(method==='POST'&&route==='/api/ai-mv/plan'){
   const {project,request_id,instruction,duration=10,start=project?.start,ratio=project?.studio?.ratio||'16:9'}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));
   validateServerProject(project);if(project.source.id==='sample')return send(400,{error:'请先选择自己的歌曲或上传音频'});
   if(!key)return send(503,{error:'AI分镜助手尚未配置'});
   const selected=project.lyrics.filter(l=>l.end>start&&l.start<start+duration).map(({start,end,text})=>({start,end,text}));
   if(!['16:9','9:16','1:1','4:3','3:4'].includes(ratio))return send(400,{error:'阿里短流程验证支持16:9、9:16、1:1、4:3和3:4，请先选择其中一种比例'});
   const plan=await aiPlanner.plan({request_id,project_id:project.id,source_sha256:sha(fs.readFileSync(audioPath(project.source))),source_name:project.source.name,source_duration:project.source.duration,start,duration,instruction,lyrics:selected.length?selected:project.manualLyrics,ratio,type:['story','visual','performance'].includes(project.studio?.type)?project.studio.type:'story',style:project.studio?.selectedReferenceStyle?.name||''});
   return send(200,{plan,video:aliVideo.capabilities(),estimatedCostCny:Number(aliVideo.capabilities().estimatedCostCny||1.2)*plan.shots.length});
  }
  if(method==='GET'&&route==='/api/ai-mv/jobs'){const id=u.searchParams.get('project_id');if(id&&!UUID.test(id))return send(400,{error:'工程标识无效'});return send(200,{jobs:aiMV.list(id)});}
  if(method==='POST'&&route==='/api/ai-mv/jobs'){
   const input=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(input.project);
   if(canvasProjects.get(input.project.id,{includeArchived:true})?.archivedAt)return send(409,{error:'画布已归档，请先恢复'});
   return send(202,{job:await aiMV.start(input)});
  }
  const aiJobRoute=route.match(/^\/api\/ai-mv\/jobs\/([a-f0-9-]{36})$/);
  if(method==='GET'&&aiJobRoute){const job=aiMV.get(aiJobRoute[1]);return job?send(200,{job}):send(404,{error:'找不到AI视频任务'});}
  if(method==='GET'&&route==='/api/project'){const project=read(path.join(DATA,'project.json'));let wave=[];try{if(project)wave=waveform(audioPath(project.source));}catch{}return send(200,{project,waveform:wave});}
  if((method==='PUT'||method==='POST')&&route==='/api/project'){const project=persistProject(JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES)));return send(200,{saved:true,project,record:canvasProjects.get(project.id)});}
  if(method==='GET'&&route==='/api/materials')return send(200,{materials:materials.list()});
  if(method==='POST'&&route==='/api/materials'){
   const name=decodeURIComponent(req.headers['x-filename']||''),bytes=await body(req,Math.max(...Object.values(MATERIAL_LIMITS)));
   return send(201,{material:materials.upload(name,bytes)});
  }
  const materialRoute=route.match(/^\/api\/materials\/([a-f0-9-]{36})(?:\/(use-audio))?$/);
  if(materialRoute){
   const id=materialRoute[1],operation=materialRoute[2],material=materials.get(id);
   if(!material)return send(404,{error:'找不到可用的素材'});
   if(method==='GET'&&!operation)return send(200,{material});
   if(method==='DELETE'&&!operation){if(materialIsReferenced(material))return send(409,{error:'素材仍被画布、历史版本或制作任务引用，请先保留或移除相关引用'});if(!materials.remove(id))return send(409,{error:'素材已改变，请刷新后再试'});return send(200,{removed:true});}
   if(method==='POST'&&operation==='use-audio'){
    if(material.kind!=='audio')return send(400,{error:'请选择音频素材作为MV音乐'});
    if(material.duration<3||material.duration>1200)return send(400,{error:'当前支持3秒至20分钟的音频'});
    const {project:input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(input);
    let project=detachedProject(input);const source=materials.asset(id),bytes=fs.readFileSync(source.file);
    if(sha(bytes)!==material.sha256)return send(409,{error:'音频素材已改变，请重新选择'});
    const sourceId=uid()+path.extname(source.file),file=path.join(DATA,'uploads',sourceId);
    fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
    try{
     project=resizePlan(project,Math.min(180,material.duration,project.duration),0);
     project.source={id:sourceId,url:'/files/uploads/'+sourceId,name:material.name,duration:material.duration};
     project.lyrics=[];project.manualLyrics='';project.generated=null;project.planningSource='preset';project.studio||={};project.studio.freeCanvas=false;
     project=persistProject(project);return send(200,projectResponse(canvasProjects.get(project.id)));
    }catch(error){if(!fs.existsSync(path.join(DATA,'canvas-projects',project.id+'.json')))fs.unlinkSync(file);throw error;}
   }
  }
  if(method==='GET'&&route==='/api/canvas-projects')return send(200,{projects:canvasProjects.list({archived:u.searchParams.get('archived')==='1'})});
  if(method==='POST'&&(route==='/api/canvas-projects'||route==='/api/canvas-projects/import')){
   const {project:input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));
   const project=persistProject(route.endsWith('/import')?detachedProject(input):input);
   return send(201,projectResponse(canvasProjects.get(project.id)));
  }
  const canvasRoute=route.match(/^\/api\/canvas-projects\/([a-f0-9-]{36})(?:\/(open|rename|duplicate|archive|restore))?$/);
  if(canvasRoute){
   const id=canvasRoute[1],operation=canvasRoute[2];
   if(method==='GET'&&!operation)return send(200,projectResponse(requiredCanvas(id,u.searchParams.get('archived')==='1')));
   if(method==='POST'&&operation){
    const payload=JSON.parse(await body(req));let record;
    if(operation==='open'){const saved=requiredCanvas(id);persistProject(saved.project);record=canvasProjects.get(id);}
    if(operation==='rename'){validateServerProject(requiredCanvas(id).project);record=canvasProjects.rename(id,payload.title);syncRenamedProject(record);}
    if(operation==='duplicate')record=canvasProjects.duplicate(id,payload);
    if(operation==='archive')record=canvasProjects.archive(id);
    if(operation==='restore')record=canvasProjects.restore(id);
    return send(operation==='duplicate'?201:200,projectResponse(record));
   }
  }
  if(method==='POST'&&route==='/api/canvas-assist'){
   if(!key)return send(503,{error:'画布助手尚未配置，当前可手动编辑画布',code:'ASSISTANT_UNAVAILABLE'});
   if(!canvasAssistant){const {createCanvasAssistant}=await import('./canvas-assistant.mjs');canvasAssistant=createCanvasAssistant({data:DATA,key,model,fetchImpl:textFetch});}
   return send(200,await canvasAssistant.assist(JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES))));
  }
  if(method==='GET'&&route==='/api/versions'){const arr=fs.readdirSync(path.join(DATA,'versions')).filter(x=>x.endsWith('.json')).map(x=>read(path.join(DATA,'versions',x))).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return send(200,{versions:arr});}
  if(method==='POST'&&route==='/api/versions'){const {project,label,output}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));validateServerProject(project);if(output&&JSON.stringify(output)!==JSON.stringify(project.generated))return send(400,{error:'历史成片与当前工程不一致'});return send(201,{version:version(project,String(label||'保存方案').slice(0,100),output||null)});}
  if(method==='POST'&&route==='/api/plan'){
   if(!key)return send(503,{error:'故事助手尚未配置，当前可以使用已准备好的故事方案。'});
   const {project}=JSON.parse(await body(req));validateServerProject(project);
   return send(200,{project:await legacyPlanning.plan(project)});
  }
  if(method==='POST'&&route==='/api/music-import'){const {handoff_id}=JSON.parse(await body(req));return send(200,await musicBridge.importMusic(handoff_id));}
  if(method==='POST'&&route==='/api/import-link')return send(501,{error:'平台分享链接的解析通道尚未接通。当前请上传音频，或从示例开始。'});
  if(method==='POST'&&route==='/api/upload'){
   const ext=path.extname(decodeURIComponent(req.headers['x-filename']||'')).toLowerCase();if(!['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus'].includes(ext))return send(400,{error:'请上传MP3、WAV、M4A、AAC、FLAC或OGG音频'});
   const b=await body(req,80e6),id=uid()+ext,file=path.join(DATA,'uploads',id);fs.writeFileSync(file,b);let info;try{info=probe(file);if(!info.streams.some(x=>x.codec_type==='audio'))throw Error();}catch{fs.unlinkSync(file);return send(400,{error:'文件无法识别为有效音频，请换一个文件'});}
   const duration=Number(info.format.duration);if(!Number.isFinite(duration)||duration<3||duration>1200){fs.unlinkSync(file);return send(400,{error:'当前支持3秒至20分钟的音频'});}return send(201,{source:{id,url:'/files/uploads/'+id,name:decodeURIComponent(req.headers['x-filename']),duration},waveform:waveform(file)});
  }
  if(method==='POST'&&route==='/api/render'){
   if(!capability().freeRender)return send(503,{error:'本地视频编码器暂不可用，仍可预览分镜'});const {project:input}=JSON.parse(await body(req,MAX_CANVAS_RECORD_BYTES));const project=normalizedProject(input);validateServerProject(project);const dimensions=getOutputFormat(project.studio?.ratio);
   if(project.studio?.freeCanvas&&project.source.id==='sample')return send(400,{error:'请先为自由画布选择音乐，再生成MV'});
   if(canvasProjects.get(project.id,{includeArchived:true})?.archivedAt)return send(409,{error:'画布已归档，请先恢复再制作'});
   if([...tasks.values()].some(j=>!['ready','failed','cancelled'].includes(j.status)))return send(409,{error:'已有一个制作任务正在运行，请完成或停止后再试'});
   const id=uid(),folder=path.join(DATA,'jobs',id);fs.mkdirSync(folder);const j={id,project:clone(project),dimensions,total:Math.round(project.duration*24),received:0,status:'frames',progress:0,heartbeat:Date.now(),startedAt:new Date().toISOString()};tasks.set(id,j);storeJob(j);version(project,'开始制作前的方案');return send(201,clientJob(j));
  }
  const m=route.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(frame|finish|heartbeat|cancel))?$/);
  if(m){const id=m[1],op=m[2],j=tasks.get(id)||read(path.join(DATA,'jobs',id,'job.json'));if(!j)return send(404,{error:'任务不存在'});
   if(method==='GET'&&!op)return send(200,clientJob(j));
   if(method==='POST'&&op==='heartbeat'){j.heartbeat=Date.now();return send(200,{alive:!['failed','cancelled'].includes(j.status)});}
   if(method==='POST'&&op==='cancel'){cancel(j);return send(200,clientJob(j));}
   if(method==='POST'&&op==='frame'){if(j.status!=='frames')return send(409,{error:'该任务已停止或已进入合成阶段'});const index=Number(u.searchParams.get('index'));if(!Number.isInteger(index)||index<0||index>=j.total)return send(400,{error:'画面序号无效'});const b=await body(req,1.5e6);if(b[0]!==255||b[1]!==216)return send(400,{error:'画面格式无效'});const file=path.join(DATA,'jobs',id,`frame-${String(index).padStart(5,'0')}.jpg`);if(fs.existsSync(file)){if(sha(fs.readFileSync(file))!==sha(b))return send(409,{error:'同一帧收到不同内容，请手动重试'});}else{fs.writeFileSync(file,b);j.received++;}j.heartbeat=Date.now();j.progress=j.received/j.total*88;return send(200,{received:j.received});}
   if(method==='POST'&&op==='finish'){if(j.status!=='frames')return send(409,{error:'任务状态不允许重复合成'});if(j.received!==j.total)return send(409,{error:'画面还没有完整上传，请手动重试'});encode(j);return send(202,clientJob(j));}
  }
  if(method==='GET'||method==='HEAD'){
   const directorMedia=route.match(/^\/files\/mv-director\/([a-f0-9-]{36})\/mv\.mp4$/);
   if(directorMedia){const asset=mvDirector.asset(directorMedia[1]);return asset?serveFile(req,res,asset.file,'video/mp4'):send(404,{error:'MV尚未完成或文件校验失败'});}
   const generatedImage=route.match(/^\/files\/aliyun-image\/([a-f0-9-]{36})\/image\.png$/);if(generatedImage){const asset=imageModel.asset(generatedImage[1]);return asset?serveFile(req,res,asset.file,'image/png'):send(404,{error:'图片不存在'});}
   const generatedSpeech=route.match(/^\/files\/aliyun-speech\/([a-f0-9-]{36})\/audio\.wav$/);if(generatedSpeech){const asset=speechModel.asset(generatedSpeech[1]);return asset?serveFile(req,res,asset.file,'audio/wav'):send(404,{error:'语音不存在'});}
   const visionFile=route.match(/^\/files\/canvas-vision\/([a-f0-9-]{36})\/([A-Za-z0-9_.-]+\.png)$/);if(visionFile){const asset=canvasVision.asset(visionFile[1],visionFile[2]);return asset?serveFile(req,res,asset.file,'image/png'):send(404,{error:'图片不存在'});}
   const localEdit=route.match(/^\/files\/(canvas-edits|canvas-audio)\/([a-f0-9-]{36})\/(video\.mp4|audio\.wav)$/);if(localEdit){const record=localEdit[1]==='canvas-edits'?canvasEditor.get(localEdit[2]):canvasAudio.get(localEdit[2]);if(!record||record.status!=='ready'||localEdit[3]!== (localEdit[1]==='canvas-edits'?'video.mp4':'audio.wav'))return send(404,{error:'素材不存在'});return serveFile(req,res,path.join(DATA,localEdit[1],localEdit[2],localEdit[3]));}
   const aliMedia=route.match(/^\/files\/aliyun-video\/([a-f0-9-]{36})\/video\.mp4$/);
   if(aliMedia){const asset=aliVideo.asset(aliMedia[1]);if(!asset)return send(404,{error:'镜头尚未生成或校验未通过'});return serveFile(req,res,asset.file,'video/mp4');}
   const aiPoster=route.match(/^\/files\/ai-mv-jobs\/([a-f0-9-]{36})\/shot-([12])\.jpg$/);
   if(aiPoster)return serveFile(req,res,path.join(DATA,'ai-mv-jobs',aiPoster[1],`shot-${aiPoster[2]}.jpg`),'image/jpeg');
   let file;if(route.startsWith('/files/materials/')){const found=materials.asset(decodeURIComponent(route.slice('/files/materials/'.length)));if(!found)return send(404,{error:'Not found'});return serveFile(req,res,found.file,found.mime);}
   if(route.startsWith('/files/uploads/')){const name=decodeURIComponent(route.slice(15));if(!/^[a-f0-9-]{36}\.[a-z0-9]+$/.test(name))return send(404,{error:'Not found'});file=path.join(DATA,'uploads',name);}
   else if(/^\/files\/jobs\/[a-f0-9-]{36}\/mv\.mp4$/.test(route)){let asset;try{asset=resolveCanvasAsset('mv:'+route.split('/')[3]);}catch{}return asset?serveFile(req,res,asset.file,'video/mp4'):send(404,{error:'成片不存在或校验失败'});}
   else{const name=decodeURIComponent(route==='/'?'/director.html':route);file=path.resolve(PUBLIC,'.'+name);if(!file.startsWith(PUBLIC+path.sep))return send(404,{error:'Not found'});}
   return serveFile(req,res,file);
  }
  send(404,{error:'这个操作暂不可用'});
 }catch(e){const details={};if(typeof e.code==='string')details.code=e.code;for(const name of ['retryBlocked','uncertain','replayed'])if(typeof e[name]==='boolean')details[name]=e[name];send(e.status||400,{error:String(e.message).slice(0,240),...details})}
 });}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT||8792);createServer().listen(port,'127.0.0.1',()=>console.log(`Osmanthus MV: http://127.0.0.1:${port}`));}
