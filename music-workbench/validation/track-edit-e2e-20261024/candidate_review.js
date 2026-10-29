// All generated changes use the same current-mix audition and guarded commit.
const clock=n=>`${Math.floor(n/60)}:${(n%60).toFixed(1).padStart(4,'0')}`;

export function previewSelection(project,selection,candidate){
  const duration=Number(project.duration),bounds=candidate?.range_seconds||[0,duration];
  let start=Number(selection?.[0]),end=Number(selection?.[1]);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration||end<=start||end<=bounds[0]||start>=bounds[1]){
    start=bounds[0];end=Math.min(bounds[1],start+30);
  }
  // A long edit is still applied to its whole declared range; preview is capped.
  if(end-start>60)end=start+30;
  return {preview_start_seconds:start,preview_end_seconds:end};
}

export function initializeCandidateReview({getProject,getSelection,transport,settle,apply,container}){
  const panel=document.createElement('section');panel.id='candidate-review-panel';panel.className='panel vocal-score-panel';panel.hidden=true;
  panel.innerHTML=`<h2>试听这次修改，再决定应用</h2>
    <p id="candidate-review-status" role="status" aria-live="polite"></p>
    <p id="candidate-review-scope"></p><p id="candidate-review-keep" class="note"></p>
    <p id="candidate-review-range" class="note"></p>
    <div class="score-toolbar"><button id="candidate-review-a" type="button">A · 当前工程</button>
    <button id="candidate-review-b" type="button">B · 候选（匹配响度）</button>
    <button id="candidate-review-actual" type="button">候选实际音量</button></div>
    <audio id="candidate-review-audio" controls preload="none"></audio>
    <p id="candidate-review-matching" class="note"></p><p id="candidate-review-checks" class="note"></p>
    <p id="candidate-review-warning" role="status"></p>
    <div class="score-toolbar"><button id="candidate-review-apply" type="button">确认应用这版</button>
    <button id="candidate-review-refresh" type="button">按当前工程重新准备对照</button>
    <button id="candidate-review-cancel" type="button">取消，保留当前工程</button></div>`;
  if(container)container.append(panel);
  else {const anchor=document.querySelector('.conversation');if(anchor)anchor.before(panel);else document.querySelector('main').append(panel);}
  const el=id=>panel.querySelector('#candidate-review-'+id),audio=el('audio');
  let review=null,spec=null,loading=false,applying=false,applied=false,error='',serial=0,audioSerial=0,metadata=null,mode='reference.wav',stale=false;
  const signature=p=>p?`${p.id}|${p.revision}|${p.fingerprint}`:'';
  const current=()=>review&&signature(getProject())===`${review.project_id}|${review.revision}|${review.fingerprint}`;
  function pause(){audioSerial++;audio.pause();if(metadata){audio.removeEventListener('loadedmetadata',metadata);metadata=null;}}
  window.pauseCandidatePreview=pause;
  function stopOthers(){transport.pause();window.pauseScorePreview?.();window.pauseVocalPreview?.();window.pauseSVCPreview?.();window.pauseGenerationPreview?.();window.pauseVoiceLibraryPreview?.();}
  async function request(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    const data=await r.json();if(!r.ok)throw Error(data.error||'候选对照未完成');return data;}
  function paint(){
    const ready=!!review&&!loading&&!applying&&!stale&&!applied;
    el('status').textContent=error||(loading?'正在按当前工程准备原版与候选对照…':applying?'正在应用已试听的候选…':applied?'此候选已应用。上方播放和导出使用当前工程；可用“撤销”恢复。':review?'对照已准备好，当前工程尚未改变。':'');
    for(const name of ['a','b','actual'])el(name).disabled=!ready;
    el('apply').disabled=!ready||!review.can_apply;
    el('refresh').disabled=loading||applying||!spec||applied;
    el('cancel').disabled=applying;
    if(!review){for(const name of ['scope','keep','range','matching','checks','warning'])el(name).textContent='';return;}
    el('scope').textContent=`${review.scope}：${review.label} · 应用范围 ${review.range_seconds.map(clock).join('—')}`;
    el('keep').textContent=`保持：${review.preserved_tracks.map(t=>t.label).join('、')||'其他已有轨道'}；修改范围之外的声音保持原样。`;
    el('range').textContent=`本次试听 ${review.preview_range_seconds.map(clock).join('—')}（包含前后最多各 2 秒过渡）；试听区间不改变上面的应用范围。`;
    el('matching').textContent=`B 版采用 RMS 近似响度匹配，试听补偿 ${review.matching.candidate_gain_db.toFixed(2)} dB；此补偿不写入工程。“候选实际音量”用于检查应用后的真实平衡。`;
    const seam=review.checks.seams.filter(s=>s.needs_listening).map(s=>clock(s.at_seconds));
    el('checks').textContent=`时间线、非目标轨道和区间外采样检查通过。${seam.length?'重点核听接缝：'+seam.join('、')+'。':'未触发接缝突变阈值。'}这些检查不能替代音乐听感确认。`;
    el('warning').textContent=review.warnings.join(' ');
    for(const [id,key] of [['a','reference.wav'],['b','candidate.wav'],['actual','candidate-actual.wav']])el(id).setAttribute('aria-pressed',String(mode===key));
  }
  async function open(value){
    if(applying)return;
    const token=++serial;pause();audio.removeAttribute('src');audio.load();review=null;spec={...value};applied=false;stale=false;loading=true;error='';panel.hidden=false;paint();panel.scrollIntoView({block:'nearest',behavior:'smooth'});
    try{
      if(!await settle())throw Error('轨道修改尚未保存，请先处理工程提示');
      if(token!==serial)return;
      const p=getProject();if(!p)throw Error('请先打开歌曲工程');const expected=signature(p);
      const asset=value.kind==='arrangement'?(p.available_parts||[]).find(c=>c.id===value.candidate_id):null;
      const range=previewSelection(p,getSelection?.(),asset||value);
      const result=await request('/api/candidate-reviews',{project_id:p.id,revision:p.revision,kind:value.kind,candidate_id:value.candidate_id,...range});
      if(token!==serial)return;
      if(signature(getProject())!==expected)throw Error('准备期间工程已变化，请按当前工程重新准备对照');
      review=result;mode='reference.wav';error='';
    }catch(e){if(token===serial)error=e.message;}
    finally{if(token===serial){loading=false;paint();}}
    return review;
  }
  function audition(key){
    if(!review||loading||applying||applied||!current())return;
    const at=audio.ended?0:audio.currentTime||0;
    pause();stopOthers();mode=key;const token=audioSerial,identifier=review.id,url=review.files[key];
    if(audio.getAttribute('src')!==url){audio.src=url;audio.load();}
    const start=()=>{metadata=null;if(token!==audioSerial||review?.id!==identifier||!current())return;
      audio.currentTime=Math.min(at,Math.max(0,(review.preview_range_seconds[1]-review.preview_range_seconds[0])-.01));
      audio.play().catch(e=>{if(token!==audioSerial||e.name==='AbortError')return;error=e.message;paint();});};
    if(audio.readyState>=1)start();else{metadata=start;audio.addEventListener('loadedmetadata',start,{once:true});}
    paint();
  }
  el('a').onclick=()=>audition('reference.wav');el('b').onclick=()=>audition('candidate.wav');el('actual').onclick=()=>audition('candidate-actual.wav');
  el('refresh').onclick=()=>{if(spec)void open(spec);};
  function cancel(){if(applying)return;serial++;pause();audio.removeAttribute('src');audio.load();panel.hidden=true;review=null;spec=null;loading=false;error='';stale=false;paint();}
  el('cancel').onclick=cancel;
  el('apply').onclick=async()=>{
    if(applying||!review||!review.can_apply)return;
    applying=true;error='';pause();paint();
    try{
      if(!await settle())throw Error('轨道修改尚未保存，请先处理工程提示');
      if(!current()){stale=true;throw Error('工程在试听后已变化，请重新准备对照；没有覆盖你的修改');}
      const result=await apply(review);if(result===false)throw Error('候选应用未完成');applied=true;
    }
    catch(e){error=e.message;}
    finally{applying=false;paint();}
  };
  audio.onplay=()=>{if(!current()){pause();return;}stopOthers();};
  audio.onerror=()=>{if(review&&!panel.hidden){error='对照音频载入失败，请重新准备对照';paint();}};
  const timer=setInterval(()=>{
    if(panel.hidden||loading||applying||applied||!review)return;
    if(!current()&&!stale){stale=true;pause();error='当前歌曲或混音已变化，对照已停止；请重新准备，保留最新修改。';paint();}
  },300);
  Object.defineProperty(window,'candidateReviewState',{configurable:true,get:()=>({review,loading,applying,applied,stale,error,mode,paused:audio.paused,currentTime:audio.currentTime,hidden:panel.hidden})});
  paint();
  return {open,pause,cancel,destroy:()=>{clearInterval(timer);cancel();panel.remove();}};
}
