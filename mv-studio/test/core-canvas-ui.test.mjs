import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {mountReferencePanels} from '../public/reference-panels.js';
import {mountCanvasSettings} from '../public/canvas-settings-panel.js';
import {mountAIMVPanel} from '../public/ai-mv-panel.js';
const canvas=await readFile(new URL('../public/free-canvas-ui.js',import.meta.url),'utf8');
const studio=await readFile(new URL('../public/studio-ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Element{
 constructor(tag){this.tagName=tag;this.dataset={};this.listeners={};this.style={removeProperty(){}};this.classList={toggle(){},add(){},remove(){}};this.open=false;this.isConnected=true;this.children=[];this.html='';this.values={};}
 setAttribute(){}append(child){this.children.push(child);}focus(){}pause(){}remove(){}scrollTo(){}getBoundingClientRect(){return {left:0,top:0,right:600,bottom:600,width:600,height:600};}
 set innerHTML(value){this.html=value;}get innerHTML(){return this.html;}
 querySelector(selector){return this.values[selector]??(this.values[selector]=new Element(selector));}querySelectorAll(){return[];}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}showModal(){this.open=true;}close(){this.open=false;for(const fn of this.listeners.close||[])fn({target:this});}
 async emit(type,target){for(const fn of this.listeners[type]||[])await fn({target});await tick();}
}
function env(t){const old=globalThis.document;globalThis.document={body:new Element('body'),head:new Element('head'),createElement:tag=>new Element(tag),querySelector:()=>null,activeElement:new Element('focus')};t.after(()=>globalThis.document=old);}
const button=dataset=>({dataset,disabled:false,closest(){return this;}});
function canvasEntryFixture(input={}){
 const controls=[button({studioAction:'empty-canvas'}),button({studioAction:'create'}),button({view:'canvas'})];
 for(const control of controls){control.setAttribute=()=>{};control.removeAttribute=()=>{};control.classList={contains:()=>false};}
 const nodes=new Map(),element=id=>{if(!nodes.has(id))nodes.set(id,{value:'MV 想法',hidden:id!=='home-view',attributes:{},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];}});return nodes.get(id);};
 const state={project:{id:'music-project',source:{id:'song.mp3',duration:30},musicHandoff:{source_kind:'current_mix'},studio:{ratio:'9:16'},...input},activations:[],engineOrigins:[],projectLists:0,notes:[],onActivate:null,listener:null};
 const context={canvasOpening:null,view:'home',type:'story',prompt:'',closeMini(){},renderDownloads(){},
  bridge:{read:()=>state.project,busy:()=>false,pause(){},toast:message=>state.notes.push(message),configure:patch=>Object.assign(state.project.studio,patch)},
  free:{visible(){},async activate(options){state.activations.push(options);if(state.onActivate)await state.onActivate(options);else if(options.blank)state.project={id:'new-canvas',source:{id:'sample'},studio:{canvas:{nodes:[]},freeCanvas:true,ratio:'16:9'}};},openEngine(){state.engineOrigins.push(state.project.id);},async openProjects(){state.projectLists++;}},
  sync(){controls[1].disabled=!!context.canvasOpening||context.bridge.busy();},$:element,
  document:{body:{dataset:{}},querySelectorAll:selector=>selector==='[data-view]'?[controls[2]]:controls,addEventListener(type,listener){if(type==='click')state.listener=listener;}},
  window:{scrollTo(){},history:{replaceState(){}}},location:{pathname:'/mv/',search:'',hash:''}};
 vm.createContext(context);
 const begin=studio.indexOf(' function setView('),end=studio.indexOf(' async function uploadFile(',begin);
 const action=studio.slice(studio.indexOf(' async function action('),studio.indexOf(" document.addEventListener('click'"));
 vm.runInContext(studio.slice(begin,end)+action,context);
 return{state,context,controls,element,run:code=>vm.runInContext(code,context)};
}

