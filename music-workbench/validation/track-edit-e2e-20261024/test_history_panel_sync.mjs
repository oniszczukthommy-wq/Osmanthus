import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real shell renderers without starting a server or loading audio.
const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const renderers=between('const esc=','const clock=')+
 between('function renderHistory(','const wrap=')+
 between('function dialog(name)','$(\'studio-dialog-close\')');

function node(){let html='',writes=0;return{
 get innerHTML(){return html;},set innerHTML(value){html=value;writes++;},
 get writes(){return writes;},style:{},hidden:false,
};}
function project(id='qa-song',count=13){return{id,revision:15,fingerprint:'unchanged-audio',duration:180,tracks:[],
 history:Array.from({length:count},(_,i)=>({id:'edit-'+i,label:'修改 '+(i+1),applied:true}))};}
function fixture(p=project(),{sidebar=true}={}){
 const nodes={'studio-history-restore':node(),'studio-target':node(),'studio-sections':node(),
  'studio-dialog-title':node(),'studio-dialog-status':node(),'studio-dialog':{open:false,showModal(){this.open=true;}}};
 if(sidebar)nodes['studio-sidebar-history']=node();
 const sections=['history','score'].map(name=>({dataset:{studioContent:name},hidden:true}));
 const state={project:p,drawCalls:0,drawError:null},overlay=node();
 const context={lastHistory:'',lastProject:'',lastSelection:'',lastSections:'',lastLibrary:'',
  engine:{getProject:()=>state.project,drawWave(){state.drawCalls++;if(state.drawError)throw state.drawError;}},
  window:{trackEditorState:{selection:{track_id:null,start_seconds:0,end_seconds:15}},trackEditorBuffers:{original:null}},
  $:id=>nodes[id],q:()=>overlay,all:()=>sections,validSections:()=>null,clock:String};
 vm.createContext(context);vm.runInContext(renderers,context);
 return{nodes,context,state,sections,run:code=>vm.runInContext(code,context)};
}
function buttons(f){return[...f.nodes['studio-history-restore'].innerHTML.matchAll(/<button data-history-cursor="(\d+)"([^>]*)>(.*?)<\/button>/g)]
 .map(([,cursor,attrs,label])=>({cursor:Number(cursor),disabled:attrs.includes('disabled'),label}));}

test('all thirteen modifications remain restorable when the legacy sidebar is absent',()=>{
 const f=fixture(project(),{sidebar:false});f.run('renderEditor()');
 assert.equal(buttons(f).length,14);assert.equal(buttons(f).find(b=>b.disabled).cursor,13);
 assert.equal(buttons(f)[0].label,'初始混音');
});

test('history refreshes despite an unchanged waveform revision and fingerprint',()=>{
 const f=fixture(project('qa-song',0));f.run('renderEditor()');
 f.state.project.history.push({id:'new-edit',label:'30–45秒 贝斯静音',applied:true});
 f.run('renderEditor()');assert.equal(buttons(f).length,2);
 assert.equal(buttons(f)[1].label,'当前 · 30–45秒 贝斯静音');
});

test('undo and redo update the selected state without changing history length',()=>{
 const f=fixture();f.run('renderEditor()');
 f.state.project.history.forEach(h=>h.applied=false);f.run('renderEditor()');
 assert.equal(buttons(f).length,14);assert.equal(buttons(f).find(b=>b.disabled).cursor,0);
 f.state.project.history.forEach(h=>h.applied=true);f.run('renderEditor()');
 assert.equal(buttons(f).find(b=>b.disabled).cursor,13);
});

test('a replacement history entry or label refreshes even with the same project version',()=>{
 const f=fixture(project('qa-song',1));f.run('renderEditor()');const mount=f.nodes['studio-history-restore'];
 const before=mount.writes;f.state.project.history[0].id='replacement';f.run('renderEditor()');assert.equal(mount.writes,before+1);
 f.state.project.history[0].label='新名称 <button> & "';f.run('renderEditor()');
 assert.equal(buttons(f)[1].label,'当前 · 新名称 &lt;button&gt; &amp; &quot;');
});

test('switching to another project refreshes identical-looking history',()=>{
 const f=fixture(project('first',1));f.run('renderEditor()');const before=f.nodes['studio-history-restore'].writes;
 f.state.project=project('second',1);f.run('renderEditor()');assert.equal(f.nodes['studio-history-restore'].writes,before+1);
});

test('opening history repairs stale panel markup immediately without drawing audio',()=>{
 const f=fixture();f.run('renderEditor()');
 f.nodes['studio-history-restore'].innerHTML='<h3>恢复修改状态</h3><button>初始混音</button>';
 f.context.window.trackEditorBuffers.original={getChannelData(){throw Error('audio unavailable');}};
 f.run("dialog('history')");assert.equal(buttons(f).length,14);assert.equal(f.state.drawCalls,0);
 assert.equal(f.nodes['studio-dialog'].open,true);assert.equal(f.sections[0].hidden,false);assert.equal(f.sections[1].hidden,true);
});

test('waveform failures cannot block history or leave later history changes stale',()=>{
 const f=fixture(project('qa-song',1));f.state.drawError=Error('canvas unavailable');
 f.context.window.trackEditorBuffers.original={getChannelData:()=>new Float32Array(500)};
 assert.throws(()=>f.run('renderEditor()'),/canvas unavailable/);assert.equal(buttons(f).length,2);
 f.state.project.history.push({id:'second',label:'恢复贝斯',applied:true});
 f.run('renderEditor()');assert.equal(buttons(f).length,3);assert.equal(buttons(f)[2].label,'当前 · 恢复贝斯');
});

test('history can render before selection/audio is ready and stable polls do not rewrite it',()=>{
 const f=fixture();f.context.window.trackEditorState=null;f.run('renderEditor()');
 assert.equal(buttons(f).length,14);const before=f.nodes['studio-history-restore'].writes;
 f.run('renderEditor()');assert.equal(f.nodes['studio-history-restore'].writes,before);
 f.state.project=null;f.run("dialog('history')");assert.equal(f.nodes['studio-dialog'].open,true);
});
