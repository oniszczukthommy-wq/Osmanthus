import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {makeProject,validateProject} from '../public/domain.js';

// Exercise the actual autosave/backup functions with a minimal DOM and mocked
// transport. This does not load a browser, user data, or any model endpoint.
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const saveFunctions=app.slice(app.indexOf('function rememberUnsaved()'),app.indexOf('function pause()'));
function fixture(post){
 const elements=new Map(),storage=new Map(),project=makeProject();project.id=crypto.randomUUID();project.canvasRevision=1;
 const element=()=>({hidden:false,style:{},setAttribute(){},click(){},classList:{add(){},remove(){}}});
 const context=vm.createContext({project,dirty:true,saveRevision:1,saveConflict:null,saving:null,savingTask:null,switching:false,
  knownProjectRevisions:new Map(),crypto,Blob,URL,JSON,Error,TextEncoder,UUID:/^[a-f0-9-]{36}$/,
  $:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},
  document:{createElement:element,body:{append(){}}},esc:value=>String(value),clone:structuredClone,
  sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},
  backupKey:id=>'osmanthus:canvas-unsaved:'+id,post,validateClientProject:validateProject,
  setTimeout:()=>1,clearTimeout(){},toast(){},render(){},requireIdle(){},projectPath:id=>'/api/canvas-projects/'+id+'/open',
 });
 context.acceptProject=result=>{context.project=structuredClone(result.project);context.dirty=false;context.saveConflict=null;};
 vm.runInContext(saveFunctions,context);
 return {context,storage,elements};
}

test('409保留本页编辑并停止重复自动保存，另存副本使用本地内容',async()=>{
 const requests=[];let conflict=true;
 const {context:c,storage}=fixture(async(url,payload)=>{
  requests.push({url,payload:structuredClone(payload)});
  if(conflict)throw Object.assign(Error('另一页已更新'),{status:409,code:'CANVAS_CONFLICT'});
  return {project:{...payload.project,id:crypto.randomUUID(),canvasRevision:1}};
 });
 const oldId=c.project.id;c.project.title='B页未保存的名字';
 await assert.rejects(c.flushSave(),error=>error.status===409);
 assert.equal(c.project.title,'B页未保存的名字');assert.equal(c.dirty,true);
 c.project.studio={prompt:'冲突后仍继续编辑'};c.save();
 await assert.rejects(c.flushSave());assert.equal(requests.length,1);
 assert.equal(JSON.parse(storage.get(c.backupKey(oldId))).studio.prompt,'冲突后仍继续编辑');
 conflict=false;await c.saveConflictCopy();
 assert.equal(requests[1].url,'/api/canvas-projects/import');
 assert.equal(requests[1].payload.project.studio.prompt,'冲突后仍继续编辑');
 assert.notEqual(c.project.id,oldId);assert.equal(storage.has(c.backupKey(oldId)),false);
});

test('保存期间新增编辑保留，并使用成功响应的新版本保存下一次',async()=>{
 const requests=[];let release;
 const {context:c}=fixture(async(url,payload)=>{
  requests.push(structuredClone(payload));
  if(requests.length===1)await new Promise(resolve=>release=resolve);
  return {record:{revision:requests.length+1}};
 });
 const first=c.flushSave();c.project.title='请求在途时输入的新名称';c.save();release();await first;
 assert.equal(c.project.title,'请求在途时输入的新名称');assert.equal(c.project.canvasRevision,2);assert.equal(c.dirty,true);
 await c.flushSave();assert.equal(requests[1].canvasRevision,2);assert.equal(requests[1].title,c.project.title);assert.equal(c.dirty,false);
});

test('刷新前保留本页备份，之后仍可将备份另存副本',async()=>{
 const requests=[];
 const {context:c,storage,elements}=fixture(async(url,payload)=>{
  requests.push({url,payload});
  return {project:{...makeProject(),id:crypto.randomUUID(),title:'其他页的最新内容',canvasRevision:3}};
 });
 const id=c.project.id;c.project.title='刷新前尚未保存的创作';
 await c.refreshConflict();assert.equal(c.project.title,'其他页的最新内容');
 assert.equal(JSON.parse(storage.get(c.backupKey(id))).title,'刷新前尚未保存的创作');
 await elements.get('canvas-conflict-copy').onclick();
 assert.equal(requests[1].url,'/api/canvas-projects/import');
 assert.equal(requests[1].payload.project.title,'刷新前尚未保存的创作 本页副本');
});
