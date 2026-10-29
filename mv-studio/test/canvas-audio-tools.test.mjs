import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createCanvasAudioTools,CANVAS_ASR_ENGINE,CANVAS_AUDIO_LIMITS} from '../canvas-audio-tools.mjs';

const ff=mediaTools().ffmpeg,fp=mediaTools().ffprobe;
const speech=process.env.MV_ASR_TEST_FIXTURES||path.join(os.tmpdir(),'osmanthus-unconfigured-asr-fixtures');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',timeout:10000}));
const encode=args=>execFileSync(ff,['-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],timeout:30000});
const rootFor=t=>{const data=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-audio-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));return data;};
function fixture(t,options={}){
 const data=rootFor(t),files={video:path.join(data,'video.mp4'),audio:path.join(data,'audio.wav'),silent:path.join(data,'no-audio.mp4')};
 encode(['-f','lavfi','-i','color=c=blue:s=64x48:r=12','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',files.video]);
 encode(['-f','lavfi','-i','sine=frequency=300:sample_rate=44100','-t','3',files.audio]);
 encode(['-f','lavfi','-i','color=c=red:s=64x48:r=12','-t','1','-c:v','libx264','-pix_fmt','yuv420p',files.silent]);
 const assets=new Map(Object.entries(files).map(([id,file])=>[id,{file,material:{id,kind:id==='audio'?'audio':'video'}}]));let resolves=0;
 const config={data,ffmpeg:ff,probe,resolveAsset:id=>{resolves++;return assets.get(id);},...options};
 return{data,files,assets,config,tools:createCanvasAudioTools(config),get resolves(){return resolves;},request:patch=>({request_id:crypto.randomUUID(),project_id:'30000000-0000-4000-8000-000000000001',asset_id:'video',start:.25,end:1.75,...patch})};
}
const output=(f,job)=>path.join(f.data,'canvas-audio',job.id,'audio.wav');
const transcript=duration=>({status:'ready',text:'本地测试 分段字幕',segments:[{start:0,end:.6,text:'本地测试'},{start:.7,end:duration,text:'分段字幕'}],language:'zh',language_probability:.98,duration,engine:CANVAS_ASR_ENGINE});

test('实际视频音轨提取为选段WAV，16k/mono/PCM16、URL和SHA可核验，原件不变',async t=>{
 const f=fixture(t),original=hash(f.files.video),job=await f.tools.extract(f.request());
 assert.equal(job.status,'ready',job.error);assert.equal(job.duration,1.5);assert.equal(job.start,.25);assert.equal(job.end,1.75);assert.equal(job.source_sha256,original);assert.equal(job.url,`/files/canvas-audio/${job.id}/audio.wav`);
 const file=output(f,job),info=probe(file),audio=info.streams.find(stream=>stream.codec_type==='audio');assert.equal(info.streams.length,1);assert.equal(audio.codec_name,'pcm_s16le');assert.equal(Number(audio.sample_rate),16000);assert.equal(audio.channels,1);assert.equal(audio.bits_per_sample,16);assert.ok(Math.abs(Number(info.format.duration)-1.5)<.01);assert.equal(job.sha256,hash(file));
 const bytes=execFileSync(ff,['-v','error','-i',file,'-f','f32le','pipe:1']);let energy=0;for(let i=0;i<bytes.length;i+=4)energy+=bytes.readFloatLE(i)**2;assert(Math.sqrt(energy/(bytes.length/4))>.07,'提取的音轨含有真实源音频');assert.equal(hash(f.files.video),original);assert(!JSON.stringify(job).includes(f.data));assert.equal(job.transcript,undefined);
});

test('真实音频默认提取到源末尾；长素材不静默截短，指定60秒可通过',async t=>{
 const f=fixture(t),whole=await f.tools.extract(f.request({asset_id:'audio',start:1,end:undefined}));assert.equal(whole.status,'ready',whole.error);assert.equal(whole.duration,2);
 const long=path.join(f.data,'long.wav');encode(['-f','lavfi','-i','sine=frequency=200:sample_rate=16000','-t','61',long]);f.assets.set('long',{file:long});await assert.rejects(()=>f.tools.extract(f.request({asset_id:'long',start:0,end:undefined})),/0.2至60秒/);
 const exact=await f.tools.extract(f.request({asset_id:'long',start:1,end:61}));assert.equal(exact.status,'ready',exact.error);assert.equal(exact.duration,60);assert.ok(Math.abs(probe(output(f,exact)).format.duration-60)<.01);
});

