import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const p=new URL('../music-workbench/validation/track-edit-e2e-20261024/studio.js',import.meta.url);
const src=await readFile(p,'utf8');
const body=src.slice(src.indexOf('function initStyleOptimization(){'),src.indexOf('\ninitStyleOptimization();'));
function fixture(){
 let button,message,save=0,resolve,reject,calls=[];
 const field={value:'柔和钢琴',maxLength:1000,handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},after(b,m){button=b;message=m;},dispatchEvent(e){this.handlers[e.type]?.(e);}};
 const context={navigation:3,styleOptimizationRevision:0,instrumental:false,mode:'advanced',$:()=>field,saveFormDraft(){save++},Event:class{constructor(type){this.type=type}},
 document:{createElement(){return {className:'',textContent:'',disabled:false,hidden:false,classList:{add(){},remove(){}},setAttribute(){},addEventListener(k,fn){this.handler=fn;}};}},
 api(path,body){calls.push([path,body]);return new Promise((r,j)=>{resolve=r;reject=j;});}
 };
 runInNewContext(body+';initStyleOptimization();',context);
 return {context,field,get button(){return button},get message(){return message},get calls(){return calls},get save(){return save},resolve:v=>resolve(v),reject:e=>reject(e)};
}
{
 const f=fixture(),promise=f.button.handler();assert.equal(f.button.disabled,true);assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),['/api/creation/optimize-style',{style:'柔和钢琴',instrumental:false}]);
 await f.button.handler();assert.equal(f.calls.length,1);f.resolve({style:'温暖的钢琴抒情'});await promise;assert.equal(f.field.value,'温暖的钢琴抒情');assert.equal(f.save,1);assert.equal(f.button.disabled,false);
}
{
 const f=fixture(),promise=f.button.handler();f.field.value='用户新写的风格';f.field.dispatchEvent({type:'input'});f.resolve({style:'旧结果'});await promise;assert.equal(f.field.value,'用户新写的风格');assert.equal(f.save,0);assert.match(f.message.textContent,/保留/);
}
{
 const f=fixture(),promise=f.button.handler();f.context.navigation++;f.resolve({style:'旧结果'});await promise;assert.equal(f.field.value,'柔和钢琴');assert.equal(f.save,0);
}
{
 const f=fixture();f.context.instrumental=true;const promise=f.button.handler();assert.equal(f.calls[0][1].instrumental,true);f.context.styleOptimizationRevision++;f.resolve({style:'旧结果'});await promise;assert.equal(f.field.value,'柔和钢琴');assert.equal(f.save,0);
}
{
 const f=fixture(),promise=f.button.handler();f.reject(Error('余额不足'));await promise;assert.equal(f.field.value,'柔和钢琴');assert.match(f.message.textContent,/余额不足/);assert.equal(f.button.disabled,false);
}
{
 const f=fixture();f.field.value=' ';await f.button.handler();assert.equal(f.calls.length,0);assert.match(f.message.textContent,/先填写/);
}
{
 const f=fixture(),promise=f.button.handler();f.resolve({style:'过'.repeat(1001)});await promise;assert.equal(f.field.value,'柔和钢琴');assert.equal(f.save,0);assert.match(f.message.textContent,/不可用/);
}
console.log('style optimization UI behavior: PASS');