test('selecting an image keeps generation/crop/download tools without an empty presets menu',()=>{
 const bar=new Element('toolbar'),node={type:'image',asset:{url:'/files/test.png'}};
 const context={getSelected:()=>[node],selection:new Set(['image']),$:()=>bar,placeMediaToolbar(){},esc:String,icon:()=>''};
 const actions=canvas.slice(canvas.indexOf('const REMOVED_ACTIONS='),canvas.indexOf('const editable='));
 const render=canvas.slice(canvas.indexOf(' function renderMediaToolbar('),canvas.indexOf(' function renderRefs('));
 vm.runInNewContext(actions+render+';renderMediaToolbar();',context);
 assert(!bar.hidden);assert.match(bar.innerHTML,/data-fc-action="image-to-video"/);assert.match(bar.innerHTML,/data-fc-action="crop-image"/);assert.match(bar.innerHTML,/data-fc-action="download-node"/);assert.doesNotMatch(bar.innerHTML,/data-fc-action="(?:image-presets|annotation|remove-object)"/);
});

test('core settings omit removed aliases while retaining crop, image-to-video dependencies and editing',t=>{
 env(t);let options;
 const start=canvas.indexOf(' const settingsActions='),end=canvas.indexOf(' const appliedGenerations=',start),context={read:()=>({id:'test',studio:{}}),bridge:{configure(){}},toast(){},render(){},action(){},mountCanvasSettings:value=>{options=value;}};
 const actions=canvas.slice(canvas.indexOf('const REMOVED_ACTIONS='),canvas.indexOf('const editable='));
 vm.runInNewContext(actions+canvas.slice(start,end),context);
 assert(!options.availableActions.includes('image-edit'));assert(!options.availableActions.includes('image-character-views'));assert(options.availableActions.includes('crop-image'));assert(options.availableActions.includes('video-crop'));assert(options.availableActions.includes('image-reverse-prompt'));
 const panel=mountCanvasSettings(options);panel.open('images');assert.doesNotMatch(panel.dialog.innerHTML,/data-csp-invoke="(?:image-edit|image-character-views|draw|camera)"/);assert.match(panel.dialog.innerHTML,/data-csp-invoke="crop-image"/);panel.destroy();
});

test('reference image picker filters incompatible media even when loader ignores requested type',async t=>{
 env(t);const calls=[],selected=[];
 const panel=mountReferencePanels({read:()=>({id:'test',studio:{}}),listMaterials:async context=>{calls.push(context);return[{id:'img',kind:'image',name:'my-image',url:'/files/i.png'},{id:'video',kind:'video',name:'wrong-video',url:'/files/v.mp4'}];},onSelectAssets:items=>selected.push(items)});
 panel.openAssets({type:'image'});await tick();assert.equal(calls[0].type,'image');assert.match(panel.dialog.innerHTML,/my-image/);assert.doesNotMatch(panel.dialog.innerHTML,/wrong-video/);assert.doesNotMatch(panel.dialog.innerHTML,/data-rp-media="video"/);
 await panel.dialog.emit('click',button({rpToggleAsset:'img'}));await panel.dialog.emit('click',button({rpAction:'confirm-assets'}));assert.equal(selected.length,1);assert.equal(selected[0][0].type,'image');panel.destroy();
});

test('failed reference selection preserves target for correction instead of losing its connection',async()=>{
 const fn=canvas.slice(canvas.indexOf('onSelectAssets:')+'onSelectAssets:'.length,canvas.indexOf(',onStyle:',canvas.indexOf('onSelectAssets:')));
 const context={referenceTarget:'target',doc:{nodes:[{id:'target'}]},selection:null,renderSelection(){},addMaterials:async()=>['image'],connectNodes:(doc,source,target)=>({...doc,edge:{source,target}}),commit:next=>context.doc=next};
 vm.runInNewContext('globalThis.choose='+fn,context);
 await assert.rejects(()=>context.choose([{type:'video'}]),/图片/);assert.equal(context.referenceTarget,'target');
 await context.choose([{type:'image'}]);assert.equal(context.doc.edge.target,'target');assert.equal(context.referenceTarget,null);
});

test('music file picker reports upload failures and allows choosing the same file again',async()=>{
 const marker="$('quick-upload').onchange=",start=studio.indexOf(marker)+marker.length,end=studio.indexOf(';\n',start),handler=studio.slice(start,end);
 const notes=[],context={uploadFile:async()=>{throw Error('busy');},bridge:{toast:message=>notes.push(message)}};
 vm.runInNewContext('globalThis.handle='+handler,context);
 const input={files:[{name:'a.mp3'}],value:'a.mp3'};await context.handle({target:input});assert.deepEqual(notes,['busy']);assert.equal(input.value,'');
});

