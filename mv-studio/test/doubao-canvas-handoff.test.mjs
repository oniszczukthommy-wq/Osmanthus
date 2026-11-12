import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DOUBAO_URL,doubaoPrompt,doubaoImportPlan} from '../public/doubao-canvas-handoff.js';

test('hand-off validates and preserves the active prompt',()=>{
  assert.equal(DOUBAO_URL,'https://www.doubao.com/chat/');
  assert.equal(doubaoPrompt('  a cinematic scene\n雨夜  '),'a cinematic scene\n雨夜');
  assert.throws(()=>doubaoPrompt('   '),/填写/);
});
test('returning media targets the original project and node without replacing existing assets',()=>{
  const expected={projectId:'p1',nodeId:'n1',type:'image'},item={kind:'image'};
  assert.equal(doubaoImportPlan({expected,currentProjectId:'p1',nodes:[{id:'n1',type:'image'}],item}).addVersion,false);
  assert.equal(doubaoImportPlan({expected,currentProjectId:'p1',nodes:[{id:'n1',type:'image',asset:{url:'/files/image.png'}}],item}).addVersion,true);
  assert.throws(()=>doubaoImportPlan({expected,currentProjectId:'p2',nodes:[],item}),/工程已切换/);
  assert.throws(()=>doubaoImportPlan({expected,currentProjectId:'p1',nodes:[],item}),/画框不存在/);
  assert.throws(()=>doubaoImportPlan({expected,currentProjectId:'p1',nodes:[{id:'n1',type:'image'}],item:{kind:'video'}}),/类型/);
});
test('file selection binds an empty node and links a new version when occupied',async()=>{
  const canvas=await readFile(new URL('../public/free-canvas-ui.js',import.meta.url),'utf8');
  const begin=canvas.indexOf(" $('fc-file').onchange="),end=canvas.indexOf("\n",begin);
  assert(begin>=0&&end>begin);
  let handler,commits=[],adds=[],notes=[],projectId='p1',uploads=0;
  const input={files:[{name:'result.png'}],value:'result.png'};
  const expected={projectId:'p1',nodeId:'n1',type:'image'};
  const ctx={uploadTarget:null,doubaoUpload:expected,read:()=>({id:projectId}),doc:{nodes:[{id:'n1',type:'image'}]},meta:{n1:{prompt:'画面'}},
    uploadMaterials:async()=>{uploads++;return[{kind:'image',id:'m1',url:'/files/image.png',name:'result.png'}]},
    doubaoImportPlan,updateNode:(doc,id,patch)=>({id,patch}),commit:doc=>{commits.push(doc);return true;},
    addMaterials:async(...args)=>adds.push(args),center:()=>({x:1,y:1}),menuPoint:{x:0,y:0},toast:msg=>notes.push(msg),$:()=>({set onchange(fn){handler=fn;}})};
  vm.runInNewContext(canvas.slice(begin,end),ctx);await handler({target:input});
  assert.equal(commits[0].id,'n1');assert.equal(input.value,'');assert.equal(ctx.doubaoUpload,null);
  ctx.doubaoUpload=expected;ctx.doc.nodes[0].asset={url:'/files/original.png'};input.value='another.png';await handler({target:input});
  assert.equal(commits.length,1);assert.equal(adds[0][2].originNodeId,'n1');assert.equal(adds[0][2].provider,'doubao-manual');
  ctx.doubaoUpload=expected;projectId='p2';input.value='switched.png';await handler({target:input});
  assert.equal(uploads,2);assert.match(notes.at(-1),/工程已切换/);
});
