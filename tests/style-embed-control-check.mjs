import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const file=new URL('../music-workbench/validation/track-edit-e2e-20261024/style-library.js',import.meta.url);
const {initStyleLibrary}=await import('data:text/javascript;base64,'+Buffer.from(await readFile(file,'utf8')).toString('base64'));
class FakeNode {
  constructor(dataset={}){this.dataset=dataset;this.attributes={};this.children=[];this.hidden=false;}
  setAttribute(k,v){this.attributes[k]=v;} getAttribute(k){return this.attributes[k];}
  replaceChildren(){this.children=[];} append(...children){this.children.push(...children);}
}
const slots=[],buttons=[];
const grid={audios:[],set innerHTML(html){this.html=html;slots.length=0;buttons.length=0;
  for(const m of html.matchAll(/data-style-embed="([^"]+)"/g)){const b=new FakeNode({styleEmbed:m[1]});b.setAttribute('aria-expanded','false');buttons.push(b);}
  for(const m of html.matchAll(/data-style-embed-slot="([^"]+)"/g))slots.push(new FakeNode({styleEmbedSlot:m[1]}));},
  querySelectorAll(q){return q==='audio'?this.audios:q==='[data-style-embed-slot]'?slots:q==='[data-style-embed]'?buttons:[];}};
const filters=[],events={},pageEvents={};
const section={dataset:{},setAttribute(){},querySelector(q){return q==='.style-library-grid'?grid:null;},querySelectorAll(){return filters;},addEventListener(k,v){events[k]=v;},contains(){return true;}};
const root={classList:{contains:()=>true},querySelector(){return {querySelector(q){return q==='.rs-hero'?{insertAdjacentElement(){}}:null;}};}};
globalThis.document={createElement(tag){return tag==='section'?section:new FakeNode();}};
globalThis.window={addEventListener(k,v){pageEvents[k]=v;}};globalThis.location=new URL('https://guihua.example/');
const styles=[
 {id:'a',name:'A',category:'流行',prompt:'a',previewTitle:'Example <song>',previewArtist:'Example & Artist',previewEmbedUrl:'https://www.udio.com/embed/qj2wxDwH3T54RHpFf4xcWh?embedVariant=default&utm_source=generator',previewSongUrl:'https://www.udio.com/songs/qj2wxDwH3T54RHpFf4xcWh'},
 {id:'b',name:'B',category:'治愈',prompt:'b',previewEmbedUrl:'https://www.udio.com/embed/123-abc'},
 {id:'badhost',name:'C',category:'治愈',prompt:'c',previewEmbedUrl:'https://www.udio.com.evil.example/embed/abc'},
 {id:'badquery',name:'D',category:'治愈',prompt:'d',previewEmbedUrl:'https://www.udio.com/embed/abc?redirect=evil'}
];let callbacks=0;
const library=initStyleLibrary({root,styles,onSelect(){},onPreviewPlay(){callbacks++;}});
assert.equal(buttons.length,2,'only official whitelisted embed URLs are shown');
function click(button){events.click({target:{closest(s){return s==='[data-style-embed]'?button:null;}}});}
click(buttons[0]);assert.equal(callbacks,1);assert.equal(slots[0].children.length,3);
assert.equal(slots[0].children[1].src,styles[0].previewEmbedUrl);assert.equal(slots[0].children[1].allow,'encrypted-media');assert.equal(slots[0].children[2].href,styles[0].previewSongUrl);
assert.match(slots[0].children[0].textContent,/Example <song>/);assert.match(slots[0].children[0].textContent,/作者：Example & Artist/);
click(buttons[1]);assert.equal(slots[0].children.length,0,'previous iframe destroyed');assert.equal(slots[1].children.length,3);
library.pausePreview();assert.equal(slots[1].children.length,0,'main player closes iframe');
click(buttons[0]);pageEvents.pagehide();assert.equal(slots[0].children.length,0,'pagehide closes iframe');
console.log('Udio embed behavior: PASS');
