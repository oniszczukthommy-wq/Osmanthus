import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const viewContext={};
vm.runInNewContext(section('function candidatePresentation(','function renderBatches('),viewContext);
const view=(candidate,batch={stage:'generating'})=>viewContext.candidatePresentation(candidate,batch);

test('streaming version may be auditioned but cannot be selected before completion',()=>{
 const state=view({id:'A',stage:'generating',media:{stream:'/stream'},can_select:false});
 assert.equal(state.canPlay,true);assert.equal(state.canChoose,false);
 assert.match(state.hint,/试听/);assert.match(state.hint,/准备中/);assert.equal(state.selected,false);
});

test('finished version can be auditioned and explicitly chosen, or opened when already selected',()=>{
 const a={id:'A',stage:'awaiting_selection',media:{complete:'/complete'},can_select:true};
 const before=view(a,{stage:'awaiting_selection',selected_candidate_id:null});
 assert.equal(before.canPlay,true);assert.equal(before.canChoose,true);assert.equal(before.selected,false);
 assert.match(before.action,/选择/);assert.match(before.hint,/就绪/);
 const selected=view(a,{stage:'ready',selected_candidate_id:'A'});
 assert.equal(selected.selected,true);assert.equal(selected.action,'进入 Studio');
 assert.equal(view({...a,id:'B'},{stage:'ready',selected_candidate_id:'A'}).selected,false);
});

test('unavailable and paused versions do not claim to be complete',()=>{
 for(const stage of ['queued','paused','error']){
  const state=view({id:'B',stage,media:{},can_select:false});
  assert.equal(state.canPlay,false);assert.equal(state.canChoose,false);assert.equal(state.hint,'');
 }
 assert.equal(view({id:'A',stage:'awaiting_selection',media:{complete:'/a'},can_select:true},{stage:'preparing'}).canChoose,false);
});

test('playing a candidate switches the visible text without altering other play controls',()=>{
 const attrs=new Map([['aria-pressed','false']]);
 const button={innerHTML:'',getAttribute:key=>attrs.get(key),setAttribute:(key,value)=>attrs.set(key,value)};
 const row={dataset:{candidateCard:'A'},classList:{toggle(){}},querySelector:()=>button};
 const context={all:selector=>selector==='[data-song-row],[data-candidate-card]'?[row]:[],songMetadata:()=>({title:'歌'})};
 vm.runInNewContext(section('function applyPlaybackState(','async function playSong('),context);
 context.applyPlaybackState({id:'A',playing:true});
 assert.match(button.innerHTML,/<span>暂停<\/span>/);assert.equal(attrs.get('aria-pressed'),'true');
 context.applyPlaybackState({id:'A',playing:false});
 assert.match(button.innerHTML,/<span>试听<\/span>/);assert.equal(attrs.get('aria-pressed'),'false');
});

test('version card has separate existing listening and selection actions',()=>{
 const render=section('function renderBatches(','async function refresh(');
 assert.match(render,/data-song-play=/);assert.match(render,/data-project-open=/);
 assert.match(render,/disabled=!view\.canPlay/);assert.match(render,/choose\.disabled=!view\.canChoose/);
 assert.match(render,/currentIds\.has\(oldCard\.dataset\.candidateCard\)/);
});