test('home listen button reflects real audio state and resets after pause or completion',()=>{
 const fn=studio.slice(studio.indexOf(' function syncPlayback('),studio.indexOf(' function playMini('));
 let playing=false;const attributes={},button={setAttribute:(key,value)=>attributes[key]=value};
 const context={bridge:{playing:()=>playing},document:{querySelector:()=>button},icon:name=>name};
 vm.runInNewContext(fn+';syncPlayback();',context);assert.equal(attributes['aria-pressed'],'false');assert.equal(button.innerHTML,'play');assert.equal(attributes['aria-label'],'试听音乐');
 playing=true;vm.runInNewContext('syncPlayback()',context);assert.equal(attributes['aria-pressed'],'true');assert.equal(button.innerHTML,'pause');assert.equal(attributes['aria-label'],'暂停音乐');
 playing=false;vm.runInNewContext('syncPlayback()',context);assert.equal(attributes['aria-pressed'],'false');assert.equal(button.title,'试听音乐');
});

test('audio and movie lifecycle events notify the home play-state UI without reloading source media',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const marker="for(const media of [audio,movie])for(const event of ['play','pause','ended','emptied'])",start=app.indexOf(marker),end=app.indexOf('\n',start);
 const handlers=[],audio={addEventListener:(event,fn)=>handlers.push({event,fn,media:'audio'})},movie={addEventListener:(event,fn)=>handlers.push({event,fn,media:'movie'})};let changes=0;
 const scope={audio,movie,studio:null};vm.runInNewContext(app.slice(start,end),scope);
 assert.equal(handlers.length,8);for(const handler of handlers)assert.doesNotThrow(()=>handler.fn());assert.equal(changes,0,'startup media events are safe before the studio mounts');
 scope.studio={syncPlayback:()=>changes++};for(const handler of handlers)handler.fn();assert.equal(changes,8);assert.deepEqual([...new Set(handlers.map(h=>h.event))],['play','pause','ended','emptied']);
});

test('AI MV source labels distinguish mixes, original audio and uploads, including valid copied snapshots',async t=>{
 env(t);
 const hash='a'.repeat(64),snapshotId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.mp3';
 const cases=[
  {source:{id:'mix.mp3',duration:30},musicHandoff:{source_kind:'current_mix'},label:'当前歌曲混音'},
  {source:{id:'original.mp3',duration:30},musicHandoff:{source_kind:'generated_original'},label:'原歌曲音频'},
  {source:{id:'upload.mp3',duration:30},label:'上传配乐'},
  {source:{id:'unknown.mp3',duration:30},musicHandoff:{source_kind:'unknown'},label:'上传配乐'},
  {source:{id:snapshotId,duration:30},studio:{originMusicSnapshot:{source_kind:'current_mix',audio_sha256:hash}},label:'当前歌曲混音'},
  {source:{id:'replacement.mp3',duration:30},studio:{originMusicSnapshot:{source_kind:'current_mix',audio_sha256:hash}},label:'上传配乐'},
 ];
 for(const input of cases){
  const p={id:'test',title:'示例歌曲',start:0,...input};
  const panel=mountAIMVPanel({bridge:{read:()=>p,capabilities:()=>({}),aiMVJobs:async()=>[]}});
  await panel.open();const dialog=document.body.children.at(-1);
  assert.equal(dialog.innerHTML.match(/<p class="aimv-source">(.*?)<\/p>/)[1],'示例歌曲 · '+input.label);
  assert.match(dialog.innerHTML,/保留当前配乐作为音轨/);assert.match(dialog.innerHTML,/再与当前配乐合成/);
  panel.destroy();
 }
});

test('entering the canvas preserves the current song, handoff and selected 9:16 ratio',async()=>{
 const f=canvasEntryFixture(),original=f.state.project;
 await f.run("action('empty-canvas')");
 assert.equal(f.state.project,original);assert.equal(f.state.project.id,'music-project');
 assert.equal(f.state.project.musicHandoff.source_kind,'current_mix');assert.equal(f.state.project.studio.ratio,'9:16');
 assert.equal(f.state.activations[0].blank,false);assert.equal(f.context.view,'canvas');
});

