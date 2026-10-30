import assert from 'node:assert/strict';
import {createPlaybackQueue,mixOverviewPeaks,isPlaybackSpace} from './studio-player.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const log=[],state={projectId:'original',playing:false,currentTime:0,duration:20,ready:true,volume:1};let busy=false;
 const engine={ready:()=>!busy,getProject:()=>({id:state.projectId}),settle:async()=>true,
  activate:async id=>{log.push(['activate',id]);state.projectId=id;},
  transport:{unlock:async()=>log.push(['unlock']),state:()=>({...state}),pause:()=>{state.playing=false;log.push(['pause']);},
   play:async(id,at,allowed)=>{if(!allowed())return;state.projectId=id;state.playing=true;state.currentTime=at??state.currentTime;log.push(['play',id]);}}};
 return{engine,state,log,setBusy:v=>busy=v};
}
let passed=0;
async function test(name,fn){await fn();passed++;process.stdout.write('PASS '+name+'\n');}

await test('homepage playback uses engine without navigation',async()=>{
 const f=fixture(),page='home',queue=createPlaybackQueue(f.engine);await queue.playSong('next-song');
 assert.equal(page,'home');assert.deepEqual(f.log.filter(x=>x[0]==='play'),[['play','next-song']]);assert.equal(f.state.projectId,'next-song');queue.destroy();
});
await test('same song click pauses with no second activation or play',async()=>{
 const f=fixture();f.state.playing=true;const queue=createPlaybackQueue(f.engine);const result=await queue.playSong('original');assert.equal(result.paused,true);assert.equal(f.state.playing,false);assert.deepEqual(f.log,[['pause']]);queue.destroy();
});
await test('newest requested song wins during slow source activation',async()=>{
 const f=fixture(),wait=deferred(),queue=createPlaybackQueue(f.engine);f.engine.activate=async id=>{f.log.push(['activate',id]);if(id==='one')await wait.promise;f.state.projectId=id;};
 const first=queue.playSong('one');await turn();const second=queue.playSong('two');wait.resolve();const a=await first,b=await second;
 assert.equal(a.superseded,true);assert.equal(b.played,true);assert.deepEqual(f.log.filter(x=>x[0]==='play'),[['play','two']]);queue.destroy();
});
await test('middle queued click resolves without playing an obsolete song',async()=>{
 const f=fixture(),wait=deferred(),queue=createPlaybackQueue(f.engine);f.engine.activate=async id=>{if(id==='one')await wait.promise;f.state.projectId=id;};
 const one=queue.playSong('one');await turn();const two=queue.playSong('two'),three=queue.playSong('three');wait.resolve();
 assert.equal((await one).superseded,true);assert.equal((await two).superseded,true);assert.equal((await three).played,true);assert.deepEqual(f.log.filter(x=>x[0]==='play'),[['play','three']]);queue.destroy();
});
await test('pause cancels late play after source loading',async()=>{
 const f=fixture(),wait=deferred(),queue=createPlaybackQueue(f.engine);f.engine.activate=async id=>{await wait.promise;f.state.projectId=id;};
 const request=queue.playSong('one');await turn();queue.pause();wait.resolve();assert.equal((await request).superseded,true);assert.equal(f.state.playing,false);assert.equal(f.log.filter(x=>x[0]==='play').length,0);queue.destroy();
});
await test('real source error releases queue and can be retried',async()=>{
 const f=fixture(),queue=createPlaybackQueue(f.engine);f.engine.activate=async()=>{throw Error('source failed');};await assert.rejects(queue.playSong('one'),/source failed/);
 f.engine.activate=async id=>{f.state.projectId=id;};await queue.playSong('two');assert.equal(f.state.playing,true);assert.equal(queue.working,false);queue.destroy();
});
await test('superseded source failure does not fail the newer user intent',async()=>{
 const f=fixture(),wait=deferred(),queue=createPlaybackQueue(f.engine);f.engine.activate=async id=>{if(id==='one'){await wait.promise;throw Error('old failure');}f.state.projectId=id;};
 const one=queue.playSong('one');await turn();const two=queue.playSong('two');wait.resolve();assert.equal((await one).superseded,true);assert.equal((await two).played,true);assert.equal(f.state.projectId,'two');queue.destroy();
});
await test('unsettled mixer refuses switching songs',async()=>{
 const f=fixture(),queue=createPlaybackQueue(f.engine);f.engine.settle=async()=>false;await assert.rejects(queue.playSong('one'),/轨道修改/);assert.equal(f.state.projectId,'original');assert.equal(f.log.filter(x=>x[0]==='play').length,0);queue.destroy();
});
await test('metadata-only project can prepare audio on first play before playback starts',async()=>{
 const f=fixture(),prepared=deferred();let preparing=false,loaded=false;
 f.engine.ready=()=>loaded;f.engine.canPrepareAudio=()=>!loaded;
 f.engine.transport.play=async(id,at,allowed)=>{preparing=true;await prepared.promise;loaded=true;if(!allowed())return;f.state.playing=true;f.log.push(['play',id]);};
 const queue=createPlaybackQueue(f.engine),request=queue.playSong('original');await turn();
 assert.equal(preparing,true);assert.equal(queue.working,true);assert.equal(f.state.playing,false);assert.equal(f.log.some(x=>x[0]==='activate'),false);
 prepared.resolve();assert.equal((await request).played,true);assert.equal(f.state.playing,true);queue.destroy();
});
await test('busy engine cannot use lazy preparation to bypass the audio-update guard',async()=>{
 const f=fixture();f.engine.ready=()=>false;f.engine.canPrepareAudio=()=>false;
 const queue=createPlaybackQueue(f.engine);await assert.rejects(queue.playSong('one'),/音轨正在更新/);
 assert.equal(f.state.playing,false);assert.equal(f.state.projectId,'original');assert.equal(f.log.some(x=>['activate','play'].includes(x[0])),false);queue.destroy();
});

