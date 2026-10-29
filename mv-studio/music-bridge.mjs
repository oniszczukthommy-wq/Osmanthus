import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {makeProject,makePlan,validateProject,clone} from './public/domain.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function createMusicBridge({data,probe,waveform,write,version,musicBase=process.env.MUSIC_BASE_URL||'http://127.0.0.1:8603'}){
 const origin=new URL(musicBase);if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname))throw Error('音乐服务必须是指定本机服务');
 for(const folder of ['music-projects','music-imports'])fs.mkdirSync(path.join(data,folder),{recursive:true});
 const pending=new Map();const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 function persist(project){const id=project.musicHandoff?.id;if(UUID.test(id||'')){if(!/^[a-f0-9-]{36}\.mp3$/.test(project.source?.id||''))throw Error('关联歌曲来源无效');const file=path.join(data,'uploads',project.source.id);if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==project.musicHandoff.audio_sha256)throw Error('音乐已更换，请创建独立MV方案');}write(path.join(data,'project.json'),project);if(UUID.test(id||''))write(path.join(data,'music-projects',id+'.json'),project);}
 function activate(project){const old=read(path.join(data,'project.json'));if(old&&old.musicHandoff?.id!==project.musicHandoff.id)version(old,'从音乐工作台创建MV前的方案');persist(project);}
 async function importMusic(id){
  if(!UUID.test(id||''))throw Error('歌曲交接标识无效');
  if(pending.has(id))return pending.get(id);
  const work=(async()=>{
   const saved=read(path.join(data,'music-projects',id+'.json'));
   if(saved){validateProject(saved);const file=path.join(data,'uploads',saved.source.id);if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==saved.musicHandoff.audio_sha256)throw Error('关联音乐文件校验失败，请从歌曲重新创建');activate(saved);return{project:saved,waveform:waveform(file),reused:true};}
   const response=await fetch(new URL('/api/mv/handoffs/'+id,origin),{signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('歌曲交接不存在或已变化，请回音乐工作台重新创建MV');const meta=await response.json();
   if(meta.id!==id||!UUID.test(meta.project_id||'')||!/^[a-f0-9]{64}$/.test(meta.audio_sha256||'')||meta.audio_url!==`/api/mv/handoffs/${id}/audio.mp3`)throw Error('歌曲交接信息不完整');
   const fileId=meta.audio_sha256.slice(0,8)+'-'+meta.audio_sha256.slice(8,12)+'-'+meta.audio_sha256.slice(12,16)+'-'+meta.audio_sha256.slice(16,20)+'-'+meta.audio_sha256.slice(20,32)+'.mp3';
   const file=path.join(data,'uploads',fileId);let bytes;
   if(fs.existsSync(file)){bytes=fs.readFileSync(file);if(hash(bytes)!==meta.audio_sha256)throw Error('已有歌曲缓存校验失败');}
   else{
    const media=await fetch(new URL(meta.audio_url,origin),{signal:AbortSignal.timeout(120000)});if(!media.ok)throw Error('歌曲音频读取失败');
    if(Number(media.headers.get('content-length'))>80e6)throw Error('歌曲文件超过80MB');const chunks=[];let length=0;
    for await(const chunk of media.body){length+=chunk.length;if(length>80e6)throw Error('歌曲文件超过80MB');chunks.push(chunk);}bytes=Buffer.concat(chunks);
    if(bytes.length!==meta.audio_bytes||hash(bytes)!==meta.audio_sha256)throw Error('歌曲音频与选中混音版本不一致');
    const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,bytes);fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
   }
   const info=probe(file),duration=Number(info.format.duration);if(!info.streams.some(s=>s.codec_type==='audio')||!Number.isFinite(duration)||duration<3||duration>1200)throw Error('歌曲时长或格式不可用');
   const project=makeProject();project.id=crypto.randomUUID();project.title=String(meta.title||'未命名歌曲').slice(0,120);project.source={id:fileId,url:'/files/uploads/'+fileId,name:project.title,duration,cover:meta.cover_url?new URL(meta.cover_url,origin).href:null};project.start=0;project.duration=Math.min(30,duration);project.plan=makePlan('family',project.duration);project.step='music';
   project.manualLyrics=String(meta.lyrics||'').slice(0,12000);project.lyrics=(meta.timed_lyrics||[]).filter(l=>Number.isFinite(l.start)&&Number.isFinite(l.end)&&l.start>=0&&l.end>l.start&&l.end<=duration+.15&&typeof l.text==='string').map(l=>({start:l.start,end:l.end,text:l.text}));
   project.generated=null;project.studio={type:'story',prompt:'',enhance:false};project.musicHandoff={id,project_id:meta.project_id,revision:meta.revision,fingerprint:meta.fingerprint,source_kind:meta.source_kind,audio_sha256:meta.audio_sha256};validateProject(project);
   activate(project);write(path.join(data,'music-imports',id+'.json'),{id,project_id:meta.project_id,audio_sha256:meta.audio_sha256,createdAt:new Date().toISOString()});return{project:clone(project),waveform:waveform(file),reused:false};
  })();pending.set(id,work);try{return await work;}finally{pending.delete(id);}
 }
 return{importMusic,persist};
}
