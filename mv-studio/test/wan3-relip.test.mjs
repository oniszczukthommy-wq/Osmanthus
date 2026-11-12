import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createWan3Tasks,inspectWan3RelipVideo} from '../wan3-tasks.mjs';
import {buildWan3RelipRequest,wan3RelipEstimateCents} from '../wan3-provider.mjs';

const uuid=()=>crypto.randomUUID(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
  const root=fs.mkdtempSync(path.join(process.cwd(),'relip-fixture-')),data=path.join(root,'data');fs.mkdirSync(data);
  const videoId=uuid(),audioId=uuid(),videoPath=path.join(root,'source.mp4'),audioPath=path.join(root,'source.wav');
  fs.writeFileSync(videoPath,'synthetic test video');fs.writeFileSync(audioPath,'synthetic test audio');
  const make=(file,kind,mime,extra={})=>{const b=fs.readFileSync(file);return {file,mime,material:{kind,sha256:sha(b),bytes:b.length,...extra}};};
  const video=make(videoPath,'video','video/mp4',{duration:3.1}),audio=make(audioPath,'audio','audio/wav',{duration:10});
  const materials={asset:id=>id===videoId?video:id===audioId?audio:null};let posts=0,fail=false;const bodies=[],urls=[];
  const json=x=>new Response(JSON.stringify(x),{status:200});
  const fetchImpl=async(url,opts)=>{urls.push(url);
    if(url.includes('/uploads?'))return json({data:{upload_host:'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/account/folder',policy:'p',signature:'s',oss_access_key_id:'k',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});
    if(url.includes('dashscope-file-test.oss-cn-beijing'))return new Response('',{status:200});
    if(url.includes('video-synthesis')){posts++;bodies.push(JSON.parse(opts.body));if(fail)throw Error('connection interrupted');return json({output:{task_id:'test-task-1',task_status:'PENDING'}});}
    if(url.includes('/tasks/'))return json({output:{task_id:'test-task-1',task_status:'SUCCEEDED',video_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.mp4'}});
    return new Response(Buffer.from('mock valid video response > 32 bytes for safe test'),{status:200});
  };
  const probe=async file=>file===videoPath?{streams:[{codec_type:'video',width:640,height:480,avg_frame_rate:'24/1',duration:'3.1'}],format:{format_name:'mov,mp4',duration:'3.1'}}:file.endsWith('.mp4')?{streams:[{codec_type:'video',codec_name:'h264',width:640,height:480}],format:{format_name:'mov,mp4',duration:'3'}}:{streams:[{codec_type:'audio'}],format:{duration:file===audioPath?'10':'3'}};
  const clipAudio=async({target})=>fs.writeFileSync(target,'synthetic clipped audio');
  const config={data,key:'test-only',workspace:'',materials,probe,ffmpeg:'ffmpeg',clipAudio,fetchImpl,budgetCny:5};
  const input={request_id:uuid(),video_id:videoId,audio_id:audioId,prompt:'编辑视频，使人物口型随音频变化',start:0,audio_duration:3,duration:3,ratio:'4:3',confirmed_max_cost_cny:4.20};
  return {root,config,input,bodies,urls,posts:()=>posts,interrupt:()=>{fail=true;}};
}

test('万相参考视频与音频独立计价并且不得混用首帧',()=>{
  assert.equal(wan3RelipEstimateCents({duration:3,inputDuration:3.1}),420);
  const {body,estimatedCents}=buildWan3RelipRequest({prompt:'编辑镜头',videoUrl:'oss://dashscope-instant/a/video.mp4',audioUrl:'oss://dashscope-instant/a/audio.wav',inputDuration:3.1,audioDuration:3,audioBytes:100,duration:3});
  assert.equal(estimatedCents,420);assert.deepEqual(body.input.media.map(x=>x.type),['reference_video','reference_audio']);
  assert.throws(()=>wan3RelipEstimateCents({duration:15,inputDuration:15.1}));
  assert.throws(()=>buildWan3RelipRequest({prompt:'编辑',videoUrl:'http://internal.invalid',audioUrl:'oss://dashscope-instant/a/a.wav',inputDuration:3,audioDuration:3,audioBytes:100,duration:3}));
});

test('提交单镜口型共享预算、复用请求且输出新视频',async()=>{
  const f=fixture();try{const p=createWan3Tasks(f.config);assert.equal(p.estimateRelip({inputDuration:3.1,duration:3}).estimatedCostCny,4.2);const j=await p.submitRelip(f.input);assert.equal(j.status,'queued');assert.equal(j.estimatedCostCny,4.2);assert.deepEqual(f.bodies[0].input.media.map(x=>x.type),['reference_video','reference_audio']);assert.equal(f.posts(),1);assert.equal((await p.submitRelip(f.input)).status,'queued');assert.equal(f.posts(),1);assert.equal((await p.refresh(f.input.request_id)).status,'ready');assert(p.asset(f.input.request_id));await assert.rejects(()=>p.submitRelip({...f.input,request_id:uuid(),prompt:'另一个请求'}),{code:'WAN3_BUDGET_EXCEEDED'});assert.equal(f.posts(),1);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('报价变化和不合规输入在上传之前拒绝',async()=>{
  const f=fixture();try{const p=createWan3Tasks(f.config);await assert.rejects(()=>p.submitRelip({...f.input,confirmed_max_cost_cny:4.19}),{code:'WAN3_QUOTE_CHANGED'});assert.equal(f.urls.length,0);await assert.rejects(()=>p.submitRelip({...f.input,request_id:uuid(),audio_duration:0}));assert.equal(f.urls.length,0);assert.throws(()=>inspectWan3RelipVideo({streams:[{codec_type:'video',width:640,height:480,avg_frame_rate:'15/1'}],format:{format_name:'mov,mp4',duration:3}}));}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('已发送但网络中断时保留预算并拒绝重复付费',async()=>{
  const f=fixture();try{f.interrupt();let p=createWan3Tasks(f.config);await assert.rejects(()=>p.submitRelip(f.input),{code:'WAN3_SUBMISSION_UNCERTAIN'});assert.equal(f.posts(),1);p=createWan3Tasks(f.config);assert.equal((await p.submitRelip(f.input)).status,'uncertain');assert.equal(f.posts(),1);assert.equal(p.capabilities().remainingCny,.8);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
