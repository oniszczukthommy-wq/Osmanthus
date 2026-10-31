import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {selectMusicRange,musicSlots,affectedShots,validateCreativePlan} from '../public/mv-director-domain.js';
import {createMVDirector,analyzeMusic} from '../mv-director.mjs';
const ff=process.env.FFMPEG_BIN||'ffmpeg',fp=process.env.FFPROBE_BIN||(ff.includes('/')?path.join(path.dirname(ff),'ffprobe'):'ffprobe');
const encode=args=>execFileSync(ff,['-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],timeout:60000});
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
const project={source:{duration:201.23},lyrics:[{start:10,end:14,text:'同一句歌词'},{start:25,end:29,text:'下一句歌词'},{start:90,end:94,text:'同一句歌词'}]};
test('歌词选择绑定具体位置并保留边界，整首包含无歌词段落',()=>{
  assert.equal(selectMusicRange(project,{mode:'lyrics',from:2,to:2}).start,89.82);
  assert.equal(selectMusicRange(project,{mode:'full'}).duration,201.23);
  assert.throws(()=>selectMusicRange(project,{mode:'lyrics',from:3,to:4}));
  assert.throws(()=>selectMusicRange(project,{mode:'range',start:-1,end:3}));
  const slots=musicSlots(project,selectMusicRange(project,{mode:'full'}));
  assert.equal(slots[0].start,0);assert.equal(slots.at(-1).end,201.23);
  for(let i=1;i<slots.length;i++)assert.equal(slots[i].start,slots[i-1].end);
  assert(slots.every(s=>s.duration>=2&&s.duration<=10));assert(slots.some(s=>s.lyrics.length===0));
  assert(new Set(slots.map(s=>s.duration)).size>1,'镜头不是固定5秒切片');
});
function plan(slots){return{summary:'音乐引导的海边故事',style:'自然电影感',characters:[{name:'旅人',description:'穿蓝色外套的旅人'}],scenes:[{name:'海边',description:'清晨的海岸'}],shots:slots.map((s,i)=>({id:s.id,name:'海边 '+(i+1),description:`第${i+1}镜，缓缓行走，镜头平移`,sceneId:'scene-1',characterIds:i===0?['character-1']:[]}))};}
test('角色修改影响引用该角色的镜头；时间和结构由服务器固定',()=>{
  const slots=musicSlots(project,{start:0,end:15,duration:15}),p=validateCreativePlan(plan(slots),slots);
  assert.deepEqual(affectedShots(p,'character-1'),['shot-1']);assert.deepEqual(affectedShots(p,'scene-1'),p.shots.map(s=>s.id));
  assert.throws(()=>affectedShots(p,'missing'));const invalid=plan(slots);invalid.shots[0].sceneId='not-a-scene';assert.throws(()=>validateCreativePlan(invalid,slots));
});
function fixture(t,{budget=100,brokenModel=false,duration=16}={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'osmanthus-director-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const audio=path.join(data,'song.wav');encode(['-f','lavfi','-i','sine=frequency=330:sample_rate=16000','-t',String(duration),audio]);
  const imageFile=path.join(data,'frame.png');encode(['-f','lavfi','-i','color=c=blue:s=1280x720','-frames:v','1',imageFile]);
  const source={id:crypto.randomUUID()+'.wav',duration,url:'/files/uploads/song.wav',name:'测试歌曲'},p={id:crypto.randomUUID(),title:'测试歌曲',source,lyrics:[{start:1,end:5,text:'测试歌词'},{start:8,end:12,text:'新的歌词'}],manualLyrics:'测试歌词\n新的歌词'};
  const pictures=new Map(),clips=new Map(),assets=new Map(),calls={model:0,image:0,video:0};
  const materials={upload:(name,bytes)=>{const id=crypto.randomUUID(),file=path.join(data,id+'.png');fs.writeFileSync(file,bytes);const material={id,name,kind:'image',bytes:bytes.length,url:'/files/materials/'+id+'.png'};assets.set(id,{file,material});return material;},asset:id=>assets.get(id)};
  const image={capabilities:()=>({available:true,remainingCny:budget,estimatedCostCny:.2}),get:id=>pictures.get(id),asset:id=>pictures.has(id)?{file:imageFile}:null,submit:async input=>{calls.image++;const result={id:input.request_id,status:'ready',url:'/files/image/'+input.request_id+'.png'};pictures.set(result.id,result);return result;}};
  const video={capabilities:()=>({available:true,remainingCny:budget,estimatedCostsCny:Object.fromEntries(Array.from({length:14},(_,i)=>[i+2,(i+2)*.15]))}),get:id=>clips.get(id),asset:id=>clips.get(id)?.asset,
    submit:async input=>{calls.video++;const file=path.join(data,input.request_id+'.mp4');encode(['-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t',String(input.duration),'-c:v','libx264','-pix_fmt','yuv420p',file]);const result={id:input.request_id,status:'ready',asset:{file}};clips.set(result.id,result);return result;}};
  const fetchImpl=async(_url,options)=>{calls.model++;if(brokenModel)throw Error('network interrupted');const context=JSON.parse(JSON.parse(options.body).messages[1].content);const response=context.target?{name:'新旅人',description:'穿红色外套的旅人'}:plan(context.slots);return{ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]})};};
  const options={data,key:'test-only',image,video,materials,audioPath:()=>audio,probe,ffmpeg:ff,fetchImpl,pollMs:60000,analyze:async()=>({accents:[],energy:[]})};
  const d=createMVDirector(options);t.after(()=>d.close());return{data,p,d,options,calls,audio,video};
}
async function execute(f,session,kind,input){const j=f.d.start({session_id:session.id,revision:session.revision,request_id:crypto.randomUUID(),kind,input});await f.d.refresh(j.id);const result=f.d.job(j.id);assert.equal(result.status,'ready',result.message);return f.d.get(session.id);}
test('完整方案、图片、真实视频合成；只改一个角色后复用不受影响的图和视频',async t=>{
  const f=fixture(t);let s=f.d.open(f.p);const original=fs.readFileSync(f.audio);
  s=await execute(f,s,'prepare',{selection:{mode:'full'},idea:'海边旅行',ratio:'16:9',references:[]});assert.equal(s.range.duration,16);const shotCount=s.plan.shots.length;assert(shotCount>=2);
  s=await execute(f,s,'preview',{confirmed:true});assert.equal(f.calls.image,shotCount+2);
  s=await execute(f,s,'render',{confirmed:true,subtitles:true});const first=s.generated;assert.equal(f.calls.video,shotCount);assert.equal(f.d.open(f.p).subtitles,true,'刷新或重开工程保留字幕偏好');
  const output=f.d.asset(first.id);assert.ok(output);const info=probe(output.file);assert(Math.abs(Number(info.format.duration)-16)<.15);assert(info.streams.some(s=>s.codec_type==='audio'));assert.equal(info.streams.find(s=>s.codec_type==='video').width,1280);
  const unmodified=s.previews['shot-2'].imageId;s=await execute(f,s,'revise',{target:'character-1',instruction:'换红色外套'});assert.equal(s.generated,null);assert.equal(s.previews['shot-2'].imageId,unmodified);assert(!s.previews['shot-1']);
  assert.equal(f.d.quote(s.id,'preview').images,2);s=await execute(f,s,'preview',{confirmed:true});assert.equal(f.calls.image,shotCount+4);assert.equal(f.d.quote(s.id,'render').shots,1);
  s=await execute(f,s,'render',{confirmed:true,subtitles:false});assert.equal(f.calls.video,shotCount+1);assert.equal(s.outputs.length,2);assert(f.d.asset(first.id),'旧成片未覆盖');assert.deepEqual(fs.readFileSync(f.audio),original);
});
test('重启、重复请求、并发修改和不明确的提交均不会重复调用模型',async t=>{
  const f=fixture(t,{brokenModel:true}),s=f.d.open(f.p),input={session_id:s.id,revision:0,request_id:crypto.randomUUID(),kind:'prepare',input:{selection:{mode:'full'},idea:'海边',ratio:'16:9',references:[]}};
  f.d.start(input);assert.throws(()=>f.d.start({...input,request_id:crypto.randomUUID(),input:{...input.input,idea:'其他'}}),/等待/);
  await f.d.refresh(input.request_id);assert.equal(f.d.job(input.request_id).status,'uncertain');assert.equal(f.calls.model,1);
  f.d.close();const resumed=createMVDirector(f.options);t.after(()=>resumed.close());assert.equal(resumed.start({...input,request_id:crypto.randomUUID()}).id,input.request_id);await resumed.refresh(input.request_id);assert.equal(f.calls.model,1);
});
test('预算不足不生成部分图片，歌曲变更阻止旧方案继续制作',async t=>{
  const f=fixture(t,{budget:.3});let s=f.d.open(f.p);s=await execute(f,s,'prepare',{selection:{mode:'full'},idea:'海边',ratio:'16:9',references:[]});
  assert.throws(()=>f.d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'preview',input:{confirmed:true}}),/额度不足/);assert.equal(f.calls.image,0);
  fs.appendFileSync(f.audio,'changed');assert.throws(()=>f.d.start({session_id:s.id,revision:s.revision,request_id:crypto.randomUUID(),kind:'revise',input:{target:'all',instruction:'更暖'}}),/版本发生变化/);
});
test('本地声音分析产生有界的声学信息，不伪造精确拍点',async t=>{
  const f=fixture(t),result=await analyzeMusic(f.audio,ff,{start:0,duration:16});assert.equal(result.basis,'local-energy-and-accent-estimates');assert(result.energy.length>0);assert(result.energy.every(e=>e.time>=0&&e.time<=16&&e.value>=0&&e.value<=1));
});

 test('201秒整首覆盖、逐镜真实编码、完整歌曲合成，不依赖单次视频模型长度',async t=>{
  const f=fixture(t,{duration:201.23});let s=f.d.open(f.p);
  s=await execute(f,s,'prepare',{selection:{mode:'full'},idea:'完整海边故事',ratio:'16:9',references:[]});
  assert.equal(s.range.duration,201.23);assert(s.plan.shots.length>20);
  s=await execute(f,s,'preview',{confirmed:true});s=await execute(f,s,'render',{confirmed:true,subtitles:false});
  const output=f.d.asset(s.generated.id),info=probe(output.file);assert(Math.abs(Number(info.format.duration)-201.23)<.15);
  assert.equal(s.generated.source_sha256,s.source_sha256);assert.equal(info.streams.find(x=>x.codec_type==='audio').codec_name,'aac');
 });
