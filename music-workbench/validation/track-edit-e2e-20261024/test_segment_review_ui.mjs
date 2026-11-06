import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('segment review recenters after loading and invalidates when the range changes',async()=>{
 const text=await readFile(new URL('./candidate_review.js',import.meta.url),'utf8');
 const nodes={};
 for(const name of ['status','scope','keep','range','a','b','actual','audio','matching','checks','warning','apply','refresh','cancel']){
  nodes[name]={hidden:false,disabled:false,textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]||null;},removeAttribute(k){delete this.attrs[k];},pause(){this.paused=true;},load(){},addEventListener(){},removeEventListener(){}};
 }
 const scrolls=[],panel={hidden:true,querySelector:s=>nodes[s.replace('#candidate-review-','')],scrollIntoView:opts=>scrolls.push(opts),remove(){}};
 const volume={value:'50',addEventListener(){},removeEventListener(){}},status={textContent:''},listeners={};
 const state={track_id:'drums',start_seconds:2,end_seconds:4};
 const project={id:'synthetic',revision:1,fingerprint:'fp',duration:10};
 const review={id:'synthetic-review',project_id:'synthetic',revision:1,fingerprint:'fp',kind:'segment',scope:'音量调整',label:'鼓组',
  range_seconds:[2,4],preview_range_seconds:[0,6],preserved_tracks:[],matching:{candidate_gain_db:0},checks:{seams:[]},warnings:[],can_apply:true,files:{}};
 const win={trackEditorState:{selection:state},addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){}};
 const ctx={document:{createElement:()=>panel,getElementById:id=>id==='segment-volume'?volume:id==='segment-preview-status'?status:null},window:win,
  setInterval:()=>0,clearInterval(){},AbortSignal,fetch:async()=>({ok:true,json:async()=>review}),console};
 vm.createContext(ctx);vm.runInContext(text.replaceAll('export function ','function '),ctx);
 let applied=0;
 const ui=ctx.initializeCandidateReview({getProject:()=>project,getSelection:()=>[2,4],transport:{pause(){}},settle:async()=>true,apply:async()=>{applied++;},container:{append(){}}});
 await ui.open({kind:'segment',segment:{track_id:'drums',start_seconds:2,end_seconds:4,mode:'gain',gain_db:-6},volume:50,range_seconds:[2,4]});
 assert.equal(scrolls.length,2);assert.ok(scrolls.every(s=>s.block==='center'));assert.equal(nodes.b.textContent,'调整后');
 assert.doesNotMatch(nodes.matching.textContent,/dB/i);assert.equal(nodes.actual.hidden,true);assert.equal(applied,0);
 state.end_seconds=5;listeners['track-editor-selection-change']();
 assert.equal(panel.hidden,true);assert.match(status.textContent,/重新准备试听/);assert.equal(applied,0);
 ui.destroy();
});
