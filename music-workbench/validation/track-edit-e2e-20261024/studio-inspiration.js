// The dice always requests DeepSeek; it never substitutes a canned local idea.
export function initializeInspiration({root,api,onIdea=()=>{}}){
 const button=root.querySelector('[data-rs="idea"]'),input=root.querySelector('#rs-suno-idea'),note=root.querySelector('[data-rs-home-note]');if(!button||!input)return;
 let pending=false;
 button.addEventListener('click',async()=>{
  if(pending)return;pending=true;const baseline=input.value,instrumental=root.classList.contains('is-instrumental-create');button.disabled=true;button.setAttribute('aria-busy','true');note.textContent='DeepSeek 正在构思灵感…';note.dataset.error='false';
  try{const result=await api('/api/creation/inspiration',{context:baseline,instrumental});
   if(input.value!==baseline||!root.classList.contains('is-home')||root.classList.contains('is-instrumental-create')!==instrumental){note.textContent='想法已变更，本次灵感未覆盖你的输入。';return;}
   input.value=result.idea;input.dispatchEvent(new Event('input',{bubbles:true}));onIdea(result.idea);note.textContent='灵感已准备好，可以按你的想法继续修改。';input.focus();input.setSelectionRange?.(0,0);input.scrollTop=0;
  }catch(error){note.textContent=error.message||'灵感暂未生成，请再试一次。';note.dataset.error='true';}
  finally{pending=false;button.disabled=false;button.removeAttribute('aria-busy');}
 });
}
