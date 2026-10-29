import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {mountReferencePanels} from '../public/reference-panels.js';
import {mountCanvasSettings} from '../public/canvas-settings-panel.js';
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
