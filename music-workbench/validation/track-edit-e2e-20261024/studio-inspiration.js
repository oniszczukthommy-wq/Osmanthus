// Small, editable starting points; these do not call a model or submit a task.
const beginnerHints = {
 birthday:{song:'为重要的人写一首生日祝福的歌',instrumental:'适合生日庆祝的背景音乐'},
 love:{song:'写一首关于喜欢和陪伴的歌',instrumental:'适合表达爱意与陪伴的背景音乐'},
 relax:{song:'写一首适合下班后放松的歌',instrumental:'适合下班后放松的背景音乐'},
 video:{song:'为短视频创作一首有画面感的歌',instrumental:'为短视频创作有画面感的背景音乐'},
 warm:{song:'情绪温暖治愈',instrumental:'情绪温暖治愈'},
 happy:{song:'情绪轻快开心',instrumental:'情绪轻快开心'},
 moved:{song:'情绪真挚感动',instrumental:'情绪真挚感动'},
 energy:{song:'情绪充满力量',instrumental:'情绪充满力量'},
 pop:{song:'中文流行风格',instrumental:'流行音乐风格'},
 folk:{song:'轻柔民谣风格',instrumental:'轻柔民谣风格'},
 piano:{song:'以钢琴伴奏为主',instrumental:'以钢琴为主'},
 retro:{song:'复古电子风格',instrumental:'复古电子风格'},
};

export function appendBeginnerHint(field, text) {
 if (!field || field.disabled || field.readOnly || !text) return 'unavailable';
 const current = field.value || '';
 if (current.includes(text)) return 'exists';
 const separator = !current || /[\s，。！？、,.!?]$/.test(current) ? '' : '，';
 const next = current + separator + text;
 const limit = Number(field.maxLength);
 if (limit > 0 && next.length > limit) return 'full';
 field.value = next;
 const EventType = field.ownerDocument?.defaultView?.Event || Event;
 field.dispatchEvent(new EventType('input', {bubbles:true}));
 return 'added';
}

export function initializeBeginnerGuide(root) {
 const section=root.querySelector('[data-create-simple]'), field=root.querySelector('#studio-simple-prompt');
 if (!section || !field || !section.ownerDocument || typeof section.querySelector!=='function' || section.querySelector('.studio-beginner-guide')) return;
 const guide=section.ownerDocument.createElement('details');
 guide.className='studio-beginner-guide';
 guide.innerHTML='<summary>不知道怎么写？试试这些方向</summary><p>选择想法会添加到输入框，你可以继续修改。</p><div class="studio-beginner-row" role="group" aria-label="创作场景"><span>场景</span><button type="button" data-beginner-hint="birthday">生日祝福</button><button type="button" data-beginner-hint="love">爱与陪伴</button><button type="button" data-beginner-hint="relax">下班放松</button><button type="button" data-beginner-hint="video">视频配乐</button></div><div class="studio-beginner-row" role="group" aria-label="歌曲情绪"><span>情绪</span><button type="button" data-beginner-hint="warm">温暖</button><button type="button" data-beginner-hint="happy">轻快</button><button type="button" data-beginner-hint="moved">感动</button><button type="button" data-beginner-hint="energy">有力量</button></div><div class="studio-beginner-row" role="group" aria-label="音乐风格"><span>风格</span><button type="button" data-beginner-hint="pop">流行</button><button type="button" data-beginner-hint="folk">民谣</button><button type="button" data-beginner-hint="piano">钢琴</button><button type="button" data-beginner-hint="retro">复古电子</button></div><p class="studio-beginner-status" role="status" aria-live="polite"></p>';
 guide.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-beginner-hint]');
  if (!button || !guide.contains(button)) return;
  const hint=beginnerHints[button.dataset.beginnerHint];if(!hint)return;
  const instrumental=root.classList.contains('is-instrumental-create');
  const result=appendBeginnerHint(field,instrumental?hint.instrumental:hint.song);
  guide.querySelector('.studio-beginner-status').textContent=result==='added'?'已添加到输入框，可以继续修改。':result==='exists'?'这个方向已经添加，可以继续编辑。':result==='full'?'输入内容已接近上限，请先精简再添加。':'当前输入暂不可编辑。';
 });
 section.append(guide);
}

// The dice always requests DeepSeek; it never substitutes a canned local idea.
export function initializeInspiration({root,api,onIdea=()=>{}}){
 initializeBeginnerGuide(root);
 const button=root.querySelector('[data-rs="idea"]'),input=root.querySelector('#rs-suno-idea'),note=root.querySelector('[data-rs-home-note]');if(!button||!input)return;
 let pending=false;
 button.addEventListener('click',async()=>{
  if(pending)return;pending=true;const baseline=input.value,instrumental=root.classList.contains('is-instrumental-create');button.disabled=true;button.setAttribute('aria-busy','true');note.textContent='';note.dataset.error='false';
  try{const result=await api('/api/creation/inspiration',{context:baseline,instrumental});
   if(input.value!==baseline||!root.classList.contains('is-home')||root.classList.contains('is-instrumental-create')!==instrumental){note.textContent='想法已变更，本次灵感未覆盖你的输入。';return;}
   input.value=result.idea;input.dispatchEvent(new Event('input',{bubbles:true}));onIdea(result.idea);note.textContent='灵感已准备好，可以按你的想法继续修改。';input.focus();input.setSelectionRange?.(0,0);input.scrollTop=0;
  }catch(error){note.textContent=error.message||'灵感暂未生成，请再试一次。';note.dataset.error='true';}
  finally{pending=false;button.disabled=false;button.removeAttribute('aria-busy');}
 });
}
