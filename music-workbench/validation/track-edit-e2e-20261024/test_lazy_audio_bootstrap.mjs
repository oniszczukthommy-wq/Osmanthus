import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function originalKey('),source.indexOf('async function mutate('));
const bootstrap=source.slice(source.indexOf('async function loadInitialProject('),source.indexOf('await loadInitialProject();'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(r=>setImmediate(r));
const project=(id='one',revision=0)=>({id,revision,fingerprint:id+'-mix-'+revision,original_audio_url:'/audio/'+id+'/original.wav',duration:120,tracks:[{id:'vocals',audio_key:id+'-v',audio_url:'/audio/'+id+'/vocals.wav'},{id:'bass',audio_key:id+'-b',audio_url:'/audio/'+id+'/bass.wav'}]});
function fixture({integrated=true,decode=null}={}){
 const pending=new Map(),calls=[],messages=[],events=[],elements=new Map();
 const context={project:project(),original:null,buffers:new Map(),originalProjectKey:null,audioPreparation:null,audioAcceptSerial:0,busy:false,
  window:{osmanthusIntegrated:integrated,pauseGenerationPreview:()=>{}},selected:'bass',mode:'mix',arrangementJob:null,arrangementProject:null,arrangementError:'',candidateId:null,lastExport:null,
  $:id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',replaceChildren:()=>{}});return elements.get(id);},
  api:async()=>context.project,setBusy:value=>{context.busy=value;},notice:(text,error)=>messages.push({text,error}),event:(type,extra)=>events.push({type,...extra}),stop:()=>{},render:()=>{},
  decode:url=>{calls.push(url);if(decode)return decode(url);const task=deferred();pending.set(url,task);return task.promise;}};
 vm.runInNewContext(functions+'\n'+bootstrap,context);
 return{context,pending,calls,messages,events,finish(id='one'){for(const [url,task] of pending)if(url.includes('/'+id+'/'))task.resolve({source:url});}};
}
let passed=0;
async function test(name,fn){await fn();passed++;process.stdout.write('PASS '+name+'\n');}

await test('integrated bootstrap publishes metadata without fetching or decoding any WAV',async()=>{
 const f=fixture();await f.context.loadInitialProject();assert.equal(f.calls.length,0);assert.equal(f.context.original,null);assert.equal(f.context.buffers.size,0);assert.equal(f.context.hasProjectAudio(),false);assert.equal(f.context.busy,false);assert.ok(f.events.some(e=>e.type==='metadata-ready'));
});
await test('legacy non-integrated bootstrap still waits for complete original and tracks',async()=>{
 const f=fixture({integrated:false}),loading=f.context.loadInitialProject();await turn();assert.equal(f.calls.length,3);assert.equal(f.context.hasProjectAudio(),false);f.finish();await loading;assert.equal(f.context.hasProjectAudio(),true);assert.ok(f.events.some(e=>e.type==='ready'));
});
await test('concurrent preparation shares one load and never publishes a partial mix',async()=>{
 const f=fixture(),a=f.context.prepareAudio(),b=f.context.prepareAudio();assert.equal(f.calls.length,3);assert.equal(f.context.busy,true);
 f.pending.get('/audio/one/vocals.wav').resolve({source:'vocal'});await turn();assert.equal(f.context.buffers.size,0);assert.equal(f.context.original,null);assert.equal(f.context.hasProjectAudio(),false);
 f.finish();await Promise.all([a,b]);assert.equal(f.context.hasProjectAudio(),true);assert.equal(f.context.busy,false);assert.equal(f.context.buffers.get('bass').key,'one-b');await f.context.prepareAudio();assert.equal(f.calls.length,3);
});
await test('failed decoding publishes nothing, unlocks controls and can be explicitly retried',async()=>{
 const f=fixture(),loading=f.context.prepareAudio();f.pending.get('/audio/one/bass.wav').reject(Error('decode failed'));await assert.rejects(loading,/decode failed/);assert.equal(f.context.original,null);assert.equal(f.context.buffers.size,0);assert.equal(f.context.busy,false);assert.equal(f.context.audioPreparation,null);assert.ok(f.messages.some(e=>e.error));
 f.finish();await turn();assert.equal(f.context.hasProjectAudio(),false);
 const retry=f.context.prepareAudio();f.finish();await retry;assert.equal(f.context.hasProjectAudio(),true);assert.equal(f.calls.length,6);
});
await test('late older project load cannot overwrite a newer accepted project or its buffers',async()=>{
 const f=fixture(),first=f.context.accept(project('one')),firstResult=first.then(()=>null,e=>e),second=f.context.accept(project('two'));
 f.finish('two');await second;assert.equal(f.context.project.id,'two');assert.equal(f.context.hasProjectAudio(),true);
 f.finish('one');assert.match((await firstResult).message,/新的工程/);assert.equal(f.context.project.id,'two');assert.equal(f.context.buffers.get('vocals').key,'two-v');assert.equal(f.context.original.source,'/audio/two/original.wav');
});
await test('a failed new project load preserves the previously complete mix atomically',async()=>{
 const f=fixture(),initial=f.context.prepareAudio();f.finish();await initial;const original=f.context.original;
 const loading=f.context.accept(project('two'));f.pending.get('/audio/two/bass.wav').reject(Error('bad new stem'));await assert.rejects(loading,/bad new stem/);f.finish('two');await turn();assert.equal(f.context.project.id,'one');assert.equal(f.context.original,original);assert.equal(f.context.buffers.get('vocals').key,'one-v');assert.equal(f.context.hasProjectAudio(),true);
});
await test('manual edits do not POST until the complete matching audio snapshot is prepared',async()=>{
 const f=fixture(),requests=[];Object.assign(f.context,{playing:false,playUntil:120,nodes:[],settleTrackSwitches:async()=>true,liveTime:()=>0,performance:{now:()=>1},api:async(path,body)=>{requests.push({path,body});return{project:project('one',1),applied:true};}});
 const mutate=source.slice(source.indexOf('async function mutate('),source.indexOf('function segment('));vm.runInNewContext(mutate,f.context);
 const result=f.context.mutate('/api/edit',{command:{type:'segment_gain'}},'saved');assert.equal(requests.length,0);assert.equal(f.context.hasProjectAudio(),false);f.finish();await result;
 assert.equal(requests.length,1);assert.equal(requests[0].body.project_id,'one');assert.equal(f.context.project.revision,1);assert.equal(f.context.hasProjectAudio(),true);
});
const studio=await readFile(new URL('./studio.js',import.meta.url),'utf8');
await test('export, score and mix sharing prepare exact audio for both same and changed project IDs',async()=>{
 const fn=studio.slice(studio.indexOf('async function prepareProject('),studio.indexOf('function dialog('));
 for(const target of ['one','two']){
  const calls=[],state={id:'one',loaded:false},context={engine:{getProject:()=>state,settle:async()=>{calls.push('settle');return true;},activate:async id=>{calls.push('activate:'+id);state.id=id;},prepareAudio:async()=>{calls.push('prepare:'+state.id);state.loaded=true;}}};
  vm.runInNewContext(fn,context);const result=await context.prepareProject(target);assert.equal(result.id,target);assert.equal(result.loaded,true);assert.deepEqual(calls,target==='one'?['settle','prepare:one']:['settle','activate:two','prepare:two']);
 }
});
await test('same-project Studio navigation waits for audio and remains on the current page if loading fails',async()=>{
 const fn=studio.slice(studio.indexOf('async function activateEditor('),studio.indexOf('async function openProject('));
 for(const fail of [false,true]){
  const wait=deferred(),navigations=[],loading=[],context={editorLoadingToken:0,editorLoading:(show)=>loading.push(show),navigation:1,player:null,window:{pauseGenerationPreview:()=>{},dispatchEvent:()=>{}},engine:{getProject:()=>({id:'one'}),settle:async()=>true,prepareAudio:()=>wait.promise},navigate:page=>navigations.push(page),renderEditor:()=>{},Event:function Event(){}};
  vm.runInNewContext(fn,context);const result=context.activateEditor('one');await turn();assert.equal(navigations.length,0);assert.deepEqual(loading,[true]);
  if(fail){wait.reject(Error('audio download failed'));await assert.rejects(result,/download failed/);assert.equal(navigations.length,0);}else{wait.resolve();await result;assert.deepEqual(navigations,['editor']);}assert.deepEqual(loading,[true,false]);
 }
});
process.stdout.write(passed+' tests passed\n');
