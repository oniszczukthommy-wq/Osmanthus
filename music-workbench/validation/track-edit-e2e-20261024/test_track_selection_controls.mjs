import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real editor render and selection handlers using synthetic tracks.
// Network, audio and persistent project storage are intentionally absent.
const source=await readFile(new URL('./app.js', import.meta.url), 'utf8');
const between=(start,end)=>{
  const a=source.indexOf(start), b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a, `missing editor function: ${start}`);
  return source.slice(a,b);
};
const functions=between('function enabledTrack(', 'function mixControls()')+
  between('function paintSwitches()', 'function updateMixHistory()')+
  between('function updateSelection()', 'function renderRuler()')+
  between('function render()', 'function originalKey(');

function node() {
  const classes=new Set(), attrs=new Map();
  return {dataset:{},style:{setProperty(){}},children:[],value:'',textContent:'',hidden:false,
    classList:{toggle(name,enabled){enabled?classes.add(name):classes.delete(name);},contains:name=>classes.has(name)},
    setAttribute(name,value){attrs.set(name,String(value));},getAttribute:name=>attrs.get(name)??null,
    replaceChildren(...children){this.children=children;},append(child){this.children.push(child);},
  };
}
function row() {
  const el=node(), parts={};
  Object.defineProperty(el,'innerHTML',{set(html){
    for(const name of ['track-name','track-label','track-selection-status','track-toggle','track-status','wave-wrap','selection','playhead'])
      assert.match(html,new RegExp(`class="${name}"`),`missing ${name} in track markup`);
  }});
  for (const name of ['.track-name','.track-label','.track-selection-status','.track-toggle','.track-status','.wave-wrap','.selection','.playhead','canvas']) parts[name]=node();
  Object.assign(parts['.wave-wrap'],{clientWidth:100,getBoundingClientRect:()=>({left:0}),setPointerCapture(){}});
  parts['.track-name'].querySelector=name=>parts[name]||null;
  parts['.track-toggle'].querySelector=name=>parts[name]||null;
  el.querySelector=name=>parts[name]||null;
  return el;
}
function fixture(){
  const ids=['song-title','separation-note','duration','seek','start','end','track-count','track-select','tracks','project-info','history','piano-cleanup-panel','piano-cleanup'];
  const nodes=Object.fromEntries(ids.map(id=>[id,node()]));
  nodes.start.value='5';nodes.end.value='10';
  const project={id:'synthetic',title:'Test',duration:100,sample_rate:44100,fingerprint:'unchanged',history:[],tracks:[
    {id:'vocals',label:'人声',muted:false,solo:false,color:'#fff',segments:[],peaks:[.5]},
    {id:'drums',label:'鼓组',muted:false,solo:false,color:'#fff',segments:[],peaks:[.5]},
  ]};
  const toggles=[], dispatched=[];
  const context={project,selected:'vocals',selection:[5,10],busy:false,position:0,playing:false,
    document:{createElement:type=>type==='div'?row():node(),querySelectorAll:selector=>selector==='.track'?nodes.tracks.children:[],
      querySelector:selector=>nodes.tracks.children.find(row=>selector===`.track[data-id="${row.dataset.id}"]`)||null},
    Option:function(label,value){this.label=label;this.value=value;},
    $:id=>nodes[id],clock:String,liveTime:()=>0,paintArrangementUI(){},renderRuler(){},setBusy(){},drawWave(){},attachSeekHandle(){},
    toggleTrack:id=>toggles.push(id),stop(){},
    Event:class {constructor(type){this.type=type;}},window:{dispatchEvent:event=>dispatched.push(event.type)},
  };
  vm.createContext(context);vm.runInContext(functions,context);vm.runInContext('render()',context);
  return {nodes,context,project,toggles,dispatched};
}

test('selecting a track changes the target without muting or modifying the project',()=>{
  const f=fixture(), before=JSON.stringify(f.project), second=f.nodes.tracks.children[1];
  f.dispatched.length=0;
  second.querySelector('.track-name').onclick();
  assert.equal(f.context.selected,'drums');
  assert.equal(f.nodes['track-select'].value,'drums');
  assert.equal(second.classList.contains('selected'),true);
  assert.equal(f.nodes.tracks.children[0].classList.contains('selected'),false);
  assert.equal(second.querySelector('.track-name').getAttribute('aria-pressed'),'true');
  assert.equal(second.querySelector('.track-selection-status').textContent,'正在编辑');
  assert.equal(f.nodes.tracks.children[0].querySelector('.track-selection-status').textContent,'选择编辑');
  assert.deepEqual(f.toggles,[]);
  assert.deepEqual(f.dispatched,['track-editor-selection-change']);
  assert.equal(JSON.stringify(f.project),before);
});

test('mute feedback updates the right sound button without changing the selected track',()=>{
  const f=fixture(), target=f.nodes.tracks.children[1], toggle=target.querySelector('.track-toggle');
  toggle.setAttribute('aria-pressed','true');
  f.project.tracks[1].muted=true;
  vm.runInContext('paintSwitches()',f.context);
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
  assert.equal(toggle.querySelector('.track-status').textContent,'已静音');
  assert.equal(target.classList.contains('is-disabled'),true);
  assert.equal(f.context.selected,'vocals');
});

test('the separate sound button controls its own track without changing the selection',()=>{
  const f=fixture(), before=JSON.stringify(f.project), second=f.nodes.tracks.children[1];
  second.querySelector('.track-toggle').onclick();
  assert.deepEqual(f.toggles,['drums']);
  assert.equal(f.context.selected,'vocals');
  assert.equal(JSON.stringify(f.project),before);
});

test('dragging a wave still selects the track and updates the time range',()=>{
  const f=fixture(), wrap=f.nodes.tracks.children[1].querySelector('.wave-wrap');
  const event=x=>({clientX:x,pointerId:1,target:{closest:()=>false}});
  wrap.onpointerdown(event(20));wrap.onpointermove(event(40));wrap.onpointerup(event(40));
  assert.equal(f.context.selected,'drums');
  assert.deepEqual(Array.from(f.context.selection),[20,40]);
  assert.deepEqual(f.toggles,[]);
});
