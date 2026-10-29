// The animated idea is guidance only. This module never writes textarea.value.
export function initializeIdeaPlaceholder(studio,{input=document.getElementById('rs-suno-idea'),root=document.getElementById('os-mix-28')}={}){
 if(!input||!root)return null;
 const doc=input.ownerDocument,view=doc.defaultView,media=view.matchMedia('(prefers-reduced-motion: reduce)');
 const original=input.getAttribute('placeholder')||'描述你想创作的歌曲…';
 const examples=[original,'一首轻快的中文流行，写周末奔向海边的心情。明亮的吉他，自然的男声，副歌让人想跟着唱。','一首深夜 R&B，写路灯下还没说出口的心事。温柔的电钢琴，松弛的律动，贴近耳边的人声。'];
 const content=examples.map(text=>Array.from(text)),normal='描述歌曲的主题、风格、配器和情绪…',lyrics='写入完整歌词，可使用 [VERSE]、[CHORUS] 等段落标签。';
 let timer=null,closed=false,composing=false,word=0,position=0,deleting=false;
 const lyricMode=()=>root.querySelector('[data-rs="lyrics-mode"]')?.getAttribute('aria-pressed')==='true';
 function clear(){if(timer!==null){view.clearTimeout(timer);timer=null;}}
 function eligible(){return !closed&&!composing&&!input.value&&doc.activeElement!==input&&!doc.hidden&&root.classList.contains('is-home')&&!lyricMode();}
 function show(text){if(input.placeholder!==text)input.placeholder=text;}
 function schedule(delay){clear();timer=view.setTimeout(tick,delay);}
 function tick(){
  timer=null;if(!eligible())return;
  if(media.matches){show(examples[0]);return;}
  if(deleting){position=Math.max(0,position-1);show(content[word].slice(0,position).join(''));if(position===0){deleting=false;word=(word+1)%content.length;schedule(550);}else schedule(24);}
  else{position=Math.min(content[word].length,position+1);show(content[word].slice(0,position).join(''));if(position===content[word].length){deleting=true;schedule(1900);}else schedule(56);}
 }
 function sync(){
  clear();if(closed)return;
  if(!eligible()){show(lyricMode()?lyrics:normal);return;}
  if(media.matches){show(examples[0]);return;}
  word=0;position=0;deleting=false;show('');schedule(300);
 }
 function focus(){clear();show(lyricMode()?lyrics:normal);}
 function change(){clear();if(!input.value&&doc.activeElement!==input&&!composing)sync();}
 function compositionStart(){composing=true;focus();}
 function compositionEnd(){composing=false;change();}
 // Suggestions set .value programmatically; inspect after the main click handler.
 function rootClick(event){if(event.target.closest('[data-rs]'))queueMicrotask(sync);}
 input.addEventListener('focus',focus);input.addEventListener('blur',sync);input.addEventListener('input',change);
 input.addEventListener('compositionstart',compositionStart);input.addEventListener('compositionend',compositionEnd);
 root.addEventListener('click',rootClick);doc.addEventListener('visibilitychange',sync);media.addEventListener('change',sync);
 const observer=new MutationObserver(sync);observer.observe(root,{attributes:true,attributeFilter:['class']});
 function destroy(){if(closed)return;closed=true;clear();observer.disconnect();input.removeEventListener('focus',focus);input.removeEventListener('blur',sync);input.removeEventListener('input',change);input.removeEventListener('compositionstart',compositionStart);input.removeEventListener('compositionend',compositionEnd);root.removeEventListener('click',rootClick);doc.removeEventListener('visibilitychange',sync);media.removeEventListener('change',sync);view.removeEventListener('pagehide',destroy);show(lyricMode()?lyrics:normal);}
 view.addEventListener('pagehide',destroy,{once:true});sync();return{destroy};
}
