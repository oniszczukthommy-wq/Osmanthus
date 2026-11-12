import {makeProject,makePlan} from './domain.js';

export function selectedAudioPath(source){
 const path=typeof source?.url==='string'?source.url.replace(/^\/mv(?=\/)/,''):'';
 return /^\/files\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(mp3|wav|m4a|aac|flac|ogg|opus)$/.test(path)?path:'';
}
export function checkedSelection(start,end,total){
 if([start,end,total].some(v=>typeof v==='string'&&!v.trim()))throw Error('请选择有效的开始和结束时间');
 start=Number(start);end=Number(end);total=Number(total);
 if(![start,end,total].every(Number.isFinite)||total<3||total>1200||start<0||end>total+.001||end-start<3||end-start>180)throw Error('请选择歌曲内 3 秒至 3 分钟的片段');
 return {start:Math.round(start*1000)/1000,end:Math.round(end*1000)/1000,duration:Math.round((end-start)*1000)/1000};
}
export function newMvProject({source,start,end,title,lyrics='',timedLyrics=[]},id){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id||'')||!selectedAudioPath(source))throw Error('歌曲不可用，请重新选择');
 const r=checkedSelection(start,end,source.duration),p=makeProject();
 p.id=id;p.title=String(title||source.name||'未命名歌曲').slice(0,120);p.source={...source,url:selectedAudioPath(source)};
 p.start=r.start;p.duration=r.duration;p.plan=makePlan('family',r.duration);p.lyrics=Array.isArray(timedLyrics)?timedLyrics.map(l=>({...l})):[];
 p.manualLyrics=String(lyrics||'').slice(0,12000);p.step='music';p.generated=null;p.studio={type:'story',prompt:'',enhance:false};
 return p;
}
