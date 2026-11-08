import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const source=await readFile(new URL('../music-workbench/validation/track-edit-e2e-20261024/style-library.js',import.meta.url),'utf8');
const {initStyleLibrary,STYLE_LIBRARY}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
class FakeAudio {
 constructor(){this.paused=true;this.events={};}
 addEventListener(type,fn){this.events[type]=fn;}
 pause(){this.paused=true;}
 play(){this.paused=false;this.events.play?.();}
}
function fixture(fetcher,providedStyles){
 const grid={audios:[],set innerHTML(html){this.html=html;this.audios=Array.from(html.matchAll(/<audio\s/g),()=>new FakeAudio());},querySelectorAll(s){return s==='audio'?this.audios:[];}};
 const filters=[],events={},section={dataset:{},className:'',setAttribute(){},querySelector(s){return s==='.style-library-grid'?grid:null;},querySelectorAll(s){return s==='[data-style-filter]'?filters:[];},addEventListener(k,v){events[k]=v;},contains(){return true;}};
 const hero={insertAdjacentElement(){}},home={querySelector(s){return s==='.rs-hero'?hero:null;}},root={querySelector(){return home;}};
 globalThis.document={createElement(){return section;}};
 globalThis.window={addEventListener(){}};
 globalThis.location=new URL('https://guihua.example/');
 globalThis.fetch=fetcher;
 const styles=providedStyles||[{id:'a',name:'甲',category:'流行',prompt:'甲'},{id:'b',name:'乙',category:'治愈',prompt:'乙'}];
 let selected=null,plays=0;const library=initStyleLibrary({root,styles,onSelect:s=>{selected=s;},onPreviewPlay(){plays++;}});
 return {grid,events,library,get selected(){return selected;},get plays(){return plays;}};
}
{
 let requested='';const f=fixture(async url=>{requested=url;return {ok:true,json:async()=>({ids:['a','b','../evil','unknown',7]})};});
 assert.match(f.grid.html,/试听音频待补充/);
 await new Promise(setImmediate);
 assert.equal(requested,'/api/style-previews');
 assert.equal(f.grid.audios.length,2);
 assert.match(f.grid.html,/https:\/\/guihua\.example\/style-previews\/a\.mp3/);
 assert.doesNotMatch(f.grid.html,/evil|unknown|udio\.com/i);
 const [first,second]=f.grid.audios;first.play();second.play();assert.equal(first.paused,true);assert.equal(f.plays,2);
 f.library.pausePreview();assert.equal(second.paused,true);
}
{
 const f=fixture(async()=>{throw Error('offline');});await new Promise(setImmediate);
 assert.equal(f.grid.audios.length,0);assert.match(f.grid.html,/试听音频待补充/);
}
{
 const f=fixture(async()=>({ok:true,json:async()=>({ids:[]})}),STYLE_LIBRARY);
 assert.match(f.grid.html,/\/assets\/style-covers\/heartfelt-ballad\.webp/);
 assert.match(f.grid.html,/\/assets\/style-covers\/chinese-pop\.webp/);
 const filter={dataset:{styleFilter:'治愈'},setAttribute(){}};
 f.events.click({target:{closest(selector){return selector==='[data-style-filter]'?filter:null;}}});
 assert.match(f.grid.html,/\/assets\/style-covers\/heartfelt-ballad\.webp/);
 assert.doesNotMatch(f.grid.html,/\/assets\/style-covers\/chinese-pop\.webp/);
}
console.log('local style preview catalog: PASS');
