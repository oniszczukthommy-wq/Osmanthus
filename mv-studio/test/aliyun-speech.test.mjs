import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAliSpeech,ALI_SPEECH_VOICES,billableSpeechCharacters,splitSpeechText,inspectPcmWav,finalizeProviderPcmWav} from '../aliyun-speech.mjs';

const fp=mediaTools().ffprobe;
const probe=file=>JSON.parse(execFileSync(fp,['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}));
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const input=(patch={})=>({request_id:crypto.randomUUID(),text:'你好，欢迎来到桂花创作画布。',voice:'Cherry',language_type:'Chinese',...patch});
function wav(value=1200,sampleRate=24000){const count=sampleRate/10,b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sampleRate,24);b.writeUInt32LE(sampleRate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)b.writeInt16LE(value,44+i*2);return b;}
function sandbox(t,options={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'mv-aliyun-speech-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const config={data,key:'server-only-speech-secret',workspace:'llm-test',probe,fetchImpl:async()=>{throw Error('Every call requires a mock');},...options};return{data,folder:path.join(data,'aliyun-speech'),config,adapter:createAliSpeech(config)};}
function flow({post,download}={}){const calls=[];let posts=0;const fetchImpl=async(url,init)=>{calls.push({url:String(url),init});if(init.method==='POST'){const index=posts++;return post?post(index,url,init):json({request_id:'speech-request-'+index,output:{finish_reason:'stop',audio:{url:`http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/segment-${index}.wav?Expires=9999999999&Signature=speech-signed-private`,expires_at:9999999999}},usage:{characters:20}});}return download?download(url,init):new Response(wav(),{headers:{'Content-Type':'audio/wav','Content-Length':String(wav().length)}});};return{calls,fetchImpl};}

test('官方四个非克隆系统音色、汉字双计数和1000字拆段边界',()=>{
  assert.equal(ALI_SPEECH_VOICES.length,4);assert.deepEqual(ALI_SPEECH_VOICES.map(v=>v.id),['Cherry','Jennifer','Ethan','Ryan']);assert.equal(new Set(ALI_SPEECH_VOICES.map(v=>v.gender)).size,2);
  assert.equal(billableSpeechCharacters('你好'),4);assert.equal(billableSpeechCharacters('中A文123'),8);assert.equal(billableSpeechCharacters('中文。'),5);assert.equal(billableSpeechCharacters('中 文。'),6);
  for(const text of['汉'.repeat(1000),'汉'.repeat(400)+'。'+'字'.repeat(450),'汉'.repeat(499)+'。'+'字'.repeat(490)]){const segments=splitSpeechText(text);assert.equal(segments.join(''),text);assert.equal(segments.length,2);assert(segments.every(s=>Array.from(s).length<=500));}
  assert.throws(()=>splitSpeechText('汉'.repeat(1001)));assert.throws(()=>splitSpeechText('<speak>你好</speak>'));assert.throws(()=>splitSpeechText('hello\0'));
});

test('真实PCM WAV结构校验，拒绝截断、伪扩展、错误位深和采样配置',()=>{
  const info=inspectPcmWav(wav());assert.equal(info.sampleRate,24000);assert.equal(info.channels,1);assert.equal(info.duration,.1);
  for(const value of[Buffer.from('<audio>'),wav().subarray(0,100),Buffer.alloc(44)])assert.throws(()=>inspectPcmWav(value));
  const wrong=wav();wrong.writeUInt16LE(8,34);assert.throws(()=>inspectPcmWav(wrong));
});

test('complete provider streaming WAV header is finalized without touching samples',async t=>{
 const source=wav(),streaming=Buffer.from(source);streaming.writeUInt32LE(0x7fffffbf,4);streaming.writeUInt32LE(0x7fffff9b,40);
 const fixed=finalizeProviderPcmWav(streaming);assert(fixed.normalized);assert.deepEqual(fixed.bytes,source);assert.deepEqual(fixed.bytes.subarray(44),streaming.subarray(44));assert.throws(()=>finalizeProviderPcmWav(streaming.subarray(0,101)));
 const mock=flow({download:()=>new Response(streaming,{headers:{'Content-Type':'audio/x-wav','Content-Length':String(streaming.length)}})}),{adapter}=sandbox(t,{fetchImpl:mock.fetchImpl});const result=await adapter.submit(input());assert.equal(result.status,'ready');assert.equal(result.duration,.1);assert.equal(mock.calls.filter(c=>c.init.method==='POST').length,1);
});

test('官方同步请求、HTTP结果升级HTTPS、幂等重启及ffprobe真实本地音频',async t=>{
  const mock=flow(),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();
  const result=await adapter.submit(request);assert.equal(result.status,'ready');assert.equal(result.url,`/files/aliyun-speech/${request.request_id}/audio.wav`);assert.equal(result.duration,.1);assert.equal(result.sampleRate,24000);assert.equal(result.channels,1);assert.equal(result.output.validation,'ffprobe');
  const call=mock.calls[0],body=JSON.parse(call.init.body);assert.equal(call.url,'https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');assert.equal(call.init.headers.Authorization,'Bearer server-only-speech-secret');assert.deepEqual(body,{model:'qwen3-tts-flash',input:{text:request.text,voice:'Cherry',language_type:'Chinese'}});
  assert.equal(new URL(mock.calls[1].url).protocol,'https:');assert.equal(mock.calls[1].init.headers,undefined);assert.equal(mock.calls[1].init.redirect,'manual');
  const file=adapter.asset(request.request_id).file;assert.equal(probe(file).streams[0].codec_name,'pcm_s16le');assert.equal(result.sha256,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.equal((await createAliSpeech(config).submit(request)).replayed,true);assert.equal(mock.calls.length,2);
  const record=fs.readFileSync(path.join(folder,request.request_id+'.json'),'utf8');assert(!record.includes('speech-signed-private'));assert(!record.includes('server-only-speech-secret'));assert(!record.includes('http://'));assert(!record.includes('https://'));
  await assert.rejects(adapter.submit({...request,voice:'Ryan'}),error=>error.status===409);
});

test('1000中文只拆两次授权POST、逐段先登记、PCM顺序拼接成单个真WAV',async t=>{
  let postIndex=0;const mock=flow({post:(index,_url,init)=>{postIndex++;assert(Array.from(JSON.parse(init.body).input.text).length<=500);return json({request_id:'request-'+index,output:{finish_reason:'stop',audio:{url:`https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/${index}.wav?Signature=private`,expires_at:9999999999}}});},download:url=>new Response(wav(new URL(url).pathname.includes('/0.')?1000:-1000))});
  const{adapter,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input({text:'汉'.repeat(1000),voice:'Ethan'}),result=await adapter.submit(request);
  assert.equal(result.status,'ready');assert.equal(result.segmentCount,2);assert.equal(postIndex,2);assert.equal(result.estimatedCostCny,.16);assert.equal(result.duration,.2);assert.equal(adapter.capabilities().usedCny,.16);
  const bytes=fs.readFileSync(path.join(folder,request.request_id,'audio.wav')),info=inspectPcmWav(bytes);assert.equal(bytes.readInt16LE(info.offset),1000);assert.equal(bytes.readInt16LE(info.offset+4800),-1000);
});

test('1元内跨实例预算含未知结果；确定失败只释放未消费分段',async t=>{
  let failNext=false;const mock=flow({post:index=>failNext?json({code:'InvalidParameter',message:'bad input'},400):json({output:{finish_reason:'stop',audio:{url:`https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/${index}.wav`,expires_at:9999999999}}})}),{adapter,config}=sandbox(t,{fetchImpl:mock.fetchImpl,budgetCny:.00064});
  await adapter.submit(input({text:'你好'}));failNext=true;assert.equal((await adapter.submit(input({text:'失败'}))).accountedCostCny,0);failNext=false;await createAliSpeech(config).submit(input({text:'您好'}));
  await assert.rejects(adapter.submit(input({text:'再见'})),error=>error.status===402);assert.equal(adapter.capabilities().usedCny,.00064);
  const partial=flow({post:index=>index===1?json({code:'InvalidParameter',message:'second part failed'},400):json({output:{finish_reason:'stop',audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/first.wav',expires_at:9999999999}}})}),other=sandbox(t,{fetchImpl:partial.fetchImpl});
  const failed=await other.adapter.submit(input({text:'汉'.repeat(1000)}));assert.equal(failed.status,'failed');assert.equal(failed.accountedCostCny,.08);assert.equal(other.adapter.capabilities().usedCny,.08);assert.equal(partial.calls.length,2);
  assert.throws(()=>createAliSpeech({...config,budgetCny:1.01}));
});

test('第二段结果不明停止，不重复首段、不补发未知段，refresh仅回读状态',async t=>{
  const mock=flow({post:index=>{if(index===1)throw new DOMException('mock timeout','TimeoutError');return json({output:{finish_reason:'stop',audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/first.wav',expires_at:9999999999}}});}}),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input({text:'汉'.repeat(1000)});
  await assert.rejects(adapter.submit(request),error=>error.retryBlocked);assert.equal(adapter.get(request.request_id).status,'uncertain');assert.equal(adapter.capabilities().usedCny,.16);const saved=JSON.parse(fs.readFileSync(path.join(folder,request.request_id+'.json')));assert.deepEqual(saved.segments.map(s=>s.status),['generated','uncertain']);
  await assert.rejects(createAliSpeech(config).submit(request),error=>error.retryBlocked);await assert.rejects(adapter.submit({...request,request_id:crypto.randomUUID()}),error=>error.retryBlocked);await adapter.refresh(request.request_id);assert.equal(mock.calls.length,2);
});

test('下载失败跨重启解密恢复，无再次付费；过期签名可由已缓存PCM离线重建',async t=>{
  let available=false;const mock=flow({download:()=>available?new Response(wav()):new Response('',{status:503})}),{adapter,config,folder}=sandbox(t,{fetchImpl:mock.fetchImpl}),request=input();
  assert.equal((await adapter.submit(request)).status,'download_failed');const wrong=createAliSpeech({...config,key:'wrong-key'});assert.equal((await wrong.refresh(request.request_id)).status,'download_failed');assert.equal(mock.calls.length,2);
  available=true;assert.equal((await createAliSpeech(config).refresh(request.request_id)).status,'ready');assert.equal(mock.calls.length,3);
  fs.unlinkSync(path.join(folder,request.request_id,'audio.wav'));const file=path.join(folder,request.request_id+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.segments[0].expiresAt='2000-01-01T00:00:00.000Z';fs.writeFileSync(file,JSON.stringify(saved));
  assert.equal((await createAliSpeech(config).refresh(request.request_id)).status,'ready');assert.equal(mock.calls.length,3);
});

test('恶意域名/redirect、格式错误和非匹配分段均不成为ready',async t=>{
  const unsafe=flow({post:()=>json({output:{finish_reason:'stop',audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.test/a.wav',expires_at:9999999999}}})}),one=sandbox(t,{fetchImpl:unsafe.fetchImpl});assert.equal((await one.adapter.submit(input())).status,'download_failed');assert.equal(unsafe.calls.length,1);
  const redirect=flow({download:()=>new Response(null,{status:302,headers:{Location:'https://evil.test/a.wav'}})}),two=sandbox(t,{fetchImpl:redirect.fetchImpl});assert.equal((await two.adapter.submit(input())).status,'download_failed');assert.equal(redirect.calls.length,2);
  const invalid=flow({download:()=>new Response(Buffer.from('<svg/>'))}),three=sandbox(t,{fetchImpl:invalid.fetchImpl});assert.equal((await three.adapter.submit(input())).status,'download_failed');
  const mismatch=flow({download:url=>new Response(wav(100,new URL(url).pathname.includes('segment-0')?24000:16000))}),four=sandbox(t,{fetchImpl:mismatch.fetchImpl});assert.equal((await four.adapter.submit(input({text:'汉'.repeat(1000)}))).status,'download_failed');
});

test('只接受预设中文纯文本；缺key、克隆输入、路径和预算损坏不发费',async t=>{
  const mock=flow(),{adapter,config,folder,data}=sandbox(t,{fetchImpl:mock.fetchImpl});
  for(const patch of[{request_id:'../unsafe'},{voice:'my-cloned-voice'},{language_type:'English'},{text:'汉'.repeat(1001)},{audio_url:'https://example.test/clone.wav'},{reference_audio:'base64'},{instructions:'clone this voice'}])await assert.rejects(adapter.submit(input(patch)));
  await assert.rejects(createAliSpeech({...config,key:''}).submit(input()),error=>error.status===503);assert.equal(mock.calls.length,0);
  const request=input();await adapter.submit(request);const external=path.join(data,'user-original.wav'),output=adapter.asset(request.request_id).file;fs.renameSync(output,external);fs.symlinkSync(external,output);assert.throws(()=>adapter.asset(request.request_id));assert(fs.readFileSync(external).equals(wav()));
  const file=path.join(folder,request.request_id+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.accountedMicros=0;fs.writeFileSync(file,JSON.stringify(saved));assert.equal(adapter.capabilities().available,false);await assert.rejects(adapter.submit(input()),error=>error.status===503);
});
