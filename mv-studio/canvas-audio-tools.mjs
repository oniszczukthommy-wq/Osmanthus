import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

export const CANVAS_AUDIO_LIMITS=Object.freeze({seconds:60,minSeconds:.2,assetBytes:16_000_000,segments:400,textChars:20000,recordBytes:256_000});
export const CANVAS_ASR_ENGINE='faster-whisper-base-1.2.1-cpu-int8';
const SCHEMA='osmanthus-canvas-audio-v1';
const SPEECH_ROOT=fileURLToPath(new URL('./models/whisper-base/',import.meta.url));
const DEFAULT_PYTHON=fileURLToPath(new URL('./.venv/bin/python',import.meta.url));
const DEFAULT_MODEL=SPEECH_ROOT;
const DEFAULT_WORKER=fileURLToPath(new URL('./canvas-audio-worker.py',import.meta.url));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const SHA=/^[a-f0-9]{64}$/;
const EXTENSIONS=new Set(['.wav','.mp3','.m4a','.aac','.flac','.ogg','.opus','.mp4','.mov','.webm','.mkv']);
const LANGUAGES=new Set(['auto','zh','en','ja','ko']);
const ACTIVE=new Set(['pending','extracting','transcribing']);
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fingerprint=value=>hash(canonical(value));
const problem=(message,status=400)=>Object.assign(new Error(message),{status,canvasAudioError:true});
const content=input=>{const{request_id,...rest}=input;return rest;};
const localEnv=()=>({...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_DATASETS_OFFLINE:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'1',TOKENIZERS_PARALLELISM:'false'});
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.includes(key)))throw problem(`${label}包含不支持的字段`);}
function finite(value,label,min=0,max=Infinity){if(!Number.isFinite(value)||value<min||value>max)throw problem(`${label}需要有效的范围内数字`);return Number(value.toFixed(6));}
function normalize(raw,mode){
 if(!['extract','transcribe'].includes(mode))throw problem('音频操作无效');
 keys(raw,['request_id','project_id','asset_id','start','end',...(mode==='transcribe'?['language']:[])],'音频请求');
 if(!UUID.test(raw.request_id||'')||!UUID.test(raw.project_id||''))throw problem('音频请求和工程需要合法UUID标识');
 if(typeof raw.asset_id!=='string'||!ID.test(raw.asset_id)||raw.asset_id.includes('..'))throw problem('请选择有效的本地素材ID，不能提交路径或远程地址');
 const start=finite(raw.start??0,'选段起点'),end=raw.end===undefined?null:finite(raw.end,'选段终点');
 if(end!==null&&(end-start<CANVAS_AUDIO_LIMITS.minSeconds-.000001||end-start>CANVAS_AUDIO_LIMITS.seconds+.000001))throw problem('音频选段需为0.2至60秒，且终点必须晚于起点');
 const language=mode==='transcribe'?(raw.language??'auto'):null;
 if(language!==null&&!LANGUAGES.has(language))throw problem('转写语言支持自动识别、中文、英文、日文或韩文');
 return{request_id:raw.request_id,project_id:raw.project_id,asset_id:raw.asset_id,start,end,mode,language};
}
function normalizedStored(input){const {mode,language,end,...raw}=input;return normalize({...raw,...(end===null?{}:{end}),...(mode==='transcribe'?{language}:{})},mode);}
function fileHash(file,maxBytes=CANVAS_AUDIO_LIMITS.assetBytes){
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>maxBytes)throw Error();return hash(fs.readFileSync(fd));}catch{throw problem('本地音频文件读取或容量校验失败',409);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function mediaDuration(info,audio){for(const value of [audio?.duration,info?.format?.duration]){const duration=Number(value);if(Number.isFinite(duration)&&duration>0)return duration;}return 0;}
function cleanText(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw problem(`${label}为空、过长或含无效字符`,502);return value.trim();}
function normalizeTranscript(raw,duration){
 keys(raw,['status','text','segments','language','language_probability','duration','engine'],'转写结果');
 if(raw.status!=='ready'||raw.engine!==CANVAS_ASR_ENGINE||typeof raw.language!=='string'||!/^[a-z]{2,3}$/.test(raw.language)||!Number.isFinite(raw.language_probability)||raw.language_probability<0||raw.language_probability>1||!Number.isFinite(raw.duration)||Math.abs(raw.duration-duration)>.1)throw problem('本地转写结果未通过模型或时长校验',502);
 if(!Array.isArray(raw.segments)||!raw.segments.length||raw.segments.length>CANVAS_AUDIO_LIMITS.segments)throw problem('未识别到可用语音，或转写分段超过400条；请缩短选段后重试',422);
 let previous=-1,chars=0;
 const segments=raw.segments.map(segment=>{keys(segment,['start','end','text'],'字幕分段');if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start||segment.end>duration+.1||segment.start<previous||segment.start>=duration)throw problem('本地转写时间戳超出音频选段或顺序无效',502);previous=segment.start;const text=cleanText(segment.text,2000,'字幕分段');chars+=text.length;return{start:Number(segment.start.toFixed(6)),end:Number(Math.min(segment.end,duration).toFixed(6)),text};});
 const text=cleanText(raw.text,CANVAS_AUDIO_LIMITS.textChars,'转写文字');
 if(chars>CANVAS_AUDIO_LIMITS.textChars||text.replace(/\s/g,'')!==segments.map(segment=>segment.text).join('').replace(/\s/g,''))throw problem('本地转写正文与分段不一致，或超过20000字',502);
 return{text,segments,language:raw.language,language_probability:raw.language_probability,duration,engine:CANVAS_ASR_ENGINE,review_required:true,accuracy:'unverified-asr',segment_time_base:'extracted-audio'};
}

