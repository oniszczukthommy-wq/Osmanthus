import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDirectorDraft,directorGenerationEnabled,generateDirectorTool,mountDirectorTools,directorPrompt} from '../public/director-tools.js';
import {DEFAULT_CANVAS_SETTINGS,normalizeCanvasSettings,normalizeCanvasShortcuts,matchCanvasShortcut,resolveCanvasSettingsAction,canvasSettingsActionAvailable,mountCanvasSettings} from '../public/canvas-settings-panel.js';

const projectId='50000000-0000-4000-8000-000000000001',requestId='50000000-0000-4000-8000-000000000002';
const reference={id:'image-a',url:'/files/materials/image-a.png',name:'本地原图'};
const imageMaterial={id:'sketch-png',kind:'image',url:'/files/materials/sketch-png.png',name:'真实草图.png'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('草图/道具/标注先导出并上传PNG，再调用生成；参数与草稿保持可审阅',async()=>{
 for(const tool of ['sketch','props','annotation']){const order=[],source=normalizeDirectorDraft({description:'保留构图，柔和光线',...(tool==='annotation'?{reference}:{}),strokes:[{tool:'pen',color:'#222222',width:8,points:[[.2,.3],[.5,.7]]}]},tool),snapshot=JSON.stringify(source);let payload;
  const result=await generateDirectorTool({tool,draft:source,requestId,projectId,exportPng:async()=>{order.push('png');return new Blob(['pixel-bytes'],{type:'image/png'});},callbacks:{uploadMaterials:async(files,options)=>{order.push('upload');assert.equal(files[0].type,'image/png');assert.equal(await files[0].text(),'pixel-bytes');assert.equal(options.purpose,'director-generation');return[imageMaterial];},onGenerate:async value=>{order.push('generate');payload=value;return{opened:true};}}});
  assert.deepEqual(order,['png','upload','generate']);assert.equal(payload.tool,tool);assert.equal(payload.parameters.project_id,projectId);assert.equal(payload.parameters.request_id,requestId);assert.equal(payload.material.url,imageMaterial.url);assert(payload.prompt.includes('保留构图'));assert.equal(JSON.stringify(source),snapshot);assert.equal(result.result.opened,true);
 }
});

test('上传中工程/会话失效会阻止生成；PNG缓存重试复用，不再次上传',async()=>{
 let live=true,submits=0,exports=0,uploads=0,cached;const guard=()=>{if(!live)throw Error('工程已切换');};
 await assert.rejects(()=>generateDirectorTool({tool:'props',draft:{},projectId,requestId,assertCurrent:guard,exportPng:async()=>new Blob(['png'],{type:'image/png'}),callbacks:{uploadMaterials:async()=>{live=false;return[imageMaterial];},onGenerate:async()=>{submits++;}}}),/工程已切换/);assert.equal(submits,0);
 const options={tool:'sketch',draft:{},projectId,requestId,exportPng:async()=>{exports++;return new Blob(['png'],{type:'image/png'});},onMaterial:material=>{cached=material;},callbacks:{uploadMaterials:async()=>{uploads++;return[imageMaterial];},onGenerate:async()=>{if(!submits++)throw Error('network interrupted');return true;}}};
 await assert.rejects(()=>generateDirectorTool(options),/network interrupted/);await generateDirectorTool({...options,cachedMaterial:cached});assert.equal(exports,1);assert.equal(uploads,1);assert.equal(submits,2);
});

test('运镜/无人机传参考和真实路径参数，不需要伪造PNG；字幕和3D按专用入口路由',async()=>{
 const values=[];for(const tool of ['camera','drone']){await assert.rejects(()=>generateDirectorTool({tool,draft:{},callbacks:{onGenerate:()=>{}},projectId,requestId}),/选择原图/);await generateDirectorTool({tool,draft:{reference,model:'wan2.6-i2v-flash',resolution:'720P',path:[[0,.5],[1,.7]],azimuth:45},projectId,requestId,callbacks:{onGenerate:payload=>{values.push(payload);}}});}
 assert.equal(values[0].reference.id,'image-a');assert.equal(values[0].parameters.azimuth,45);assert.equal(values[1].parameters.model,'wan2.6-i2v-flash');assert.deepEqual(values[1].parameters.path,[[0,.5],[1,.7]]);assert.equal(values[1].material,undefined);assert(values[1].prompt.includes('无人机'));
 const calls=[];for(const tool of ['captions','director','previs'])await generateDirectorTool({tool,draft:{},projectId,requestId,callbacks:{onOpenEditor:p=>calls.push(['editor',p.tool]),onOpenPrevis:p=>calls.push(['previs',p.tool])}});assert.deepEqual(calls,[['editor','captions'],['previs','director'],['previs','previs']]);
});

test('没有对应回调保持disabled；坏PNG和非法草稿不能进入真实生成',async()=>{
 assert.equal(directorGenerationEnabled('sketch',{onGenerate(){}}),false);assert.equal(directorGenerationEnabled('drone',{onGenerate(){}}),true);assert.equal(directorGenerationEnabled('captions',{onGenerate(){}}),false);assert.equal(directorGenerationEnabled('director',{onOpenPrevis(){}}),true);
 let calls=0;await assert.rejects(()=>generateDirectorTool({tool:'sketch',draft:{},callbacks:{uploadMaterials:()=>[],onGenerate:()=>calls++},exportPng:async()=>new Blob(['jpeg'],{type:'image/jpeg'})}),/有效PNG/);assert.equal(calls,0);
 assert.throws(()=>normalizeDirectorDraft({path:[[Infinity,0]]},'drone'));assert.throws(()=>normalizeDirectorDraft({resolution:'1080P'},'drone'));assert.throws(()=>normalizeDirectorDraft({reference:{...reference,name:'x'.repeat(241)}}));assert.throws(()=>normalizeDirectorDraft({},'unknown'));assert(directorPrompt('camera',normalizeDirectorDraft({},'camera')).includes('unchanged'));
});

test('快捷键规范化、冲突与浏览器保留键拒绝；匹配排除输入框、IME、已处理事件',()=>{
 const shortcuts=normalizeCanvasShortcuts({'add-image':'Shift+Mod+KeyI','zoom-100':'Digit1'});assert.equal(shortcuts['add-image'],'Mod+Shift+KeyI');assert.equal(matchCanvasShortcut({code:'KeyI',ctrlKey:true,shiftKey:true},{shortcuts}),'add-image');assert.equal(matchCanvasShortcut({code:'Digit1'},{shortcuts}),'zoom-100');
 for(const event of [{code:'KeyI',ctrlKey:true,shiftKey:true,isComposing:true},{code:'KeyI',ctrlKey:true,shiftKey:true,keyCode:229},{code:'KeyI',ctrlKey:true,shiftKey:true,defaultPrevented:true},{code:'KeyI',ctrlKey:true,shiftKey:true,target:{closest:()=>({})}},{code:'Digit1',target:{isContentEditable:true}}])assert.equal(matchCanvasShortcut(event,{shortcuts}),null);
 assert.throws(()=>normalizeCanvasShortcuts({'add-image':'Mod+KeyC'}),/默认操作/);assert.throws(()=>normalizeCanvasShortcuts({'add-image':'KeyI','add-video':'KeyI'}),/已用于/);assert.throws(()=>normalizeCanvasShortcuts({'add-image':'Mod+KeyW'}),/浏览器或系统/);assert.throws(()=>normalizeCanvasShortcuts({'unknown':'KeyI'}));
 assert.equal(matchCanvasShortcut({code:'KeyC',ctrlKey:true},{shortcuts}),null,'默认键留给现有画布处理器');assert.deepEqual(normalizeCanvasShortcuts({'add-image':null}),{'add-image':null});
});

test('默认分组颜色与快捷键有独立副本；操作白名单与颜色路由可验证',()=>{
 const a=normalizeCanvasSettings(),b=normalizeCanvasSettings();assert.equal(a.groupColor,'#ffffff');assert.deepEqual(a.shortcuts,{});a.shortcuts['add-image']='KeyI';assert.deepEqual(b.shortcuts,{});assert.deepEqual(DEFAULT_CANVAS_SETTINGS.shortcuts,{});
 const settings=normalizeCanvasSettings({groupColor:'#ABCDEF',grid:false,shortcuts:{'add-image':'KeyI'},extra:'preserved'});assert.equal(settings.groupColor,'#abcdef');assert.equal(settings.grid,false);assert.equal(settings.extra,'preserved');assert.equal(normalizeCanvasSettings({groupColor:'red'}).groupColor,'#ffffff');
 assert.deepEqual(resolveCanvasSettingsAction('group-color-pink'),{action:'group-color',payload:{color:'#ec4899'}});assert.equal(canvasSettingsActionAvailable('image-edit',{onAction(){},availableActions:[]}),false);assert.equal(canvasSettingsActionAvailable('group-color-pink',{onAction(){},availableActions:['group-color']}),true);assert.equal(canvasSettingsActionAvailable('unknown',{onAction(){},availableActions:['unknown']}),false);
});

class FakeElement{
 constructor(tag){this.tagName=tag;this.dataset={};this.listeners={};this.style={};this.open=false;this.scrollTop=0;this.values={};this.width=720;this.height=720;this.isConnected=true;this.disabled=false;this.classList={toggle(){}};}
 setAttribute(){}removeAttribute(){}append(value){(this.children??=[]).push(value);}remove(){this.removed=true;}focus(){}pause(){}getBoundingClientRect(){return{left:0,top:0,right:500,bottom:500,width:500,height:500};}scrollTo({top}){this.scrollTop=top;}
 getContext(){return new Proxy({},{get:(_target,key)=>key==='measureText'?()=>({width:10}):()=>{}});}toBlob(callback,type){this.exports=(this.exports||0)+1;callback(new Blob(['local-rendered-pixels'],{type}));}
 set innerHTML(value){this.html=value;this.values={};}get innerHTML(){return this.html||'';}
 querySelector(selector){if(selector==='[data-dt-canvas]'&&!this.html?.includes('data-dt-canvas'))return null;return this.values[selector]??(this.values[selector]=new FakeElement(selector));}querySelectorAll(){return[];}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}showModal(){this.open=true;}close(){this.open=false;for(const fn of this.listeners.close||[])fn({target:this});}
 async emit(type,target,extra={}){for(const fn of this.listeners[type]||[])fn({target,key:'',type,preventDefault(){},stopPropagation(){},...extra});await tick();await tick();}
}
class FakeImage{
 constructor(){this.complete=false;this.naturalWidth=0;this.listeners={};FakeImage.latest=this;}set src(value){this.url=value;}addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(item=>item!==fn);}load(){this.complete=true;this.naturalWidth=100;this.naturalHeight=100;this.onload?.();for(const fn of [...this.listeners.load||[]])fn();}
}
function environment(t){const old={document:globalThis.document,Image:globalThis.Image},body=new FakeElement('body'),head=new FakeElement('head');globalThis.document={body,head,activeElement:new FakeElement('focus'),createElement:tag=>new FakeElement(tag),querySelector:()=>null};globalThis.Image=FakeImage;t.after(()=>{globalThis.document=old.document;globalThis.Image=old.Image;});return{body};}
const button=dataset=>({dataset,disabled:false,closest:()=>buttonRef(dataset),focus(){}});const buttonRef=dataset=>({dataset,disabled:false,focus(){}});
const change=(attribute,value,dataset={})=>({dataset,value,matches:selector=>selector===attribute});
const project=()=>({id:projectId,start:0,duration:10,lyrics:[],studio:{canvas:{nodes:[]},canvasSettings:{}}});

