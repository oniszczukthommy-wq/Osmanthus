import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {getOutputFormat} from './public/output-format.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RATIOS=new Set(['16:9','9:16','1:1','4:3','3:4']);
const FORMATS=new Set(['.png','.jpg','.jpeg','.webp','.gif']);
export const FIRST_FRAME_MAX_PIXELS=16_777_216;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const clone=value=>JSON.parse(JSON.stringify(value));
function regular(file,max=20_000_000){const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>max)throw fail('首帧来源文件无效');const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const now=fs.fstatSync(fd);if(!now.isFile()||now.dev!==before.dev||now.ino!==before.ino||now.size!==before.size)throw fail('首帧来源在读取时已改变',409);return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
function write(file,value){const temporary=file+'.tmp-'+crypto.randomUUID();try{fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}}
function encode(binary,args){return new Promise((resolve,reject)=>{const child=spawn(binary,args,{stdio:['ignore','ignore','pipe']});let diagnostics='',settled=false;const timeout=setTimeout(()=>{child.kill('SIGKILL');finish(fail('首帧适配超时，原图保持不变',504));},60000);function finish(error){if(settled)return;settled=true;clearTimeout(timeout);error?reject(error):resolve();}child.stderr.on('data',part=>{diagnostics=(diagnostics+part).slice(-4000);});child.on('error',()=>finish(fail('本地首帧编码器无法启动',503)));child.on('close',code=>finish(code===0?null:fail('首帧裁剪或格式转换未完成，原图保持不变',422)));});}

/** Free local conversion only. Returns a registered material, never a path or paid request. */
export function createCanvasFirstFrame({data,ffmpeg,probe,materials}={}){
 if(typeof data!=='string'||typeof ffmpeg!=='string'||typeof probe!=='function'||typeof materials?.asset!=='function'||typeof materials?.upload!=='function')throw TypeError('首帧适配需要data、FFmpeg、probe和素材注册表');
 const root=path.resolve(data,'canvas-first-frames');fs.mkdirSync(root,{recursive:true});const identity=fs.lstatSync(root);if(!identity.isDirectory()||identity.isSymbolicLink())throw fail('首帧适配目录不能是链接',500);const active=new Map();
 function assertRoot(){const stat=fs.lstatSync(root);if(stat.isSymbolicLink()||stat.ino!==identity.ino||stat.dev!==identity.dev)throw fail('首帧适配目录已改变',409);}
 async function perform({request_id,material_id,ratio}){
  if(!UUID.test(request_id||'')||!UUID.test(material_id||'')||!RATIOS.has(ratio))throw fail('首帧适配标识或画幅无效');assertRoot();
  const found=materials.asset(material_id),source=found?.material;if(!found?.file||source?.id!==material_id||source.kind!=='image'||!FORMATS.has(path.extname(found.file).toLowerCase())||!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<1||source.height<1||source.width*source.height>FIRST_FRAME_MAX_PIXELS)throw fail('首帧需为已注册的PNG/JPEG/WebP/GIF，且不能超过1600万像素');
  const original=regular(found.file);if(original.length!==source.bytes||hash(original)!==source.sha256)throw fail('首帧原图SHA校验失败',409);
  const signature=hash(Buffer.from(JSON.stringify({material_id,source_sha256:source.sha256,width:source.width,height:source.height,ratio}))),recordFile=path.join(root,request_id+'.json');let prior;
  if(fs.existsSync(recordFile)){try{prior=JSON.parse(regular(recordFile,100000));}catch{throw fail('原首帧适配记录损坏，未覆盖',409);}if(prior.id!==request_id||prior.signature!==signature)throw fail('同一首帧适配请求不能更换来源或画幅',409);if(prior.status==='ready'){const ready=materials.asset(prior.material?.id);if(ready?.material.sha256===prior.material.sha256)return ready.material;}throw fail('原首帧适配结果无法校验，请使用新的请求标识',409);}
  const info=await probe(found.file),stream=info?.streams?.find(s=>s.codec_type==='video');if(!stream||stream.width!==source.width||stream.height!==source.height||!['png','mjpeg','webp','gif'].includes(stream.codec_name)||info.streams.some(s=>s.codec_type==='audio'))throw fail('首帧元数据与实际图像尺寸不一致');
  const format=getOutputFormat(ratio),sameRatio=Math.abs(source.width/source.height/(format.width/format.height)-1)<1e-6,convert=!['.png','.jpg','.jpeg'].includes(path.extname(found.file).toLowerCase()),passthrough=sameRatio&&!convert&&source.width>=240&&source.height>=240&&source.width<=8000&&source.height<=8000;
  const record={id:request_id,signature,status:'preparing',source:clone(source),ratio,dimensions:format,createdAt:new Date().toISOString(),strategy:passthrough?'original':'center-crop-and-scale-first-frame'};write(recordFile,record);
  if(passthrough){record.status='ready';record.material=source;record.adapted=false;write(recordFile,record);return source;}
  const directory=path.join(root,request_id);try{fs.mkdirSync(directory,{mode:0o700});const ext=path.extname(found.file).toLowerCase(),frozen=path.join(directory,'source'+ext);fs.writeFileSync(frozen,original,{flag:'wx',mode:0o600});if(hash(regular(frozen))!==source.sha256)throw fail('首帧冻结校验失败',409);
   const ratioNumber=format.width/format.height;let width=source.width,height=source.height;if(width/height>ratioNumber)width=Math.max(1,Math.floor(height*ratioNumber));else height=Math.max(1,Math.floor(width/ratioNumber));const x=Math.floor((source.width-width)/2),y=Math.floor((source.height-height)/2),output=path.join(directory,'first-frame.png');record.crop={x,y,width,height};
   await encode(ffmpeg,['-nostdin','-v','error','-y','-threads','1','-protocol_whitelist','file,pipe','-noautorotate','-i',frozen,'-vf',`format=rgb24,crop=${width}:${height}:${x}:${y},scale=${format.width}:${format.height}:flags=lanczos,setsar=1`,'-frames:v','1','-threads','1',output]);
   const bytes=regular(output),actual=await probe(output),video=actual?.streams?.find(s=>s.codec_type==='video');if(!video||video.codec_name!=='png'||video.width!==format.width||video.height!==format.height||actual.streams.some(s=>s.codec_type==='audio')||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('首帧适配输出未通过真实PNG尺寸校验',500);
   if(hash(regular(found.file))!==source.sha256)throw fail('处理期间原图已改变，未登记错误版本',409);
   record.material=await materials.upload(`视频首帧-${ratio.replace(':','x')}-${request_id.slice(0,8)}.png`,bytes);record.adapted=true;record.status='ready';record.completedAt=new Date().toISOString();write(recordFile,record);return record.material;
  }catch(error){record.status='failed';record.error=String(error.message||error).slice(0,240);write(recordFile,record);throw error;}
 }
 async function prepare(input){if(!input||typeof input!=='object')throw fail('首帧适配请求无效');const signature=JSON.stringify({request_id:input.request_id,material_id:input.material_id,ratio:input.ratio}),running=active.get(input.request_id);if(running){if(running.signature!==signature)throw fail('同一首帧适配请求不能更换内容',409);return await running.promise;}const promise=perform(input);active.set(input.request_id,{signature,promise});try{return await promise;}finally{active.delete(input.request_id);}}
 return Object.freeze({prepare});
}