/** Trusted resolveAsset(id) returns {file}, including the existing material-store
 * {file,mime,material} shape. Input is always an ID, never a path/URL. All work
 * uses frozen local copies; extraction does not alter the project or its source.
 * Optional executor paths/workerRunner are trusted server configuration only.
 * extract/transcribe await a durable ready/failed job; rejected inputs throw.
 */
export function createCanvasAudioTools({data,ffmpeg,probe,resolveAsset,python=process.env.MV_ASR_PYTHON||DEFAULT_PYTHON,modelPath=process.env.MV_ASR_MODEL||DEFAULT_MODEL,workerPath=process.env.MV_ASR_WORKER||DEFAULT_WORKER,workerRunner}={}){
 if(typeof data!=='string'||!data||typeof ffmpeg!=='string'||!ffmpeg||typeof probe!=='function'||typeof resolveAsset!=='function'||typeof python!=='string'||typeof modelPath!=='string'||typeof workerPath!=='string'||(workerRunner!==undefined&&typeof workerRunner!=='function'))throw new TypeError('本地音频工具需要data、ffmpeg、probe与resolveAsset');
 const root=path.resolve(data,'canvas-audio');fs.mkdirSync(root,{recursive:true});const rootStat=fs.lstatSync(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw problem('音频工具目录不能是符号链接',500);
 const working=new Map(),contentWorking=new Map();
 function assertRoot(){const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==rootStat.dev||stat.ino!==rootStat.ino)throw problem('音频工具目录已改变，请重新启动服务',409);}
 function directory(id){if(!UUID.test(id||''))throw problem('音频任务标识无效');return path.join(root,id);}
 function assertDirectory(id){assertRoot();const dir=directory(id),stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw problem('音频任务目录无效',409);return dir;}
 function capabilities(){
  const present=file=>{try{return fs.statSync(file).isFile();}catch{return false;}},pythonPresent=present(python),modelPresent=['model.bin','config.json','tokenizer.json','vocabulary.txt'].every(name=>present(path.join(modelPath,name))),workerPresent=present(workerPath),extractAvailable=present(ffmpeg);
  let modulePresent=false;if(pythonPresent){const check=spawnSync(python,['-B','-c',"import importlib.util; print('yes' if importlib.util.find_spec('faster_whisper') else 'no')"],{encoding:'utf8',timeout:3000,maxBuffer:1000,env:localEnv()});modulePresent=check.status===0&&check.stdout.trim()==='yes';}
  const transcribeAvailable=extractAvailable&&(!!workerRunner||(pythonPresent&&modelPresent&&workerPresent&&modulePresent));
  return{engine:CANVAS_ASR_ENGINE,provider:'local-whisper',localOnly:true,downloadsAllowed:false,pythonPresent,modelPresent,workerPresent,modulePresent,extractAvailable,transcribeAvailable,available:transcribeAvailable,limits:clone(CANVAS_AUDIO_LIMITS)};
 }
 function read(id){
  assertRoot();const dir=directory(id),target=path.join(dir,'job.json');let stat;try{assertDirectory(id);stat=fs.lstatSync(target);}catch(cause){if(cause.code==='ENOENT')return null;throw cause;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>CANVAS_AUDIO_LIMITS.recordBytes)throw problem('音频任务记录无效',409);
  let job,fd;try{fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw Error();job=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw problem('音频任务记录损坏',409);}finally{if(fd!==undefined)fs.closeSync(fd);}
  try{
   const input=normalizedStored(job.input);if(canonical(input)!==canonical(job.input)||job.schema!==SCHEMA||job.id!==id||job.id!==input.request_id||job.project_id!==input.project_id||!['pending','extracting','transcribing','ready','failed'].includes(job.status)||job.inputHash!==fingerprint(content(input))||!SHA.test(job.source?.sha256||'')||!Number.isInteger(job.source.bytes)||job.source.bytes<1||job.source.bytes>CANVAS_AUDIO_LIMITS.assetBytes||!Number.isFinite(job.source.duration)||job.source.duration<=0||job.signature!==fingerprint({input:content(input),source:job.source}))throw Error();
   const range=job.selection;if(range.start!==input.start||!Number.isFinite(range.end)||!Number.isFinite(range.duration)||range.duration<CANVAS_AUDIO_LIMITS.minSeconds-.000001||range.duration>CANVAS_AUDIO_LIMITS.seconds+.000001||Math.abs(range.end-range.start-range.duration)>.000001||range.end>job.source.duration+.05||(input.end!==null&&range.end!==input.end))throw Error();
   if(job.audio){const a=job.audio;if(a.url!==`/files/canvas-audio/${id}/audio.wav`||!SHA.test(a.sha256||'')||!Number.isFinite(a.duration)||a.duration<CANVAS_AUDIO_LIMITS.minSeconds-.01||Math.abs(a.duration-range.duration)>.1||a.codec!=='pcm_s16le'||a.sampleRate!==16000||a.channels!==1||a.bits!==16)throw Error();}
   if(job.status==='ready'){if(!job.audio)throw Error();if(input.mode==='transcribe'){const t=job.transcript;if(canonical(normalizeTranscript({status:'ready',text:t.text,segments:t.segments,language:t.language,language_probability:t.language_probability,duration:t.duration,engine:t.engine},job.audio.duration))!==canonical(t))throw Error();}else if(job.transcript)throw Error();}
   return job;
  }catch{throw problem('音频任务未通过完整性校验',409);}
 }
 function save(job){const dir=assertDirectory(job.id),target=path.join(dir,'job.json'),temp=path.join(dir,'.job-'+crypto.randomUUID()+'.tmp'),bytes=JSON.stringify(job,null,2);if(Buffer.byteLength(bytes)>CANVAS_AUDIO_LIMITS.recordBytes)throw problem('音频任务记录超过容量限制',413);try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});fs.renameSync(temp,target);}finally{try{fs.unlinkSync(temp);}catch(cause){if(cause.code!=='ENOENT')throw cause;}}}
 function publicJob(job,replayed=false){const result={schema:SCHEMA,id:job.id,project_id:job.project_id,asset_id:job.input.asset_id,mode:job.input.mode,status:job.status,start:job.selection.start,end:job.selection.end,duration:job.selection.duration,source_sha256:job.source.sha256,createdAt:job.createdAt,updatedAt:job.updatedAt,message:job.message,replayed};if(job.error)result.error=job.error;if(job.audio){result.audio=clone(job.audio);result.url=job.audio.url;result.sha256=job.audio.sha256;}if(job.transcript){Object.assign(result,clone(job.transcript));result.transcript=clone(job.transcript);}return result;}
 function verifyAudio(job){try{const file=path.join(assertDirectory(job.id),'audio.wav'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||fileHash(file)!==job.audio.sha256)throw Error();}catch{throw problem('已提取音频文件缺失或指纹校验失败',409);}}
 function get(id){const job=read(id);if(!job)return null;if(job.status==='ready')verifyAudio(job);return publicJob(job);}
 function list(projectId){if(projectId!==undefined&&!UUID.test(projectId||''))throw problem('工程标识无效');assertRoot();return fs.readdirSync(root).filter(name=>UUID.test(name)).map(read).filter(job=>job&&(!projectId||job.project_id===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(job=>publicJob(job));}
 async function resolveInput(input){
  let resolved;try{resolved=await resolveAsset(input.asset_id);}catch{throw problem('找不到当前工程可使用的本地素材',404);}const file=resolved?.file;
  if(typeof file!=='string'||!path.isAbsolute(file)||!EXTENSIONS.has(path.extname(file).toLowerCase()))throw problem('素材解析器未返回受支持的本地音频或视频');
  let stat;try{stat=fs.lstatSync(file);}catch{throw problem('本地素材文件不存在',404);}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>CANVAS_AUDIO_LIMITS.assetBytes)throw problem('音频素材需为本机普通文件，且不能超过16MB',413);
  let info;try{info=await probe(file);}catch{throw problem('本地素材无法读取，请使用有效音频或视频');}const audio=info?.streams?.find(stream=>stream.codec_type==='audio'),duration=mediaDuration(info,audio);if(!audio||!duration)throw problem('所选素材没有可用音轨');
  const end=input.end??duration,selected=Number((end-input.start).toFixed(6));if(selected<CANVAS_AUDIO_LIMITS.minSeconds-.000001||selected>CANVAS_AUDIO_LIMITS.seconds+.000001)throw problem('音频选段需为0.2至60秒；长素材请先选择起止时间');if(input.start>=duration||end>duration+.05)throw problem('音频选段超出原素材时长');
  return{file,source:{sha256:fileHash(file),bytes:stat.size,duration},selection:{start:input.start,end,duration:selected}};
 }
 function execute(binary,args,dir,label,timeout=120000){return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd:dir,env:localEnv(),stdio:['ignore','ignore','pipe']});let diagnostic='',settled=false,timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  const finish=cause=>{if(settled)return;settled=true;clearTimeout(timer);if(cause)reject(cause);else resolve();};child.stderr.on('data',bytes=>{diagnostic=(diagnostic+String(bytes)).slice(-8000);});child.on('error',()=>finish(problem(`${label}无法启动`,503)));child.on('close',code=>{if(code===0&&!timedOut)return finish();try{fs.writeFileSync(path.join(dir,label==='本地语音模型'?'worker.log':'extract.log'),diagnostic,{mode:0o600});}catch{}finish(problem(timedOut?`${label}处理超时，任务已停止`:`${label}处理未完成；请检查素材后用新请求重试`,500));});
 });}
 async function transcribeAudio(job,dir){
  job.status='transcribing';job.message='正在使用本机Whisper模型识别语音，结果需要校对';job.updatedAt=new Date().toISOString();save(job);
  const contract={audioFile:path.join(dir,'audio.wav'),outputFile:path.join(dir,'transcription.json'),python,modelPath,workerPath,language:job.input.language,lockPath:path.join(root,'inference.lock'),maxSeconds:CANVAS_AUDIO_LIMITS.seconds,maxBytes:CANVAS_AUDIO_LIMITS.assetBytes};
  let result;if(workerRunner)result=await workerRunner(contract);else{await execute(python,['-B',workerPath,'--audio',contract.audioFile,'--output',contract.outputFile,'--model',modelPath,'--language',job.input.language,'--lock',contract.lockPath],dir,'本地语音模型');let fd;try{const stat=fs.lstatSync(contract.outputFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>CANVAS_AUDIO_LIMITS.recordBytes)throw Error();fd=fs.openSync(contract.outputFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));result=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw problem('本地语音模型没有返回可校验的转写结果',502);}finally{if(fd!==undefined)fs.closeSync(fd);}}
  if(result?.status==='empty')throw problem('该选段未识别到清晰语音；可以调整选段或手动填写字幕',422);
  return normalizeTranscript(result,job.audio.duration);
 }
 async function prepare(job,resolved,previous){
  const dir=assertDirectory(job.id);
  if(previous){verifyAudio(previous);fs.copyFileSync(path.join(directory(previous.id),'audio.wav'),path.join(dir,'audio.wav'),fs.constants.COPYFILE_EXCL);job.audio={...clone(previous.audio),url:`/files/canvas-audio/${job.id}/audio.wav`};if(previous.transcript)job.transcript=clone(previous.transcript);job.reusedFrom=previous.id;}
  else{
   const frozen=path.join(dir,'source'+path.extname(resolved.file).toLowerCase());fs.copyFileSync(resolved.file,frozen,fs.constants.COPYFILE_EXCL);if(fs.statSync(frozen).size!==job.source.bytes||fileHash(frozen)!==job.source.sha256)throw problem('素材在准备期间发生变化，已停止处理',409);
   job.status='extracting';job.message='正在提取所选音轨';job.updatedAt=new Date().toISOString();save(job);
   const target=path.join(dir,'audio.wav');await execute(ffmpeg,['-nostdin','-v','error','-y','-threads','1','-protocol_whitelist','file,pipe','-ss',String(job.selection.start),'-t',String(job.selection.duration),'-i',frozen,'-map','0:a:0','-vn','-ar','16000','-ac','1','-c:a','pcm_s16le','-t',String(job.selection.duration),target],dir,'本地音频编码器',60000);
   let info;try{info=await probe(target);}catch{throw problem('提取音频无法读取',500);}const audio=info?.streams?.find(stream=>stream.codec_type==='audio'),duration=mediaDuration(info,audio);
   if(!audio||audio.codec_name!=='pcm_s16le'||Number(audio.sample_rate)!==16000||audio.channels!==1||duration<CANVAS_AUDIO_LIMITS.minSeconds-.01||Math.abs(duration-job.selection.duration)>.1)throw problem('提取音轨的格式或时长校验失败',500);
   job.audio={url:`/files/canvas-audio/${job.id}/audio.wav`,sha256:fileHash(target),duration,codec:'pcm_s16le',sampleRate:16000,channels:1,bits:16};
   if(job.input.mode==='transcribe')job.transcript=await transcribeAudio(job,dir);
  }
  job.status='ready';job.message=job.input.mode==='transcribe'?'本机语音转写完成，字幕可编辑，请逐句校对':'已提取本地WAV音轨，可下载或加入素材';job.updatedAt=new Date().toISOString();save(job);return publicJob(job,!!previous);
 }
 async function perform(input,inputHash){
  const resolved=await resolveInput(input),signature=fingerprint({input:content(input),source:resolved.source});
  if(contentWorking.has(signature))await contentWorking.get(signature);
  const previous=fs.readdirSync(root).filter(name=>UUID.test(name)).map(read).find(job=>job?.status==='ready'&&job.signature===signature);
  if(input.mode==='transcribe'&&!previous&&!capabilities().transcribeAvailable)throw problem('本机Whisper模型或Python环境不可用；未下载或调用远程服务',503);
  const dir=directory(input.request_id);try{assertRoot();fs.mkdirSync(dir);}catch(cause){if(cause.code==='EEXIST')throw problem('该音频请求已登记，请读取原任务',409);throw cause;}
  const now=new Date().toISOString(),job={schema:SCHEMA,id:input.request_id,project_id:input.project_id,inputHash,signature,input,source:resolved.source,selection:resolved.selection,status:'pending',createdAt:now,updatedAt:now,message:'音频任务已保存，准备本地处理'};save(job);
  const task=(async()=>{try{return await prepare(job,resolved,previous);}catch(cause){job.status='failed';job.error=cause.canvasAudioError?cause.message.slice(0,240):'本地音频处理未完成，请保留原素材并用新请求重试';job.message='音频处理未完成，原始素材保持不变';job.updatedAt=new Date().toISOString();save(job);return publicJob(job);}})();contentWorking.set(signature,task);
  try{return await task;}finally{if(contentWorking.get(signature)===task)contentWorking.delete(signature);}
 }
 async function submit(raw,mode){
  const input=normalize(raw,mode),inputHash=fingerprint(content(input)),active=working.get(input.request_id);if(active){if(active.inputHash!==inputHash)throw problem('同一音频请求不能改用其他素材、选段或操作',409);return{...clone(await active.promise),replayed:true};}
  const previous=read(input.request_id);if(previous){if(previous.inputHash!==inputHash)throw problem('同一音频请求不能改用其他素材、选段或操作',409);if(previous.status==='ready')verifyAudio(previous);return publicJob(previous,true);}
  const promise=perform(input,inputHash);working.set(input.request_id,{inputHash,promise});try{return await promise;}finally{working.delete(input.request_id);}
 }
 for(const id of fs.readdirSync(root).filter(name=>UUID.test(name))){const job=read(id);if(job&&ACTIVE.has(job.status)){job.status='failed';job.error='服务重启后未完成的本地音频任务已停止，请用新请求重试';job.message=job.error;job.updatedAt=new Date().toISOString();save(job);}}
 return Object.freeze({extract:raw=>submit(raw,'extract'),transcribe:raw=>submit(raw,'transcribe'),get,list,capabilities});
}