test('设置实际捕获快捷键、保存回调与默认颜色更新，取消不会写入',async t=>{
 environment(t);let p=project();const saved=[],shortcuts=[],actions=[],applied=[],panel=mountCanvasSettings({read:()=>p,configure:patch=>{saved.push(patch);return true;},onShortcutsChange:(map,ctx)=>shortcuts.push([map,ctx]),onAction:(action,payload)=>actions.push([action,payload]),availableActions:['add-image','group-color'],onApply:settings=>applied.push(settings)}),dialog=panel.dialog;
 panel.open('editing');await dialog.emit('click',button({cspShortcut:'add-image'}));await dialog.emit('keydown',{}, {code:'KeyI',ctrlKey:true,shiftKey:true,key:'I'});assert.equal(panel.settings.shortcuts['add-image'],'Mod+Shift+KeyI');await dialog.emit('change',change('[data-csp-group-color]','#AABBCC'));assert.equal(panel.settings.groupColor,'#aabbcc');assert.equal(saved.length,0);
 await dialog.emit('click',button({cspAction:'save'}));assert.equal(saved.length,1);assert.equal(shortcuts[0][0]['add-image'],'Mod+Shift+KeyI');assert.equal(shortcuts[0][1].project_id,projectId);assert.deepEqual(actions,[['group-color',{color:'#aabbcc'}]]);assert.equal(applied.length,1);assert(!dialog.open);
 panel.open();await dialog.emit('click',button({cspShortcut:'add-image'}));await dialog.emit('keydown',{}, {code:'KeyJ',key:'j'});panel.close();assert.equal(saved.length,1);assert.equal(shortcuts.length,1);panel.destroy();
});