test('同请求并发/重启重放不重复解析，ID不能换选段或操作；同内容复用仍绑定新请求ID',async t=>{
 const f=fixture(t),request=f.request(),[a,b]=await Promise.all([f.tools.extract(request),f.tools.extract(request)]);assert.equal(a.status,'ready',a.error);assert.equal(b.replayed,true);assert.equal(a.id,b.id);assert.equal(f.resolves,1);
 const restarted=createCanvasAudioTools({...f.config,resolveAsset:()=>{throw Error('must not re-resolve known request');}}),replay=await restarted.extract(request);assert.equal(replay.replayed,true);assert.equal(replay.sha256,a.sha256);assert.equal(restarted.get(a.id).status,'ready');assert.equal(restarted.list(request.project_id).length,1);
 await assert.rejects(()=>restarted.extract({...request,end:2}),e=>e.status===409);await assert.rejects(()=>restarted.transcribe(request),e=>e.status===409);
 const another={...request,request_id:crypto.randomUUID()},reused=await f.tools.extract(another);assert.equal(reused.id,another.request_id);assert.equal(reused.replayed,true);assert.equal(reused.sha256,a.sha256);assert.equal(reused.url,`/files/canvas-audio/${another.request_id}/audio.wav`);assert.equal((await restarted.extract(another)).id,another.request_id);
});

test('ASR调用收到真实选段WAV及离线契约，分段可编辑且标明待校对，素材变化不会复用旧文字',async t=>{
 let calls=0,contract;const f=fixture(t,{workerRunner:async value=>{calls++;contract=value;const info=probe(value.audioFile);assert.equal(info.streams[0].sample_rate,'16000');assert.equal(info.streams[0].channels,1);return transcript(Number(info.format.duration));}}),request=f.request({language:'auto'}),job=await f.tools.transcribe(request);
 assert.equal(job.status,'ready',job.error);assert.equal(calls,1);assert.equal(contract.language,'auto');assert.equal(contract.maxSeconds,60);assert.equal(contract.maxBytes,16_000_000);assert(contract.lockPath.startsWith(path.join(f.data,'canvas-audio')));assert.equal(contract.initial_prompt,undefined);assert.equal(job.review_required,true);assert.equal(job.accuracy,'unverified-asr');assert.equal(job.segment_time_base,'extracted-audio');assert.deepEqual(job.segments,transcript(1.5).segments);assert.equal(job.language,'zh');
 job.segments[0].text='用户编辑';assert.equal(f.tools.get(job.id).segments[0].text,'本地测试');const same=await f.tools.transcribe({...request,request_id:crypto.randomUUID()});assert.equal(calls,1);assert.equal(same.replayed,true);
 encode(['-f','lavfi','-i','color=c=blue:s=64x48:r=12','-f','lavfi','-i','sine=frequency=900:sample_rate=48000','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',f.files.video]);const changed=await f.tools.transcribe({...request,request_id:crypto.randomUUID()});assert.equal(changed.status,'ready',changed.error);assert.equal(calls,2);assert.notEqual(changed.source_sha256,job.source_sha256);assert.equal((await f.tools.transcribe(request)).source_sha256,job.source_sha256);
});

test('无效转写时间或正文不能成为ready；空语音不伪造字幕；失败请求不自动再跑',async t=>{
 let calls=0;const f=fixture(t,{workerRunner:async()=>{calls++;const value=transcript(1.5);value.segments[1].end=3;return value;}}),request=f.request(),bad=await f.tools.transcribe(request);assert.equal(bad.status,'failed');assert.match(bad.error,/时间戳/);assert.equal(bad.text,undefined);assert.equal((await f.tools.transcribe(request)).status,'failed');assert.equal(calls,1);
 const mismatch=createCanvasAudioTools({...f.config,workerRunner:async()=>({...transcript(1.5),text:'伪造的正文'})}),mismatched=await mismatch.transcribe(f.request());assert.equal(mismatched.status,'failed');assert.match(mismatched.error,/正文与分段不一致/);
 const empty=createCanvasAudioTools({...f.config,workerRunner:async()=>({status:'empty'})}),none=await empty.transcribe(f.request());assert.equal(none.status,'failed');assert.match(none.error,/未识别到清晰语音/);assert.equal(none.text,undefined);assert.equal(none.segments,undefined);
});

