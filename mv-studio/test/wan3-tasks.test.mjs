import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createWan3Tasks} from '../wan3-tasks.mjs';

function fixture(options={}){
  const root=fs.mkdtempSync(path.join(process.cwd(),'wan3-test-')), data=path.join(root,'data');fs.mkdirSync(data);
  const imageId=crypto.randomUUID(),audioId=crypto.randomUUID(),imageFile=path.join(root,'image.png'),audioFile=path.join(root,'audio.wav');fs.writeFileSync(imageFile,'fake image for mock');fs.writeFileSync(audioFile,'fake audio for mock');
  const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const image={file:imageFile,mime:'image/png',material:{kind:'image',bytes:fs.statSync(imageFile).size,sha256:hash(imageFile),width:512,height:512}};
  const audio={file:audioFile,mime:'audio/wav',material:{kind:'audio',bytes:fs.statSync(audioFile).size,sha256:hash(audioFile),duration:20}};
  const materials={asset:id=>id===imageId?image:id===audioId?audio:null};
  const output=Buffer.from('this represents a sufficiently long mocked video response');
  const calls=[];let failSubmit=false,badHost=false;
  const response=x=>new Response(JSON.stringify(x),{status:200});
  const fetchImpl=async(url,opts)=>{calls.push({url,opts});if(url.includes('/uploads?'))return response({data:{upload_host:'https://dashscope-file-test.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/account/folder',policy:'p',signature:'s',oss_access_key_id:'k',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});if(url.includes('dashscope-file-test.oss-cn-beijing'))return new Response('',{status:200});if(url.includes('video-synthesis')){if(failSubmit)throw Error('connection lost');return response({output:{task_id:'provider-1',task_status:'PENDING'}});}if(url.includes('/tasks/'))return response({output:{task_id:'provider-1',task_status:'SUCCEEDED',video_url:badHost?'https://attacker.invalid/x':'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.mp4'}});return new Response(output,{status:200,headers:{'Content-Length':String(output.length)}});};
  const clips=[];
  const probe=async file=>file.endsWith('.mp4')?{streams:[{codec_type:'video',codec_name:'h264',width:1280,height:720}],format:{format_name:'mov,mp4',duration:'5'}}:{streams:[{codec_type:'audio'}],format:{duration:file===audioFile?'20':String(clips.at(-1)?.duration??5)}};
  const clipAudio=async({target,...request})=>{clips.push(request);fs.writeFileSync(target,'mock audio');};
  const config={data,key:'test-key',workspace:'test-workspace',materials,probe,ffmpeg:'ffmpeg',clipAudio,fetchImpl,budgetCny:3,...options};
  const input={request_id:crypto.randomUUID(),prompt:'角色唱歌',image_id:imageId,audio_id:audioId,start:0,duration:5,ratio:'16:9'};
  return {root,config,input,calls,clips,output,audioFile,setFail:()=>{failSubmit=true;},setBadHost:()=>{badHost=true;}};
}

test('task persists and replays without repeat POST; query downloads and validates output',async()=>{
  const f=fixture();try{let p=createWan3Tasks(f.config);const first=await p.submit(f.input);assert.equal(first.status,'queued');assert.equal(f.calls.filter(x=>x.url.includes('video-synthesis')).length,1);p=createWan3Tasks(f.config);assert.equal((await p.submit(f.input)).status,'queued');assert.equal(f.calls.filter(x=>x.url.includes('video-synthesis')).length,1);const done=await p.refresh(f.input.request_id);assert.equal(done.status,'ready');assert.deepEqual(fs.readFileSync(p.asset(f.input.request_id).file),f.output);await assert.rejects(()=>p.submit({...f.input,request_id:crypto.randomUUID(),prompt:'其他'}),{code:'WAN3_BUDGET_EXCEEDED'});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('network loss during paid submit blocks repeat after process restart',async()=>{
  const f=fixture();try{f.setFail();let p=createWan3Tasks(f.config);await assert.rejects(()=>p.submit(f.input),{code:'WAN3_SUBMISSION_UNCERTAIN'});p=createWan3Tasks(f.config);assert.equal((await p.submit(f.input)).status,'uncertain');assert.equal(f.calls.filter(x=>x.url.includes('video-synthesis')).length,1);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('untrusted output host is not downloaded',async()=>{
  const f=fixture();try{f.setBadHost();const p=createWan3Tasks(f.config);await p.submit(f.input);assert.equal((await p.refresh(f.input.request_id)).status,'download_failed');assert.equal(f.calls.some(x=>x.url.includes('attacker.invalid')),false);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('project audio source is resolved and bound to the audio hash',async()=>{
  const f=fixture();try{const p=createWan3Tasks({...f.config,resolveAudioSource:source=>{assert.equal(source.id,'sample');return f.audioFile;}});const input={...f.input,audio_source:{id:'sample'}};delete input.audio_id;assert.equal((await p.submit(input)).status,'queued');fs.writeFileSync(f.audioFile,'different audio');await assert.rejects(()=>p.submit(input),{code:'WAN3_CONFLICT'});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('disabled when required configuration is missing',async()=>{
  const f=fixture({workspace:'',key:''});try{const p=createWan3Tasks(f.config);assert.equal(p.capabilities().available,false);await assert.rejects(()=>p.submit(f.input),{code:'WAN3_UNAVAILABLE'});assert.equal(f.calls.length,0);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('shared endpoint supports an account key without workspace and isolates task identity on key change',async()=>{
  const f=fixture({workspace:''});try{
    const p=createWan3Tasks(f.config);assert.equal(p.capabilities().available,true);
    assert.equal((await p.submit(f.input)).status,'queued');
    assert.equal(f.calls.find(x=>x.url.includes('video-synthesis')).url,'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');
    const changed=createWan3Tasks({...f.config,key:'another-key'});assert.equal(changed.get(f.input.request_id),null);
    await assert.rejects(()=>changed.submit(f.input),{code:'WAN3_CONFLICT'});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('invalid workspace label disables provider before any request',async()=>{
  const f=fixture({workspace:'evil.example'});try{const p=createWan3Tasks(f.config);assert.equal(p.capabilities().available,false);await assert.rejects(()=>p.submit(f.input),{code:'WAN3_UNAVAILABLE'});assert.equal(f.calls.length,0);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('fractional audio duration trims only the selected portion and is bound to idempotency',async()=>{
  const f=fixture();try{const p=createWan3Tasks(f.config);const input={...f.input,start:15.75,duration:5,audio_duration:4.25};const job=await p.submit(input);assert.equal(job.status,'queued');assert.equal(f.clips[0].duration,4.25);const req=f.calls.find(x=>x.url.includes('video-synthesis'));assert.equal(JSON.parse(req.opts.body).parameters.duration,5);await assert.rejects(()=>p.submit({...input,audio_duration:4}),{code:'WAN3_CONFLICT'});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('invalid or overflowing audio duration blocks all network requests',async()=>{
  const f=fixture();try{const p=createWan3Tasks(f.config);for(const patch of [{audio_duration:.5},{audio_duration:5.1},{audio_duration:-1},{audio_duration:NaN},{audio_duration:16},{start:18,audio_duration:4}])await assert.rejects(()=>p.submit({...f.input,request_id:crypto.randomUUID(),...patch}));assert.equal(f.calls.length,0);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
