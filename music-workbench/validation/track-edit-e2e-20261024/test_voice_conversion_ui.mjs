import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('./svc.js',import.meta.url),'utf8')).replace('export function initializeConversions','function initializeConversions');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const requests=[],elements=new Map(),timers=[];let project={id:'one',revision:0,vocal_variant:'original'};
 const response=value=>({ok:true,json:async()=>value});
 function element(id){if(!elements.has(id))elements.set(id,{value:'',options:[],hidden:false,disabled:false,textContent:'',paused:true,attributes:{},
  pause(){this.paused=true;},play:async()=>{},load:()=>{},getAttribute(key){return this.attributes[key]||null;},removeAttribute(key){delete this.attributes[key];},closest:()=>({hidden:false}),replaceChildren(...values){this.options=values;}});return elements.get(id);}
 let handler=async()=>({job:null,candidates:[]});
 const context={window:{},document:{getElementById:element},AbortSignal:{timeout:()=>null},crypto:{randomUUID:()=> 'request'},performance:{now:()=>0},setInterval:fn=>{timers.push(fn);},Option:class Option{constructor(text,value){this.text=text;this.value=value;}},fetch:async(path,options)=>{requests.push({path,options});return response(await handler(path,options));}};
 vm.runInNewContext(source,context);context.initializeConversions({getProject:()=>project,transport:{pause:()=>{}},settle:async()=>true,apply:async()=>{},review:async()=>{}});
 return{context,requests,element,setProject:next=>{project=next;},setHandler:fn=>{handler=fn;},tick:()=>timers[0](),get state(){return context.window.voiceConversionState;}};
}
let passed=0;
async function test(name,fn){await fn();passed++;process.stdout.write('PASS '+name+'\n');}
await test('a conversion started for another song cannot replace the current song job or disable its create button',async()=>{
 const f=fixture();await turn();const pending=deferred();f.setHandler(async(path,options)=>options?.method==='POST'?pending.promise:{job:null,candidates:[]});
 const submitted=f.element('svc-create').onclick();await turn();f.setProject({id:'two',revision:0,vocal_variant:'original'});f.tick();await turn();assert.equal(f.state.projectId,'two');
 pending.resolve({id:'old-job',project_id:'one',stage:'converting'});await submitted;assert.equal(f.state.job,null);assert.equal(f.element('svc-create').disabled,false);
});
await test('a late candidate lookup error from the previous song does not overwrite the new song status',async()=>{
 const f=fixture();await turn();f.setHandler(async path=>path==='/api/svc/project/one'?{job:{id:'job-one',stage:'ready'},candidates:[{id:'voice-one',label:'voice',job_id:'job-one'}]}:{job:null,candidates:[]});await f.context.window.refreshVoiceConversion();
 const pending=deferred();f.setHandler(async path=>path==='/api/svc/jobs/job-one'?pending.promise:{job:null,candidates:[]});const lookup=f.element('svc-candidate').onchange({target:{value:'voice-one'}});
 f.setProject({id:'two',revision:0,vocal_variant:'original'});f.tick();await turn();pending.reject(Error('old lookup failed'));await lookup;assert.equal(f.state.error,'');assert.equal(f.state.job,null);
});
await test('a conversion that still belongs to the current song updates the active job normally',async()=>{
 const f=fixture();await turn();f.setHandler(async()=>({id:'current-job',project_id:'one',stage:'converting'}));await f.element('svc-create').onclick();assert.equal(f.state.job.id,'current-job');assert.equal(f.element('svc-create').disabled,true);
});
process.stdout.write(passed+' tests passed\n');