test('设置按钮只执行白名单动作，颜色预设统一传color；快捷键冲突保持录入状态',async t=>{
 environment(t);const p=project(),actions=[],notes=[],panel=mountCanvasSettings({read:()=>p,configure:()=>true,onAction:(...args)=>actions.push(args),availableActions:['group-color','add-image','add-video'],onShortcutsChange(){},toast:msg=>notes.push(msg)}),dialog=panel.dialog;
 panel.open('groups');await dialog.emit('click',button({cspInvoke:'image-depth'}));assert.equal(actions.length,0);await dialog.emit('click',button({cspInvoke:'group-color-blue'}));assert.deepEqual(actions,[['group-color',{color:'#3b82f6'}]]);assert(!dialog.open);
 panel.open();await dialog.emit('click',button({cspShortcut:'add-image'}));await dialog.emit('keydown',{}, {code:'KeyC',key:'c',ctrlKey:true});assert(notes.some(message=>message.includes('默认操作')));assert.equal(panel.settings.shortcuts['add-image'],undefined);await dialog.emit('keydown',{}, {code:'KeyI',key:'i'});assert.equal(panel.settings.shortcuts['add-image'],'KeyI');panel.destroy();
});

test('设置保存等待期间切换/取消会跳过旧onApply与快捷键、颜色副作用',async t=>{
 environment(t);let p=project(),resolveSave,applies=0,changes=0;const panel=mountCanvasSettings({read:()=>p,configure:()=>new Promise(resolve=>{resolveSave=resolve;}),onApply:()=>applies++,onShortcutsChange:()=>changes++,onAction:()=>changes++,availableActions:['add-image','group-color']}),dialog=panel.dialog;
 panel.open();await dialog.emit('click',button({cspShortcut:'add-image'}));await dialog.emit('keydown',{}, {code:'KeyI',key:'i'});await dialog.emit('click',button({cspAction:'save'}));p={...project(),id:'other-project'};resolveSave(true);await tick();assert.equal(applies,0);assert.equal(changes,0);panel.close();assert(!dialog.open);
 p=project();panel.open();await dialog.emit('click',button({cspAction:'save'}));panel.close();resolveSave(true);await tick();assert.equal(applies,0);panel.destroy();
});

