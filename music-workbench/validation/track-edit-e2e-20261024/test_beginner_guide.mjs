import test from 'node:test';
import assert from 'node:assert/strict';
import {appendBeginnerHint,initializeBeginnerGuide} from './studio-inspiration.js';

class InputEventStub { constructor(type,options){this.type=type;this.bubbles=options.bubbles;} }
function fixture({value='',maxLength=2000,instrumental=false}={}){
 let events=0,focused=0,click,guide;const messages={textContent:''};
 const field={value,maxLength,ownerDocument:{defaultView:{Event:InputEventStub}},dispatchEvent(e){assert.equal(e.type,'input');assert.equal(e.bubbles,true);events++;},focus(){focused++;}};
 const section={querySelector:()=>guide||null,ownerDocument:{createElement(){return{className:'',innerHTML:'',contains:()=>true,querySelector:()=>messages,addEventListener(name,fn){assert.equal(name,'click');click=fn;}};}},append(node){guide=node;}};
 const root={querySelector(selector){return selector==='[data-create-simple]'?section:selector==='#studio-simple-prompt'?field:null;},classList:{contains(name){assert.equal(name,'is-instrumental-create');return instrumental;}}};
 initializeBeginnerGuide(root);
 return {root,field,messages,guide,events:()=>events,focused:()=>focused,click(id){click({target:{closest(){return{dataset:{beginnerHint:id}};}}});},mode(v){instrumental=v;}};
}

test('suggestions append without overwriting text and fire the normal bubbling input event',()=>{
 const f=fixture({value:'写给妈妈'});f.click('birthday');
 assert.equal(f.field.value,'写给妈妈，为重要的人写一首生日祝福的歌');assert.equal(f.events(),1);assert.equal(f.focused(),0);
 f.click('warm');assert.match(f.field.value,/情绪温暖治愈$/);assert.equal(f.events(),2);
});
test('instrumental hints do not introduce lyrics or vocals',()=>{
 const f=fixture({instrumental:true});f.click('birthday');f.click('pop');
 assert.equal(f.field.value,'适合生日庆祝的背景音乐，流行音乐风格');assert.doesNotMatch(f.field.value,/人声|歌词|写一首.*歌/);
 f.mode(false);f.click('love');assert.match(f.field.value,/写一首关于喜欢和陪伴的歌$/);
});
test('repeated or oversized suggestions leave the existing draft unchanged',()=>{
 const f=fixture({value:'原有想法',maxLength:8});f.click('birthday');assert.equal(f.field.value,'原有想法');assert.equal(f.events(),0);assert.match(f.messages.textContent,/上限/);
 const g=fixture();g.click('warm');const once=g.field.value;g.click('warm');assert.equal(g.field.value,once);assert.equal(g.events(),1);assert.match(g.messages.textContent,/已经/);
});
test('disabled and read-only fields are never changed',()=>{
 for(const state of ['disabled','readOnly']){const f=fixture({value:'草稿'});f.field[state]=true;f.click('warm');assert.equal(f.field.value,'草稿');assert.equal(f.events(),0);}
});
test('guide creation is local and idempotent',()=>{
 const f=fixture();assert.match(f.guide.innerHTML,/不知道怎么写/);assert.match(f.guide.innerHTML,/data-beginner-hint="video"/);assert.equal(initializeBeginnerGuide(f.root),undefined);
 const field={value:'原文',maxLength:4,ownerDocument:{defaultView:{Event:InputEventStub}},dispatchEvent(){throw Error('must not dispatch');},focus(){}};
 assert.equal(appendBeginnerHint(field,'很长的提示'),'full');assert.equal(field.value,'原文');
});