test('enter reuses an existing music-free canvas and creates blank only for a fresh sample project',async()=>{
 const saved=canvasEntryFixture({source:{id:'sample'},studio:{canvas:{nodes:[]},freeCanvas:true,ratio:'9:16'}});
 await saved.run("action('empty-canvas')");assert.equal(saved.state.project.id,'music-project');assert.equal(saved.state.activations[0].blank,false);assert.equal(saved.state.project.studio.ratio,'9:16');
 const fresh=canvasEntryFixture({source:{id:'sample'},musicHandoff:null,studio:{ratio:'16:9'}});
 await fresh.run("action('empty-canvas')");assert.equal(fresh.state.activations[0].blank,true);assert.equal(fresh.state.project.id,'new-canvas');
});

test('canvas activation keeps old controls inert and starts storyboard only after the new origin is ready',async()=>{
 const f=canvasEntryFixture();let finish;const waiting=new Promise(resolve=>finish=resolve);
 f.state.onActivate=async()=>{f.context.setView('canvas');await waiting;f.state.project={...f.state.project,id:'activated-origin'};};
 const creating=f.run("action('create')");await tick();
 assert.equal(f.context.view,'home');assert.equal(f.element('canvas-view').inert,true);assert.equal(f.element('canvas-view').attributes['aria-busy'],'true');
 assert.ok(f.controls.every(b=>b.disabled));assert.deepEqual(f.state.engineOrigins,[]);
 finish();await creating;assert.equal(f.context.view,'canvas');assert.equal(f.element('canvas-view').inert,false);assert.deepEqual(f.state.engineOrigins,['activated-origin']);
});

test('rapid repeated enter requests share one activation and both resolve after completion',async()=>{
 const f=canvasEntryFixture();let finish;f.state.onActivate=()=>new Promise(resolve=>finish=resolve);
 const a=f.run('openCanvas(true)'),b=f.run('openCanvas(true)');await tick();assert.equal(f.state.activations.length,1);assert.equal(f.context.view,'home');
 finish();assert.equal(await a,true);assert.equal(await b,true);assert.ok(f.controls.every(b=>!b.disabled));
});

test('failed or busy activation cannot open storyboard and failure unlocks a safe retry',async()=>{
 const f=canvasEntryFixture();f.state.onActivate=async()=>{throw Error('activation failed');};
 await assert.rejects(f.run("action('create')"),/activation failed/);assert.equal(f.context.view,'home');assert.equal(f.element('canvas-view').inert,false);assert.ok(f.controls.every(b=>!b.disabled));assert.deepEqual(f.state.engineOrigins,[]);
 f.state.onActivate=null;await f.run("action('create')");assert.deepEqual(f.state.engineOrigins,['music-project']);
 const busy=canvasEntryFixture();busy.context.bridge.busy=()=>true;await busy.run("action('create')");assert.equal(busy.state.activations.length,0);assert.deepEqual(busy.state.engineOrigins,[]);
});

test('canvas navigation waits for activation before showing the project picker',async()=>{
 const f=canvasEntryFixture();let finish;f.state.onActivate=()=>new Promise(resolve=>finish=resolve);
 const start=studio.indexOf(" document.addEventListener('click'"),end=studio.indexOf(" $('creative-prompt').addEventListener",start);
 f.run(studio.slice(start,end));const navigating=f.state.listener({target:f.controls[2]});await tick();
 assert.equal(f.context.view,'home');assert.equal(f.state.projectLists,0);
 finish();await navigating;assert.equal(f.context.view,'canvas');assert.equal(f.state.projectLists,1);
});

test('a direct canvas URL waits for activation instead of exposing the previous project',async()=>{
 const f=canvasEntryFixture();let finish;f.state.onActivate=()=>new Promise(resolve=>finish=resolve);f.context.location.hash='#canvas';
 f.run(studio.slice(studio.indexOf(' const requested='),studio.indexOf(' window.MV_STUDIO=')));await tick();
 assert.equal(f.context.view,'home');assert.equal(f.element('canvas-view').inert,true);
 finish();await tick();assert.equal(f.context.view,'canvas');assert.equal(f.element('canvas-view').inert,false);
});
