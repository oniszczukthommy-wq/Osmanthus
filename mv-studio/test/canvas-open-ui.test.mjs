import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {makeProject} from '../public/domain.js';

const source=fs.readFileSync(new URL('../public/studio-ui.js',import.meta.url),'utf8');
const openFunction=source.slice(source.indexOf(' async function openCanvas('),source.indexOf(' async function uploadFile('));
function fixture(){
 const project=makeProject();project.studio={type:'canvas',prompt:'原画布要求',freeCanvas:true,canvas:{nodes:[],edges:[]}};
 const configured=[],activated=[],elements=new Map();
 const context=vm.createContext({canvasOpening:null,prompt:'',type:'story',
  bridge:{read:()=>structuredClone(project),busy:()=>false,configure:fields=>configured.push(fields)},
  free:{activate:async options=>activated.push(options)},sync(){},setView(){},
  $:id=>{if(!elements.has(id))elements.set(id,{value:'原画布要求',setAttribute(){},removeAttribute(){}});return elements.get(id);},
  document:{querySelectorAll:()=>[]},
 });
 vm.runInContext(openFunction,context);return{context,configured,activated};
}

test('打开现有画布不会将canvas类型改成首页默认story或触发保存',async()=>{
 const {context,configured,activated}=fixture();
 await context.openCanvas(false);
 assert.equal(configured.length,0);assert.equal(activated.length,1);assert.equal(activated[0].blank,false);
});

test('用户明确从首页创作时才应用输入的类型和创意',async()=>{
 const {context,configured}=fixture();context.type='performance';context.$('creative-prompt').value='用户刚输入的新创意';
 await context.openCanvas(false,{applyComposer:true});
 assert.equal(configured.length,1);assert.equal(configured[0].type,'performance');assert.equal(configured[0].prompt,'用户刚输入的新创意');
});

test('重复应用相同设置不保存也不清空成片，真实设置编辑仍保存',()=>{
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const configure=app.slice(app.indexOf(' configure:')+' configure:'.length,app.indexOf(',\n setStory:'));
 let saves=0;const project=makeProject();project.studio={type:'canvas',prompt:'原要求'};project.generated={url:'/kept.mp4'};
 const context=vm.createContext({project,running:null,preparing:false,switching:false,beforeEdit:null,comparison:'after',
  $:()=>({}),toast(){},save(){saves++;},render(){},clone:structuredClone});
 vm.runInContext('globalThis.configure='+configure,context);
 assert.equal(context.configure({type:'canvas',prompt:'原要求'}),true);
 assert.equal(saves,0);assert.equal(project.generated.url,'/kept.mp4');
 assert.equal(context.configure({prompt:'真正的新要求'}),true);assert.equal(saves,1);assert.equal(project.generated,null);
});
