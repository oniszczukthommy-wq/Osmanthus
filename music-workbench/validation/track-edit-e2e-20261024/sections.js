// Musical locations are derived from source-bound aligned lyrics, never even splits.
export function sectionProjectKey(project){return project?`${project.id}|${project.source_sha256}|${project.vocal_variant||'original'}`:'';}
export function rangeFromEntry(view,entry,source='section'){
  const a=entry?.start_seconds,b=entry?.end_seconds;
  if(!view||typeof a!=='number'||typeof b!=='number'||!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>=b||b>view.duration)return null;
  return {project_id:view.project_id,start_seconds:a,end_seconds:b,source,
    section_id:source==='lyric'?entry.section_id:entry.id,
    ...(source==='lyric'?{line_index:entry.index}:{}),
    source_fingerprint:view.source_fingerprint,sections_revision:view.sections_revision,
    navigation_fingerprint:view.navigation_fingerprint};
}
export function initializeSections({getProject,transport,onSelectRange,mount=null,settle=async()=>true,getSelection=()=>window.trackEditorState?.selection}){
  const panel=document.createElement('section');panel.id='music-sections-panel';panel.className='panel';panel.style.gridColumn='1 / -1';
  panel.innerHTML='<p class="eyebrow">音乐段落与歌词定位</p><h2>按主歌、副歌或一句歌词选区</h2><p>段落先按歌词标签和实际演唱时间定位；显示的候选可试听并手动校正。原来的秒数选区仍可使用。</p><p id="music-sections-status" role="status"></p><p id="music-sections-grid" class="note"></p><div class="score-toolbar"><label>音乐段落<select id="section-chooser" aria-label="音乐段落"></select></label><button id="select-section">定位该段落</button><button id="play-section">从此处播放</button></div><p id="section-boundary-note" class="note"></p><div class="score-toolbar"><label>段落开始 / 秒<input id="section-start" aria-label="段落开始秒" type="number" min="0" step="0.01"></label><label>段落结束 / 秒<input id="section-end" aria-label="段落结束秒" type="number" min="0" step="0.01"></label><button id="use-selection-boundary">使用当前秒数选区</button><button id="save-section-boundary">确认并保存段落边界</button><button id="reset-section-boundary">恢复自动候选</button></div><label>一句歌词<select id="section-lyric-chooser" aria-label="按歌词选择区间"></select></label><p class="note">边界校订仅保存定位信息，不改变歌曲、人声音符或已有轨道修改。小节定位仅在全曲拍点明确确认后使用。</p>';
  const target=typeof mount==='string'?document.querySelector(mount):mount;
  if(target)target.append(panel);else{const anchor=document.getElementById('tracks')?.closest('section');if(anchor)anchor.before(panel);else document.querySelector('main')?.append(panel);}
  const $=id=>panel.querySelector('#'+id),clock=n=>Number.isFinite(n)?`${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`:'未定位';
  let key='',view=null,selectedId='',reading=false,saving=false,serial=0,mutation=0,pollAt=0,dirty=false,staleDraft=false,error='',controller=null,destroyed=false;
  const selected=()=>view?.sections.find(s=>s.id===selectedId);
  function status(text,isError=false){$('music-sections-status').textContent=text;$('music-sections-status').className=isError?'error':'';}
  function valid(){return !!view&&getProject()?.id===view.project_id&&sectionProjectKey(getProject())===key;}
  function controls(){
    const has=valid()&&!!selected();
    for(const id of ['section-chooser','section-lyric-chooser','section-start','section-end','use-selection-boundary'])$(id).disabled=!view||saving;
    $('select-section').disabled=!has||saving;
    $('play-section').disabled=!has||saving;
    $('save-section-boundary').disabled=!has||saving||staleDraft;
    $('reset-section-boundary').disabled=!has||saving||!selected()?.manual||staleDraft;
  }
  function fillBounds(){const s=selected();$('section-start').value=s?.start_seconds??'';$('section-end').value=s?.end_seconds??'';dirty=false;staleDraft=false;}
  function paint(){
    if(!view){$('section-chooser').replaceChildren();$('section-lyric-chooser').replaceChildren();$('section-boundary-note').textContent='';$('music-sections-grid').textContent='';controls();return;}
    const s=selected();$('section-boundary-note').textContent=s?`${s.label} · ${s.boundary_note}${s.start_seconds!==null?` · ${clock(s.start_seconds)}–${clock(s.end_seconds)}`:''}`:'';
    const grid=view.grid;$('music-sections-grid').textContent=grid?.bpm?`${grid.bpm} BPM · ${grid.meter} · ${grid.confirmed?'整曲小节网格已确认':'节拍候选，小节定位暂不可用'}`:(grid?.reason||'');
    controls();
  }
  function apply(value){
    const changed=view&&(value.source_fingerprint!==view.source_fingerprint||value.sections_revision!==view.sections_revision);
    if(dirty&&changed){staleDraft=true;status('歌词对齐或段落版本已更新，请重新选择段落后校正，未自动保存旧边界。',true);}
    view=value;const options=view.sections.map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=`${s.label} · ${clock(s.start_seconds)}–${clock(s.end_seconds)} · ${s.confirmed?'已校正':'候选'}`;return o;});$('section-chooser').replaceChildren(...options);
    if(!view.sections.some(s=>s.id===selectedId))selectedId=view.sections[0]?.id||'';$('section-chooser').value=selectedId;
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='选择一句歌词，定位整句演唱范围';
    const lyrics=view.lines.map(l=>{const o=document.createElement('option');o.value=String(l.index);o.textContent=`${l.section_label} · ${l.text} · ${clock(l.start_seconds)}`;o.disabled=l.start_seconds===null;return o;});$('section-lyric-chooser').replaceChildren(placeholder,...lyrics);
    if(!dirty)fillBounds();
    if(!staleDraft)status(view.stage==='ready'?`${view.sections.length} 个段落 · 演唱时间已定位，边界仍需试听确认${view.warnings.length?' · '+view.warnings.join('；'):''}`:(view.warnings.join('；')||'歌词时间尚未准备好，可继续使用秒数选区。'));
    paint();
  }
  async function request(url,body,signal){const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}:{signal});const value=await response.json();if(!response.ok)throw Error(value.error||value.message||'段落定位请求未完成');return value;}
  async function load(force=false){
    if(destroyed)return;const current=getProject(),next=sectionProjectKey(current);if(!next)return;
    if(next!==key){key=next;serial++;mutation++;controller?.abort();reading=false;view=null;selectedId='';dirty=false;staleDraft=false;error='';pollAt=0;paint();status('正在读取当前歌曲的段落与歌词…');}
    if(reading||saving||(!force&&performance.now()<pollAt))return;
    reading=true;const expected=key,token=serial,version=mutation;controller=new AbortController();const requestController=controller,timeout=setTimeout(()=>requestController.abort(),12000);
    try{const value=await request('/api/sections/project/'+current.id,null,requestController.signal);if(token!==serial||expected!==sectionProjectKey(getProject())||version!==mutation)return;if(value.project_id!==current.id)throw Error('段落地图与当前歌曲不匹配');error='';apply(value);pollAt=performance.now()+(value.stage==='ready'?15000:3000);}
    catch(e){if(token!==serial||expected!==sectionProjectKey(getProject())||version!==mutation)return;error=e.name==='AbortError'?'段落定位连接超时，可以重试；音频播放不受影响':e.message;status(error,true);pollAt=performance.now()+10000;}
    finally{clearTimeout(timeout);if(token===serial){reading=false;controls();}}
  }
  const sourceLabel=(entry,kind)=>kind==='lyric'?'按实际演唱对齐，仍需听辨核对':entry.confirmed?'已校正边界':'边界仍为候选，可手动校正';
  async function locate(entry,kind='section',play=false){
    if(!valid())throw Error('歌曲或演唱已变化，请等待定位更新');const range=rangeFromEntry(view,entry,kind);if(!range)throw Error('这段还没有实际演唱时间，请使用秒数选区或手动校正');
    const expected=key;await onSelectRange(range);if(expected!==sectionProjectKey(getProject()))return;
    if(play)await transport.play(view.project_id,range.start_seconds,()=>expected===sectionProjectKey(getProject()));else await transport.seek(view.project_id,range.start_seconds);
    if(expected===sectionProjectKey(getProject())){error='';status(`已定位 ${entry.label||entry.text||'选区'} · ${clock(range.start_seconds)}–${clock(range.end_seconds)}；${sourceLabel(entry,kind)}`);}
  }
  async function guarded(action){try{await action();}catch(e){error=e.message;status(error,true);}}
  $('section-chooser').onchange=()=>{selectedId=$('section-chooser').value;fillBounds();paint();void guarded(()=>locate(selected()));};
  $('select-section').onclick=()=>void guarded(()=>locate(selected()));
  $('play-section').onclick=()=>void guarded(async()=>{const s=selected();const a=Number($('section-start').value),b=Number($('section-end').value);if($('section-start').value===''||$('section-end').value==='')throw Error('先选择已定位的段落或填入有效秒数');await locate({...s,start_seconds:a,end_seconds:b},'section',true);});
  $('section-lyric-chooser').onchange=()=>{const value=$('section-lyric-chooser').value;if(value==='')return;const line=view?.lines.find(l=>l.index===Number(value));if(line){selectedId=line.section_id;$('section-chooser').value=selectedId;fillBounds();paint();void guarded(()=>locate(line,'lyric'));}};
  for(const id of ['section-start','section-end'])$(id).oninput=()=>{dirty=true;controls();};
  $('use-selection-boundary').onclick=()=>void guarded(async()=>{const range=getSelection();if(!range||!Number.isFinite(range.start_seconds)||!Number.isFinite(range.end_seconds)||range.start_seconds>=range.end_seconds)throw Error('请先在歌曲轨道选择有效秒数区间');$('section-start').value=range.start_seconds;$('section-end').value=range.end_seconds;dirty=true;controls();status('已填入当前秒数选区；试听确认后保存段落边界。');});
  async function save(action){
    if(!valid()||!selected())throw Error('请先选择当前歌曲的段落');if(staleDraft)throw Error('定位依据已变化，请重新选择段落');
    const expected=key,s=selected(),guard={project_id:view.project_id,source_fingerprint:view.source_fingerprint,sections_revision:view.sections_revision};
    let a,b;if(action==='set'){if($('section-start').value===''||$('section-end').value==='')throw Error('开始和结束秒数不能为空');a=Number($('section-start').value);b=Number($('section-end').value);if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>=b||b>view.duration)throw Error('段落边界须在本歌曲时长内，且开始早于结束');}
    if(!await settle())return;if(expected!==sectionProjectKey(getProject()))throw Error('歌曲已切换，未保存旧段落边界');
    saving=true;mutation++;controls();
    try{const value=await request('/api/sections/boundary',{...guard,revision:getProject().revision,section_id:s.id,action,...(action==='set'?{start_seconds:a,end_seconds:b,confirmed:true}:{})},AbortSignal.timeout(12000));if(expected!==sectionProjectKey(getProject()))return;dirty=false;staleDraft=false;apply(value);status(action==='set'?'段落边界已保存；歌曲和轨道修改保持原样。':'已恢复歌词定位候选；歌曲和轨道修改保持原样。');}
    catch(e){if(expected===sectionProjectKey(getProject())){error=e.message;status(error,true);if(/版本|对齐|切换|变化/.test(error)){staleDraft=true;pollAt=0;}}}
    finally{saving=false;controls();}
  }
  $('save-section-boundary').onclick=()=>void guarded(()=>save('set'));$('reset-section-boundary').onclick=()=>void guarded(()=>save('reset'));
  const timer=setInterval(()=>void load(),1000);void load(true);
  Object.defineProperty(window,'musicSectionsState',{configurable:true,get:()=>({projectId:view?.project_id,view,selectedSection:selectedId,reading,saving,error,dirty,staleDraft})});
  window.refreshMusicSections=()=>load(true);
  return {refresh:()=>load(true),destroy(){destroyed=true;controller?.abort();clearInterval(timer);panel.remove();}};
}