test('导演真实PNG导出等待参考图加载，关闭后不上传；配置模型和分辨率回填',async t=>{
 environment(t);let p=project(),uploads=0,generated=0;const panel=mountDirectorTools({read:()=>p,configure:()=>true,uploadMaterials:async()=>{uploads++;return[imageMaterial];},onGenerate:()=>generated++,generationModels:[{id:'wan2.6-i2v-flash',name:'阿里万相 · Flash'}],resolutions:['720P']}),dialog=panel.dialog;
 panel.open({tool:'annotation',reference});await dialog.emit('click',button({dtAction:'generate'}));assert.equal(uploads,0,'图片未载入前不能导出空白背景');FakeImage.latest.load();await tick();await tick();assert.equal(uploads,1);assert.equal(generated,1);assert(!dialog.open);
 panel.open({tool:'annotation',reference:{...reference,url:'/files/materials/next.png'}});await dialog.emit('click',button({dtAction:'generate'}));const pending=FakeImage.latest;panel.close();pending.load();await tick();assert.equal(uploads,1);assert.equal(generated,1);
 panel.open('drone');assert.equal(panel.draft.model,'wan2.6-i2v-flash');assert.equal(panel.draft.resolution,'720P');assert(dialog.innerHTML.includes('阿里万相 · Flash'));assert(!dialog.innerHTML.includes('data-value="480P"'));panel.destroy();
});

test('旧资产选择器异步返回不能覆盖新工程/工具草稿',async t=>{
 environment(t);let p=project(),resolveAssets;const panel=mountDirectorTools({read:()=>p,configure:()=>true,openAssets:()=>new Promise(resolve=>{resolveAssets=resolve;})}),dialog=panel.dialog;panel.open('annotation');await dialog.emit('click',button({dtAction:'assets'}));p={...project(),id:'new-project'};panel.open('camera');resolveAssets({...imageMaterial});await tick();assert.equal(panel.draft.reference,null);assert.equal(panel.tool,'camera');panel.destroy();
});