await test('Space remains available for modal controls and does not start background playback',async()=>{
 const event={code:'Space',target:{closest:()=>null}};
 assert.equal(isPlaybackSpace(event),true);assert.equal(isPlaybackSpace(event,{modalOpen:true}),false);
});
await test('text spaces in inherited and nonstandard contenteditable fields do not control music',async()=>{
 // Browsers set isContentEditable for inherited editors, including descendants.
 assert.equal(isPlaybackSpace({code:'Space',target:{isContentEditable:true,closest:()=>null}}),false);
 for(const attribute of ['', 'plaintext-only']){
  const target={closest:selector=>selector.includes('[contenteditable]:not(')?{attribute}:null};
  assert.equal(isPlaybackSpace({code:'Space',target}),false);
 }
});
await test('IME selection and modified Space shortcuts do not toggle the song',async()=>{
 for(const flag of ['isComposing','ctrlKey','metaKey','altKey','repeat','defaultPrevented'])assert.equal(isPlaybackSpace({code:'Space',[flag]:true,target:{closest:()=>null}}),false);
});

const samples=Float32Array.from({length:400},(_,i)=>Math.sin(i*.4)*.3);
const buffer=array=>({numberOfChannels:1,length:array.length,getChannelData:()=>array});
const project={master_gain:.7,tracks:[{id:'a',gain_db:0,muted:false,solo:false},{id:'b',gain_db:0,muted:false,solo:false}]};
const buffers={a:{buffer:buffer(samples)},b:{buffer:buffer(Float32Array.from(samples,x=>-x))}};
await test('waveform follows real sample cancellation instead of summing invented peaks',async()=>{
 const peaks=mixOverviewPeaks(project,buffers,20);assert.equal(peaks.length,20);assert.ok(peaks.every(x=>x===0));
});
await test('waveform follows mute, solo and mixer gain',async()=>{
 project.tracks[1].muted=true;const a=mixOverviewPeaks(project,buffers,20);assert.ok(a.some(x=>x>.1));
 project.tracks[0].gain_db=-6;const quiet=mixOverviewPeaks(project,buffers,20);a.forEach((x,i)=>assert.ok(Math.abs(quiet[i]-x*10**(-6/20))<1e-7));
 project.tracks[0].solo=false;project.tracks[1].solo=true;project.tracks[1].muted=false;const solo=mixOverviewPeaks(project,buffers,20);a.forEach((x,i)=>assert.ok(Math.abs(solo[i]-x)<1e-7));
});
console.log(JSON.stringify({status:'passed',tests:passed,scope:'Playback queue and decoded sample overview. Browser/audio device interaction is verified separately.'}));
