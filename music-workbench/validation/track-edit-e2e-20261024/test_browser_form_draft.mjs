import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserDraft,generationIsBlocked} from './studio-creation-request.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

function memory(){const values=new Map();return {getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};}
function open(storage,session,key='form'){const warnings=[];const draft=createBrowserDraft({storage,session,key,onWarning:m=>warnings.push(m)});return {draft,warnings,value:draft.load()};}

test('form draft survives refresh, mode changes, and explicit emptying without touching request recovery',()=>{
 const shared=memory(),session=memory();shared.setItem('osmanthus-direct-generation-request','pending request');
 let f=open(shared,session);assert.equal(f.value,null);
 const value={mode:'advanced',instrumental:true,prompt:'雨天的钢琴',lyrics:'原歌词',voice:'女声'};
 assert.equal(f.draft.save(value),true);f=open(shared,session);assert.deepEqual(f.value,value);
 assert.equal(f.draft.save({...value,prompt:'',lyrics:'',voice:''}),true);
 f=open(shared,session);assert.equal(f.value.lyrics,'');assert.equal(f.value.prompt,'');
 assert.equal(shared.getItem('osmanthus-direct-generation-request'),'pending request');
});

test('stale tab cannot overwrite shared draft and its own edits survive refresh',()=>{
 const shared=memory(),one=memory(),two=memory(),a=open(shared,one),b=open(shared,two);
 a.draft.save({prompt:'甲的创作'});assert.equal(b.draft.save({prompt:'乙的创作'}),false);
 assert.match(b.warnings.at(-1),/其他标签页/);
 assert.deepEqual(open(shared,one).value,{prompt:'甲的创作'});
 const reloaded=open(shared,two);assert.deepEqual(reloaded.value,{prompt:'乙的创作'});
 assert.equal(reloaded.draft.save({prompt:'乙继续编辑'}),false);
 assert.deepEqual(open(shared,one).value,{prompt:'甲的创作'});
});

test('unreadable existing shared draft is not overwritten',()=>{
 const shared=memory(),session=memory();shared.setItem('form','not valid json');const f=open(shared,session);
 assert.equal(f.draft.save({prompt:'用户新输入'}),false);assert.equal(shared.getItem('form'),'not valid json');
 assert.deepEqual(open(shared,session).value,{prompt:'用户新输入'});
});

test('review drafts are isolated by draft id and version',()=>{
 const shared=memory(),session=memory(),a=open(shared,session,'review:a:1');
 a.draft.save({title:'手改标题',lyrics:'手改歌词'});
 assert.deepEqual(open(shared,session,'review:a:1').value,{title:'手改标题',lyrics:'手改歌词'});
 assert.equal(open(shared,session,'review:a:2').value,null);assert.equal(open(shared,session,'review:b:1').value,null);
});

test('storage failures never throw during editing and warn about the persistence limit',()=>{
 const bad={getItem(){throw Error('denied');},setItem(){throw Error('denied');}},session=memory(),f=open(bad,session);
 assert.equal(f.draft.save({prompt:'雨后'}),false);assert.match(f.warnings.at(-1),/标签页/);
 assert.deepEqual(open(bad,session).value,{prompt:'雨后'});
});

test('an unresolved request blocks generation on both home and create forms',async()=>{
 const source=await readFile(new URL('./studio.js',import.meta.url),'utf8');
 const text=source.slice(source.indexOf('function updateGenerateButton()'),source.indexOf('async function resumeCreation'));
 const home={setAttribute(){}},nodes={'studio-generate-song':{setAttribute(){}},'studio-simple-prompt':{value:'测试曲目'},'studio-custom-lyrics':{value:'测试歌词'},'studio-custom-style':{value:'风格'}};
 const context={creationRecovery:{state:{pending:{id:'synthetic'},working:false}},generationIsBlocked,creating:false,lyricsRequest:null,mode:'simple',instrumental:false,all:()=>[],q:()=>home,$:id=>nodes[id]};
 vm.runInNewContext(text+';updateGenerateButton();',context);assert.equal(home.disabled,true);assert.equal(nodes['studio-generate-song'].disabled,true);
 context.creationRecovery.state.pending=null;vm.runInNewContext('updateGenerateButton();',context);assert.equal(home.disabled,false);assert.equal(nodes['studio-generate-song'].disabled,false);
});
