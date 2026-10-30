import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {getOutputFormat} from './public/output-format.js';
import {selectSubtitleFont} from './subtitle-fonts.mjs';

export const CANVAS_VIDEO_LIMITS=Object.freeze({clips:8,duration:60,minClipDuration:.04,assetBytes:200_000_000,subtitleCues:120,subtitleChars:12000,recordBytes:180_000});
const SCHEMA='osmanthus-canvas-video-edit-v1';
export const SUBTITLE_RENDERER_VERSION='explicit-font-drawtext-v2';

export function wrapSubtitleText(text,columns){
 const result=[];for(const source of text.replace(/\r/g,'').split('\n')){let line='',width=0;for(const char of source){const units=/\p{Mark}/u.test(char)?0:char.codePointAt(0)>0xff?2:1;if(width+units>columns&&line){result.push(line);line='';width=0;}line+=char;width+=units;}result.push(line);}return result.join('\n');
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const EXTENSIONS=new Set(['.mp4','.mov','.webm','.mkv','.wav','.mp3','.m4a','.aac','.flac','.ogg','.opus']);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const fingerprint=value=>hash(canonical(value));
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const number=(value,label,min=0,max=Infinity)=>{if(!Number.isFinite(value)||value<min||value>max)throw error(`${label}需为${min}至${Number.isFinite(max)?max:'允许范围内'}的有限数字`);return Number(value.toFixed(6));};
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.includes(key)))throw error(`${label}包含不支持的字段`);}
function assetId(value){if(typeof value!=='string'||!ID.test(value)||value.includes('..'))throw error('请选择有效的本地素材ID，不能提交路径或远程地址');return value;}
function subtitleText(value,max){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw error('字幕文字为空、过长或包含无效字符');return value.trim();}
function normalizeInput(raw){
 keys(raw,['request_id','project_id','clips','audio','ratio','subtitles'],'时间线请求');
 if(!UUID.test(raw.request_id||'')||!UUID.test(raw.project_id||''))throw error('制作请求和工程需要合法UUID标识');
 if(!Array.isArray(raw.clips)||!raw.clips.length||raw.clips.length>CANVAS_VIDEO_LIMITS.clips)throw error('本轮本地视频编辑支持1至8个片段');
 let audio=null;if(raw.audio!=null){keys(raw.audio,['id','start','gain'],'配乐');audio={id:assetId(raw.audio.id),start:number(raw.audio.start??0,'配乐起点'),gain:number(raw.audio.gain??1,'配乐音量',0,4)};}
 const clips=raw.clips.map(clip=>{keys(clip,['id','start','end','mute','gain'],'视频片段');const start=number(clip.start,'片段起点'),end=number(clip.end,'片段终点');if(end-start<CANVAS_VIDEO_LIMITS.minClipDuration-.000001)throw error('每个视频片段至少需0.04秒，且终点必须晚于起点');if(clip.mute!==undefined&&typeof clip.mute!=='boolean')throw error('静音选项需要布尔值');return{id:assetId(clip.id),start,end,mute:clip.mute??!!audio,gain:number(clip.gain??1,'片段音量',0,4)};});
 const duration=Number(clips.reduce((sum,clip)=>sum+clip.end-clip.start,0).toFixed(6));if(duration>CANVAS_VIDEO_LIMITS.duration)throw error('本轮本地视频编辑的总时长不能超过60秒');
 const ratio=raw.ratio===undefined?'16:9':raw.ratio;try{getOutputFormat(ratio);}catch{throw error('视频画面比例不受支持');}
 let subtitles=raw.subtitles??[];
 if(typeof subtitles==='string')subtitles=[{start:0,end:duration,text:subtitleText(subtitles,1200)}];
 if(!Array.isArray(subtitles)||subtitles.length>CANVAS_VIDEO_LIMITS.subtitleCues)throw error('字幕最多支持120条');
 let chars=0;subtitles=subtitles.map(cue=>{keys(cue,['start','end','text'],'字幕');const start=number(cue.start,'字幕起点'),end=number(cue.end,'字幕终点');if(end<=start||end>duration+.000001)throw error('字幕时间必须位于最终视频时间线内');const text=subtitleText(cue.text,1200);chars+=text.length;return{start,end,text};}).sort((a,b)=>a.start-b.start||a.end-b.end);
 if(chars>CANVAS_VIDEO_LIMITS.subtitleChars)throw error('字幕总文字不能超过12000字');
 return{request_id:raw.request_id,project_id:raw.project_id,clips,audio,ratio,subtitles,duration};
}
const contentInput=input=>{const{request_id,...content}=input;return content;};
const fileHash=file=>hash(fs.readFileSync(file));
const stamp=seconds=>{const ms=Math.round(seconds*1000);return`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
function srt(cues){return cues.map((cue,index)=>`${index+1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r/g,'').replace(/\n{2,}/g,'\n')}\n`).join('\n');}
function mediaDuration(info,stream){for(const value of [stream?.duration,info?.format?.duration]){const duration=Number(value);if(Number.isFinite(duration)&&duration>0)return duration;}return 0;}

/**
 * resolveAsset(id) is the ownership boundary: return a trusted local {file},
 * including the existing material-store {file,mime,material} shape. Never pass
 * user paths to that callback. render waits for local encoding and returns a
 * durable ready/failed job; input errors throw before any task is accepted.
 * Per-clip audio defaults to muted with a soundtrack, otherwise kept when
 * available. Explicit mute:false mixes it with the soundtrack. Gains are 0..4.
 */
export function createCanvasVideoEditor({data,ffmpeg,probe,resolveAsset,subtitleFontPath,subtitleFontCandidates}={}){
 if(typeof data!=='string'||!data||typeof ffmpeg!=='string'||!ffmpeg||typeof probe!=='function'||typeof resolveAsset!=='function')throw new TypeError('本地视频编辑器需要data、ffmpeg、probe与resolveAsset');
 const root=path.resolve(data,'canvas-edits');fs.mkdirSync(root,{recursive:true});if(fs.lstatSync(root).isSymbolicLink())throw error('视频编辑目录不能是符号链接',500);
 const rootIdentity=fs.statSync(root),working=new Map();
 function assertRoot(){const current=fs.lstatSync(root);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==rootIdentity.dev||current.ino!==rootIdentity.ino)throw error('视频编辑目录已改变，请重新启动编辑服务',409);}
 function directory(id){if(!UUID.test(id||''))throw error('视频编辑任务标识无效');return path.join(root,id);}
 function read(id){assertRoot();const dir=directory(id),file=path.join(dir,'job.json');let stat;try{const parent=fs.lstatSync(dir);if(!parent.isDirectory()||parent.isSymbolicLink())throw error('视频编辑任务目录无效',409);stat=fs.lstatSync(file);}catch(cause){if(cause.code==='ENOENT')return null;throw cause;}if(!stat.isFile()||stat.isSymbolicLink()||stat.size>CANVAS_VIDEO_LIMITS.recordBytes)throw error('视频编辑任务记录无效',409);let value;const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||!opened.isFile())throw Error();value=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{throw error('视频编辑任务记录损坏',409);}finally{fs.closeSync(fd);}
  try{const {duration:_duration,...rawInput}=value.input;const normalized=normalizeInput(rawInput);if(canonical(normalized)!==canonical(value.input))throw Error();if(!value||value.schema!==SCHEMA||value.id!==id||value.project_id!==value.input?.project_id||!['pending','rendering','ready','failed'].includes(value.status)||!/^[a-f0-9]{64}$/.test(value.inputHash||'')||value.inputHash!==fingerprint(contentInput(normalized))||!/^[a-f0-9]{64}$/.test(value.signature||''))throw Error();if(value.status==='ready'&&(!value.generated||value.generated.url!==`/files/canvas-edits/${id}/video.mp4`||!/^[a-f0-9]{64}$/.test(value.generated.sha256||'')||value.generated.duration!==value.input.duration))throw Error();return value;}catch{throw error('视频编辑任务未通过完整性校验',409);}
 }
 function save(job){assertRoot();const dir=directory(job.id),target=path.join(dir,'job.json'),temp=path.join(dir,'.job-'+crypto.randomUUID()+'.tmp');const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw error('视频编辑任务目录已改变',409);const bytes=JSON.stringify(job,null,2);if(Buffer.byteLength(bytes)>CANVAS_VIDEO_LIMITS.recordBytes)throw error('视频编辑记录超过容量限制',413);let owned=false;try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});owned=true;fs.renameSync(temp,target);}finally{if(owned)try{fs.unlinkSync(temp);}catch(cause){if(cause.code!=='ENOENT')throw cause;}}}
 function publicJob(job,replayed=false){const result={schema:SCHEMA,id:job.id,project_id:job.project_id,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,clips:clone(job.input.clips),audio:clone(job.input.audio),ratio:job.input.ratio,subtitles:clone(job.input.subtitles),duration:job.input.duration,dimensions:getOutputFormat(job.input.ratio),message:job.message,replayed};if(job.input.subtitles.length){result.subtitleRenderer=job.subtitleRenderer||{version:'legacy-font-discovery'};if(!job.subtitleRenderer)result.message='旧版字幕可能缺少中文字形，请重新导出以使用字体校验。';}if(job.error)result.error=job.error;if(job.generated){result.generated=clone(job.generated);result.url=job.generated.url;result.sha256=job.generated.sha256;}return result;}
 function get(id){const job=read(id);if(!job)return null;if(job.status==='ready'){const target=path.join(directory(id),'video.mp4'),stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||fileHash(target)!==job.generated.sha256)throw error('视频编辑成片文件校验失败',409);}return publicJob(job);}
 function list(projectId){if(projectId!==undefined&&!UUID.test(projectId||''))throw error('工程标识无效');assertRoot();return fs.readdirSync(root).filter(name=>UUID.test(name)).map(read).filter(job=>job&&(!projectId||job.project_id===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(job=>publicJob(job));}
 async function resolveInputs(input){const assets=new Map();for(const id of [...new Set([...input.clips.map(clip=>clip.id),...(input.audio?[input.audio.id]:[])])]){let resolved;try{resolved=await resolveAsset(id);}catch{throw error('找不到当前工程可使用的本地素材',404);}const file=resolved?.file;if(typeof file!=='string'||!path.isAbsolute(file)||!EXTENSIONS.has(path.extname(file).toLowerCase()))throw error('素材解析器未返回受支持的本地媒体文件');let stat;try{stat=fs.lstatSync(file);}catch{throw error('本地素材文件不存在',404);}if(!stat.isFile()||stat.isSymbolicLink()||!stat.size||stat.size>CANVAS_VIDEO_LIMITS.assetBytes)throw error('素材需为本机普通文件，且不能超过200MB');let info;try{info=await probe(file);}catch{throw error('本地素材无法读取，请使用有效的视频或音频');}const video=info?.streams?.find(s=>s.codec_type==='video'&&!Number(s.disposition?.attached_pic)),audio=info?.streams?.find(s=>s.codec_type==='audio');assets.set(id,{id,file,sha256:fileHash(file),bytes:stat.size,videoDuration:mediaDuration(info,video),audioDuration:mediaDuration(info,audio),hasVideo:!!video,hasAudio:!!audio});}
  for(const clip of input.clips){const asset=assets.get(clip.id);if(!asset.hasVideo||!asset.videoDuration)throw error('时间线片段必须含有真实视频画面');if(clip.end>asset.videoDuration+.05)throw error('裁剪终点超出所选视频时长');}
  if(input.audio){const asset=assets.get(input.audio.id);if(!asset.hasAudio||!asset.audioDuration)throw error('所选配乐没有可用音轨');if(input.audio.start+input.duration>asset.audioDuration+.05)throw error('配乐起点之后的音频不足以覆盖全部视频，请调整起点或片段');}
  return assets;
 }
 function run(args,cwd){return new Promise((resolve,reject)=>{const process=spawn(ffmpeg,['-nostdin','-v','error','-y',...args],{cwd,stdio:['ignore','ignore','pipe']});let diagnostic='';process.stderr.on('data',bytes=>{diagnostic=(diagnostic+String(bytes)).slice(-4000);});process.on('error',()=>reject(error('本地视频编码器无法启动',500)));process.on('close',code=>{if(code===0)return resolve();try{fs.writeFileSync(path.join(cwd,'encode.log'),diagnostic,{mode:0o600});}catch{}reject(error('本地视频合成未完成，请保留原素材后重试',500));});});}
 async function encode(job,assets,font){
  const dir=directory(job.id),frozen=new Map();let index=0;
  for(const asset of assets.values()){const file=path.join(dir,`input-${index++}${path.extname(asset.file).toLowerCase()}`);fs.copyFileSync(asset.file,file,fs.constants.COPYFILE_EXCL);if(fileHash(file)!==asset.sha256)throw error('素材在准备期间发生变化，未导出错误版本',409);frozen.set(asset.id,{...asset,file});}
  job.status='rendering';job.message='正在裁剪素材并合成时间线';job.updatedAt=new Date().toISOString();save(job);
  const input=job.input,format=getOutputFormat(input.ratio),args=['-filter_complex_threads','2'],filters=[];
  for(const[index,clip]of input.clips.entries()){const asset=frozen.get(clip.id),duration=Number((clip.end-clip.start).toFixed(6));args.push('-threads','1','-protocol_whitelist','file,pipe','-ss',String(clip.start),'-t',String(duration),'-i',asset.file);filters.push(`[${index}:v:0]trim=duration=${duration},setpts=PTS-STARTPTS,scale=${format.width}:${format.height}:force_original_aspect_ratio=decrease,pad=${format.width}:${format.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,format=yuv420p[v${index}]`);
   if(asset.hasAudio&&!clip.mute&&clip.gain>0)filters.push(`[${index}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad=whole_dur=${duration},atrim=duration=${duration}[a${index}]`);
   else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
  }
  filters.push(`${input.clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${input.clips.length}:v=1:a=1[video][native]`);
  if(input.audio){const source=frozen.get(input.audio.id);args.push('-threads','1','-protocol_whitelist','file,pipe','-ss',String(input.audio.start),'-t',String(input.duration),'-i',source.file);filters.push(`[${input.clips.length}:a:0]atrim=duration=${input.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${input.audio.gain},apad=whole_dur=${input.duration},atrim=duration=${input.duration}[music]`);filters.push(`[native][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.98:level=false,atrim=duration=${input.duration}[outa]`);}else filters.push('[native]anull[outa]');
  if(input.subtitles.length){
   fs.copyFileSync(font.file,path.join(dir,'subtitle-font.ttf'),fs.constants.COPYFILE_EXCL);if(fileHash(path.join(dir,'subtitle-font.ttf'))!==font.sha256)throw error('字幕字体在准备期间发生变化，请重新导出',409);
   fs.writeFileSync(path.join(dir,'captions.srt'),srt(input.subtitles),{flag:'wx',mode:0o600});
   const size=Math.max(18,Math.round(Math.min(format.width,format.height)*.045)),columns=Math.floor(format.width*.88/(size/2)),margin=Math.round(format.height*.05);
   for(const [i,cue]of input.subtitles.entries()){const text=wrapSubtitleText(cue.text,columns);fs.writeFileSync(path.join(dir,`caption-${i}.txt`),text,{flag:'wx',mode:0o600});filters.push(`[${i?'caption'+(i-1):'video'}]drawtext=fontfile=subtitle-font.ttf:textfile=caption-${i}.txt:expansion=none:fontcolor=white:fontsize=${size}:borderw=2:bordercolor=black:box=1:boxcolor=black@0.45:boxborderw=6:line_spacing=4:x=(w-text_w)/2:y=h-text_h-${margin}:enable='gte(t,${cue.start})*lt(t,${cue.end})'[${i===input.subtitles.length-1?'outv':'caption'+i}]`);}
  }else filters.push('[video]null[outv]');
  const target=path.join(dir,'video.mp4');args.push('-filter_complex',filters.join(';'),'-map','[outv]','-map','[outa]','-t',String(input.duration),'-c:v','libx264','-threads','2','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',target);
  try{await run(args,dir);}finally{if(font)try{fs.unlinkSync(path.join(dir,'subtitle-font.ttf'));}catch{}}
  const info=await probe(target),video=info.streams?.find(s=>s.codec_type==='video'),audio=info.streams?.find(s=>s.codec_type==='audio');if(!video||!audio||video.codec_name!=='h264'||audio.codec_name!=='aac'||video.width!==format.width||video.height!==format.height||Math.abs(Number(info.format?.duration)-input.duration)>.2)throw error('导出音轨、编码、时长或画面尺寸校验未通过',500);
  job.generated={url:`/files/canvas-edits/${job.id}/video.mp4`,sha256:fileHash(target),duration:input.duration,dimensions:format,kind:'canvas-video-edit',provider:'local-ffmpeg'};job.status='ready';job.message='本地视频已合成，可预览和下载';job.updatedAt=new Date().toISOString();save(job);return publicJob(job);
 }
 async function perform(input,inputHash){
  let font=null,subtitleRenderer=null;
  if(input.subtitles.length){font=selectSubtitleFont(input.subtitles.map(c=>c.text).join('\n'),{...(subtitleFontPath!==undefined?{fontPath:subtitleFontPath}:{}),...(subtitleFontCandidates?{candidates:subtitleFontCandidates}:{})});subtitleRenderer={version:SUBTITLE_RENDERER_VERSION,font_sha256:font.sha256,font_family:font.family};const format=getOutputFormat(input.ratio),size=Math.max(18,Math.round(Math.min(format.width,format.height)*.045)),columns=Math.floor(format.width*.88/(size/2));if(input.subtitles.some(c=>wrapSubtitleText(c.text,columns).split('\n').length*(size+4)>format.height*.7))throw error('字幕文字超出画面，请拆成较短的字幕分段');}
  const assets=await resolveInputs(input),sources=[...assets.values()].map(({id,sha256,bytes,hasVideo,hasAudio,videoDuration,audioDuration})=>({id,sha256,bytes,hasVideo,hasAudio,videoDuration,audioDuration})),signature=fingerprint({input:contentInput(input),sources,...(subtitleRenderer?{subtitleRenderer}:{})});
  const duplicate=fs.readdirSync(root).filter(name=>UUID.test(name)).map(read).find(job=>job?.status==='ready'&&job.signature===signature);if(duplicate){get(duplicate.id);return publicJob(duplicate,true);}
  const dir=directory(input.request_id);try{fs.mkdirSync(dir);}catch(cause){if(cause.code==='EEXIST')throw error('该视频编辑请求已登记，请读取原任务',409);throw cause;}
  const now=new Date().toISOString(),job={schema:SCHEMA,id:input.request_id,project_id:input.project_id,inputHash,signature,input,sources,...(subtitleRenderer?{subtitleRenderer}:{}),status:'pending',createdAt:now,updatedAt:now,message:'时间线已保存，准备本地合成'};save(job);
  try{return await encode(job,assets,font);}catch(cause){job.status='failed';job.message='视频编辑未完成，原始素材保持不变';job.error=typeof cause.message==='string'?cause.message.slice(0,240):'本地视频合成失败';job.updatedAt=new Date().toISOString();save(job);for(const name of ['video.mp4','subtitle-font.ttf'])try{fs.unlinkSync(path.join(dir,name));}catch{}return publicJob(job);}
 }
 async function render(raw){const input=normalizeInput(raw),inputHash=fingerprint(contentInput(input)),active=working.get(input.request_id);if(active){if(active.inputHash!==inputHash)throw error('同一视频编辑请求不能改用其他时间线',409);return{...clone(await active.promise),replayed:true};}const previous=read(input.request_id);if(previous){if(previous.inputHash!==inputHash)throw error('同一视频编辑请求不能改用其他时间线',409);if(previous.status==='ready')get(previous.id);return publicJob(previous,true);}const promise=perform(input,inputHash);working.set(input.request_id,{inputHash,promise});try{return await promise;}finally{working.delete(input.request_id);}}
 for(const id of fs.readdirSync(root).filter(name=>UUID.test(name))){const job=read(id);if(job&&['pending','rendering'].includes(job.status)){job.status='failed';job.error='服务重启后未完成的本地编辑已停止，请用新请求重新导出';job.message=job.error;job.updatedAt=new Date().toISOString();save(job);try{fs.unlinkSync(path.join(directory(id),'video.mp4'));}catch{}}}
 return Object.freeze({render,get,list});
}
