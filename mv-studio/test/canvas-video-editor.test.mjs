import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createCanvasVideoEditor} from '../canvas-video-editor.mjs';

const ff=mediaTools().ffmpeg,fp=mediaTools().ffprobe;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const encode=args=>execFileSync(ff,['-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],timeout:30000});
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',timeout:10000}));
function fixture(t,options={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-editor-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const assets=new Map(),files={red:path.join(data,'red.mp4'),blue:path.join(data,'blue.mp4'),silent:path.join(data,'silent.mp4'),music:path.join(data,'music.wav')};
 for(const[id,color,frequency]of [['red','red',440],['blue','blue',880]])encode(['-f','lavfi','-i',`color=c=${color}:s=96x64:r=24`,'-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000`,'-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',files[id]]);
 encode(['-f','lavfi','-i','color=c=black:s=96x64:r=24','-t','3','-c:v','libx264','-pix_fmt','yuv420p',files.silent]);
 encode(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','8',files.music]);
 for(const[id,file]of Object.entries(files))assets.set(id,{file,material:{id,kind:id==='music'?'audio':'video'}});
 let resolves=0;const config={data,ffmpeg:ff,probe,resolveAsset:id=>{resolves++;return assets.get(id)||null;},...options};
 return{data,files,assets,config,editor:createCanvasVideoEditor(config),get resolves(){return resolves;},request:patch=>({request_id:crypto.randomUUID(),project_id:'20000000-0000-4000-8000-000000000001',clips:[{id:'red',start:0,end:1}],ratio:'16:9',...patch})};
}
const output=(f,job)=>path.join(f.data,'canvas-edits',job.id,'video.mp4');
const samples=(file,start,duration=.3)=>{const bytes=execFileSync(ff,['-v','error','-ss',String(start),'-i',file,'-t',String(duration),'-map','0:a:0','-ac','1','-ar','16000','-f','f32le','pipe:1'],{maxBuffer:1e6});return Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4));};
const rms=values=>Math.sqrt(values.reduce((sum,x)=>sum+x*x,0)/values.length);
const frame=(file,at)=>execFileSync(ff,['-v','error','-ss',String(at),'-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:6e6});

test('真实素材裁剪并按所给顺序拼接，H264/AAC尺寸/时长/指纹可核验，原文件不变',async t=>{
 const f=fixture(t),original=Object.fromEntries(Object.entries(f.files).map(([id,file])=>[id,hash(file)]));
 const job=await f.editor.render(f.request({clips:[{id:'blue',start:1,end:2.5},{id:'red',start:.5,end:2}]}));
 assert.equal(job.status,'ready',job.error);assert.equal(job.duration,3);assert.equal(job.url,`/files/canvas-edits/${job.id}/video.mp4`);
 const file=output(f,job),info=probe(file),v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio');
 assert.equal(v.codec_name,'h264');assert.equal(a.codec_name,'aac');assert.deepEqual([v.width,v.height],[1280,720]);assert.ok(Math.abs(Number(info.format.duration)-3)<.15);assert.equal(job.sha256,hash(file));
 const center=(bytes,width,height)=>Array.from(bytes.subarray((Math.floor(height/2)*width+Math.floor(width/2))*3,(Math.floor(height/2)*width+Math.floor(width/2))*3+3));
 const first=center(frame(file,.4),1280,720),last=center(frame(file,2.2),1280,720);assert(first[2]>first[0]+150,'第一段为用户排在前面的蓝色视频');assert(last[0]>last[2]+150,'第二段为红色视频');
 for(const[id,file]of Object.entries(f.files))assert.equal(hash(file),original[id]);assert.equal(job.sources,undefined);assert.equal(JSON.stringify(job).includes(f.data),false);
});

test('原视频声音的音量与逐段静音真实生效；无音轨片段仍输出AAC静音',async t=>{
 const f=fixture(t),job=await f.editor.render(f.request({clips:[{id:'blue',start:0,end:1,gain:.25},{id:'red',start:0,end:1,mute:true}]}));
 assert.equal(job.status,'ready',job.error);const audible=rms(samples(output(f,job),.3)),muted=rms(samples(output(f,job),1.3));assert(audible>.012&&audible<.035,`0.25倍原声RMS=${audible}`);assert(muted<.001,`静音段RMS=${muted}`);
 const silent=await f.editor.render(f.request({clips:[{id:'silent',start:0,end:1}]}));assert.equal(silent.status,'ready',silent.error);assert(probe(output(f,silent)).streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'));assert(rms(samples(output(f,silent),.2))<.001);
});

test('选择原曲起点和音量后默认静音原视频声，可显式恢复混入',async t=>{
 const f=fixture(t),input=f.request({clips:[{id:'blue',start:.2,end:1.7}],audio:{id:'music',start:2,gain:.5},ratio:'9:16'}),job=await f.editor.render(input);
 assert.equal(job.status,'ready',job.error);assert.equal(job.clips[0].mute,true);assert.deepEqual([job.dimensions.width,job.dimensions.height],[720,1280]);const values=samples(output(f,job),.4),level=rms(values);assert(level>.035&&level<.055,`半音量配乐RMS=${level}`);
 const energy=frequency=>Math.hypot(values.reduce((s,x,i)=>s+x*Math.sin(i/16000*Math.PI*2*frequency),0),values.reduce((s,x,i)=>s+x*Math.cos(i/16000*Math.PI*2*frequency),0));assert(energy(330)>energy(880)*20,'输出使用所选原曲而非视频原声');
 const mixed=await f.editor.render({...input,request_id:crypto.randomUUID(),clips:[{...input.clips[0],mute:false,gain:.5}]});assert.equal(mixed.status,'ready',mixed.error);assert(rms(samples(output(f,mixed),.4))>level*1.2,'显式恢复原声后实际混入视频声音');
});

test('字幕按最终时间线烧录到实际画面，不只是保存文本',async t=>{
 const f=fixture(t),base=await f.editor.render(f.request({clips:[{id:'silent',start:0,end:1.5}],ratio:'1:1'}));
 const captioned=await f.editor.render(f.request({clips:[{id:'silent',start:0,end:1.5}],ratio:'1:1',subtitles:[{start:0,end:1.2,text:'LOCAL CAPTION'}]}));assert.equal(captioned.status,'ready',captioned.error);
 const plain=frame(output(f,base),.5),text=frame(output(f,captioned),.5);let changed=0;for(let i=0;i<text.length;i++)if(Math.abs(text[i]-plain[i])>30)changed++;assert(changed>500,`字幕应改变实际像素，变化字节=${changed}`);
 assert(fs.readFileSync(path.join(f.data,'canvas-edits',captioned.id,'captions.srt'),'utf8').includes('00:00:00,000 --> 00:00:01,200'));
});

test('同请求并发与重启重放不重复解析/合成；请求内容冲突明确拒绝',async t=>{
 const f=fixture(t),input=f.request({clips:[{id:'red',start:0,end:1}],subtitles:'A short local edit'}),a=f.editor.render(input),b=f.editor.render(input),[first,second]=await Promise.all([a,b]);assert.equal(first.status,'ready',first.error);assert.equal(second.id,first.id);assert.equal(second.replayed,true);assert.equal(f.resolves,1);
 const restarted=createCanvasVideoEditor({...f.config,resolveAsset:()=>{throw Error('replay must not resolve source again');}});const replay=await restarted.render(input);assert.equal(replay.sha256,first.sha256);assert.equal(replay.replayed,true);assert.equal(restarted.get(first.id).status,'ready');assert.equal(restarted.list(input.project_id).length,1);
 await assert.rejects(()=>restarted.render({...input,ratio:'1:1'}),e=>e.status===409);assert.equal(first.status,'ready');
 const sameContent=await f.editor.render({...input,request_id:crypto.randomUUID()});assert.equal(sameContent.id,first.id);assert.equal(sameContent.replayed,true);
});

test('8段/60秒边界、非法裁剪、配乐长度与路径输入在合成前拒绝',async t=>{
 const f=fixture(t);for(const patch of [{clips:[]},{clips:Array.from({length:9},()=>({id:'red',start:0,end:1}))},{clips:[{id:'red',start:0,end:61}]},{clips:[{id:'red',start:2,end:1}]},{clips:[{id:'red',start:NaN,end:1}]},{clips:[{id:'red',start:0,end:4}]},{clips:[{id:'red',start:0,end:1,gain:5}]},{clips:[{id:'https://example.org/a.mp4',start:0,end:1}]},{clips:[{id:'../outside',start:0,end:1}]},{audio:{id:'music',start:7.5,gain:1}},{subtitles:[{start:0,end:5,text:'too late'}]},{ratio:'7:2'},{file:'/private/file.mp4'}])await assert.rejects(()=>f.editor.render(f.request(patch)));
 assert.deepEqual(fs.readdirSync(path.join(f.data,'canvas-edits')),[]);
 const eight=await f.editor.render(f.request({clips:Array.from({length:8},()=>({id:'silent',start:0,end:.125}))}));assert.equal(eight.status,'ready',eight.error);assert.equal(eight.clips.length,8);assert.ok(Math.abs(Number(probe(output(f,eight)).format.duration)-1)<.15);
});

test('服务重启将未完成任务标记失败且不自动执行，损坏成片不能伪装ready',async t=>{
 const f=fixture(t),input=f.request(),ready=await f.editor.render(input),record=path.join(f.data,'canvas-edits',ready.id,'job.json'),stored=JSON.parse(fs.readFileSync(record));stored.status='rendering';delete stored.generated;fs.writeFileSync(record,JSON.stringify(stored));let calls=0;const restarted=createCanvasVideoEditor({...f.config,resolveAsset:()=>{calls++;throw Error('must remain stopped');}});assert.equal(restarted.get(ready.id).status,'failed');assert.match(restarted.get(ready.id).error,/服务重启/);assert.equal((await restarted.render(input)).status,'failed');assert.equal(calls,0);
 const another=await f.editor.render(f.request());assert.equal(another.status,'ready',another.error);fs.appendFileSync(output(f,another),'corrupt');assert.throws(()=>f.editor.get(another.id),/校验失败/);
});

test('素材解析只接受本机普通媒体文件；编码失败留下可查询任务且原片不变',async t=>{
 const f=fixture(t),original=hash(f.files.red),link=path.join(f.data,'link.mp4');fs.symlinkSync(f.files.red,link);const unsafe=createCanvasVideoEditor({...f.config,resolveAsset:()=>({file:link})});await assert.rejects(()=>unsafe.render(f.request()),/普通文件/);
 const failed=createCanvasVideoEditor({...f.config,ffmpeg:path.join(f.data,'missing-ffmpeg')}),job=await failed.render(f.request());assert.equal(job.status,'failed');assert.match(job.error,/编码器无法启动/);assert.equal(failed.get(job.id).status,'failed');assert.equal(hash(f.files.red),original);
});
