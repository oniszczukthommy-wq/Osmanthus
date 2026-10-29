const $=id=>document.getElementById(id);
export function initializeConversions({getProject,transport,settle,apply,review}){
  let projectId=null,job=null,candidates=[],selected='',loading=false,starting=false,applying=false,previewSerial=0,nextPoll=0,error='';
  const audio=$('svc-audio'),running=()=>job&&['queued','converting','preparing'].includes(job.stage);
  if(review){$('svc-preview-kind').closest('label').hidden=true;audio.hidden=true;
    $('svc-preview').textContent='按当前混音试听候选';$('svc-apply').textContent='试听并决定应用';
    const note=audio.nextElementSibling;if(note)note.textContent='候选对照包含当前工程的轨道开关、音量与片段修改；先试听，再决定应用。';}
  const pause=()=>{previewSerial++;audio.pause();};window.pauseSVCPreview=pause;window.pauseVocalPreview=pause;
  async function request(path,body){const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}:{signal:AbortSignal.timeout(15000)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'换声请求未完成');return result;}
  function paint(){const project=getProject();
    $('svc-create').disabled=starting||!!running()||!project;
    $('svc-apply').disabled=applying||!selected||!!running();
    $('svc-restore').disabled=applying||(project?.vocal_variant||'original')==='original';
    $('svc-preview').disabled=job?.stage!=='ready';
    const stages={queued:'等待本机换声',converting:'正在处理完整歌曲',preparing:'正在对齐时长与准备试听'};
    $('svc-status').textContent=error||(running()?`${stages[job.stage]} · 已完成 ${job.chunks_finished||0} 个音频块 · 已用 ${job.elapsed_seconds} 秒`:
      job?.stage==='ready'?(job.quality_accepted?'当前歌曲的这版抒情男声已通过你的听感确认；可以应用到工程。':'整曲换声候选已准备好，听感和吐字待试听确认。试听通过后再应用到工程。'):job?.error||'沿用已试听的抒情男声方案，保留原曲旋律与歌词，制作完整歌曲候选。');
    $('svc-current').textContent=(project?.vocal_variant||'original')==='original'?'当前主唱：原始演唱':`当前主唱：${project?.vocal_candidates?.find(c=>c.id===project.vocal_variant)?.label||'换声版本'}`;
  }
  async function refresh(){if(loading)return;const id=getProject()?.id;if(!id)return;loading=true;
    try{const data=await request('/api/svc/project/'+id);if(getProject()?.id!==id)return;
      job=data.job;candidates=data.candidates||[];if(!candidates.some(c=>c.id===selected))selected=candidates[0]?.id||'';
      const chosen=candidates.find(c=>c.id===selected);
      if(chosen&&job?.stage==='ready'&&job.id!==chosen.job_id){const expected=selected,matched=await request('/api/svc/jobs/'+chosen.job_id);if(getProject()?.id!==id)return;if(selected===expected)job=matched;}
      const selector=$('svc-candidate'),options=candidates.map(c=>[c.id,c.label]);
      if(JSON.stringify(Array.from(selector.options,o=>[o.value,o.text]))!==JSON.stringify(options))selector.replaceChildren(...options.map(([id,label])=>new Option(label,id)));
      selector.value=selected;error='';paint();nextPoll=performance.now()+(running()?2000:15000);
    }catch(e){if(getProject()?.id===id){error=e.message;paint();nextPoll=performance.now()+5000;}}finally{loading=false;}
  }
  $('svc-create').onclick=async()=>{if(starting||running())return;starting=true;error='';paint();const id=getProject()?.id;
    try{if(!await settle()||getProject()?.id!==id)return;const p=getProject();job=await request('/api/svc/jobs',{request_id:crypto.randomUUID(),project_id:p.id,revision:p.revision,voice_id:'226869000163476'});nextPoll=0;}
    catch(e){if(getProject()?.id===id)error=e.message;}finally{starting=false;paint();}};
  async function switchTo(variant){if(applying)return;applying=true;pause();error='';paint();try{
      await apply(variant);await window.refreshVocalScore?.();nextPoll=0;
    }catch(e){error=e.message;}finally{applying=false;paint();}}
  $('svc-apply').onclick=()=>{if(selected)switchTo(selected);};$('svc-restore').onclick=()=>switchTo('original');
  $('svc-candidate').onchange=async event=>{pause();window.pauseCandidatePreview?.();audio.removeAttribute('src');selected=event.target.value;const candidate=candidates.find(c=>c.id===selected),id=getProject()?.id;
    if(candidate)try{const next=await request('/api/svc/jobs/'+candidate.job_id);if(getProject()?.id===id&&selected===candidate.id){job=next;paint();}}catch(e){error=e.message;paint();}};
  $('svc-preview').onclick=async()=>{if(job?.stage!=='ready')return;if(review&&selected){try{await review(selected);}catch(e){error=e.message;paint();}return;}pause();const token=previewSerial,id=getProject()?.id,url=job.files[$('svc-preview-kind').value];
    try{if(audio.getAttribute('src')!==url){audio.src=url;audio.load();}if(token!==previewSerial||getProject()?.id!==id)return;await audio.play();}
    catch(e){if(token===previewSerial&&e.name!=='AbortError'){error=e.message;paint();}}};
  $('svc-preview-kind').onchange=()=>{pause();audio.removeAttribute('src');};
  audio.onplay=()=>{transport.pause();window.pauseScorePreview?.();window.pauseGenerationPreview?.();window.pauseVoiceLibraryPreview?.();};
  function tick(){const id=getProject()?.id;if(id!==projectId){projectId=id;pause();audio.removeAttribute('src');job=null;candidates=[];selected='';error='';nextPoll=0;paint();}
    if(!starting&&performance.now()>=nextPoll)void refresh();else paint();}
  Object.defineProperty(window,'voiceConversionState',{get:()=>({projectId,job,selected,error,candidates,previewPaused:audio.paused})});
  window.refreshVoiceConversion=()=>{nextPoll=0;return refresh();};
  setInterval(tick,1000);tick();
}