test('路径/非有限时间/超长/大于16MB/无音轨和符号链接在执行ASR前拒绝',async t=>{
 let calls=0;const f=fixture(t,{workerRunner:async()=>{calls++;throw Error('must not run');}});
 for(const patch of [{asset_id:'../outside'},{asset_id:'https://example.test/a.mp3'},{request_id:'not-uuid'},{start:NaN},{start:-1},{start:2,end:1},{start:0,end:.1},{start:0,end:60.1},{start:0,end:4},{language:'fr'},{modelPath:'/outside'},{asset_id:'silent'}])await assert.rejects(()=>f.tools.transcribe(f.request(patch)));
 const big=path.join(f.data,'big.wav'),fd=fs.openSync(big,'w');fs.ftruncateSync(fd,CANVAS_AUDIO_LIMITS.assetBytes+1);fs.closeSync(fd);f.assets.set('big',{file:big});await assert.rejects(()=>f.tools.extract(f.request({asset_id:'big'})),/16MB/);
 const link=path.join(f.data,'link.wav');fs.symlinkSync(f.files.audio,link);f.assets.set('link',{file:link});await assert.rejects(()=>f.tools.extract(f.request({asset_id:'link'})),/普通文件/);assert.equal(calls,0);assert.deepEqual(fs.readdirSync(path.join(f.data,'canvas-audio')),[]);
});

test('服务重启中断任务不会自动ASR；音频文件或持久化记录篡改明确报错',async t=>{
 const f=fixture(t),request=f.request(),ready=await f.tools.extract(request),record=path.join(f.data,'canvas-audio',ready.id,'job.json'),stored=JSON.parse(fs.readFileSync(record));stored.status='transcribing';fs.writeFileSync(record,JSON.stringify(stored));let calls=0;
 const restarted=createCanvasAudioTools({...f.config,workerRunner:async()=>{calls++;return transcript(1.5);}});assert.equal(restarted.get(ready.id).status,'failed');assert.match(restarted.get(ready.id).error,/服务重启/);assert.equal((await restarted.extract(request)).status,'failed');assert.equal(calls,0);
 const another=await f.tools.extract(f.request());assert.equal(another.status,'ready',another.error);fs.appendFileSync(output(f,another),'corrupt');assert.throws(()=>f.tools.get(another.id),e=>e.status===409&&/指纹/.test(e.message));
 const state=path.join(f.data,'canvas-audio',another.id,'job.json'),tampered=JSON.parse(fs.readFileSync(state));tampered.source.sha256='0'.repeat(64);fs.writeFileSync(state,JSON.stringify(tampered));assert.throws(()=>f.tools.get(another.id),/完整性/);
});

test('本地模型不存在时能力只读报告不可用并拒绝ASR，仍可提取；编码器故障留失败任务',async t=>{
 const f=fixture(t,{modelPath:'/does-not-exist/local-model'}),caps=f.tools.capabilities();assert.equal(caps.modelPresent,false);assert.equal(caps.transcribeAvailable,false);assert.equal(caps.downloadsAllowed,false);assert.equal(caps.localOnly,true);assert.equal(caps.extractAvailable,true);await assert.rejects(()=>f.tools.transcribe(f.request()),e=>e.status===503);assert.deepEqual(fs.readdirSync(path.join(f.data,'canvas-audio')),[]);
 const extracted=await f.tools.extract(f.request());assert.equal(extracted.status,'ready',extracted.error);const broken=createCanvasAudioTools({...f.config,ffmpeg:path.join(f.data,'missing-ffmpeg')}),job=await broken.extract(f.request({end:2}));assert.equal(job.status,'failed');assert.match(job.error,/编码器无法启动/);assert.equal(broken.get(job.id).status,'failed');
});

test('现有Whisper base离线模型真实转写command.wav一次，返回实际语音分段并保留源文件', {timeout:180000},async t=>{
 const file=path.join(speech,'command.wav');if(!fs.existsSync(file)){t.skip('此机器没有现有零成本语音夹具');return;}const data=rootFor(t),tools=createCanvasAudioTools({data,ffmpeg:ff,probe,resolveAsset:id=>id==='command'?{file}:null}),caps=tools.capabilities();
 if(!caps.transcribeAvailable){t.skip('此机器没有已安装的离线Whisper环境；不下载');return;}
 assert.equal(caps.pythonPresent,true);assert.equal(caps.modulePresent,true);assert.equal(caps.modelPresent,true);assert.equal(caps.engine,CANVAS_ASR_ENGINE);assert.equal(caps.localOnly,true);const original=hash(file),job=await tools.transcribe({request_id:crypto.randomUUID(),project_id:'30000000-0000-4000-8000-000000000002',asset_id:'command',language:'auto'});
 assert.equal(job.status,'ready',job.error);assert(job.text.trim().length>0);assert(job.segments.length>0);assert.equal(job.review_required,true);assert.equal(job.engine,CANVAS_ASR_ENGINE);for(const segment of job.segments){assert(Number.isFinite(segment.start)&&Number.isFinite(segment.end));assert(segment.start>=0&&segment.end>segment.start&&segment.end<=job.audio.duration);assert(segment.text.trim());}assert.equal(hash(file),original);assert.equal(tools.get(job.id).text,job.text);
});
