const $=id=>document.getElementById(id);
export function initializeVocals({getProject,transport,settle,apply}){
 let projectId=null,job=null,loading=false,starting=false,applying=false,selected='',error='',previewSerial=0,metadataHandler=null;
 const audio=$('vocal-candidate-audio');
 Object.defineProperty(window,'vocalCandidateState',{get:()=>({projectId,job,selected,error,previewTime:audio.currentTime,previewPaused:audio.paused})});
 function cancel(){previewSerial++;if(metadataHandler){audio.removeEventListener('loadedmetadata',metadataHandler);metadataHandler=null;}}
 window.pauseVocalPreview=()=>{cancel();audio.pause();};
 const active=()=>job&&['queued','synthesizing','preparing'].includes(job.stage);
 async function request(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw Error(data.error||'重唱请求未完成');return data;}
 function paint(){
  const p=getProject();$('create-vocal-candidate').disabled=starting||active()||!p?.generation_job_id;
  $('resing-vocal').disabled=starting||active()||!p?.generation_job_id;
  $('apply-vocal-candidate').disabled=applying||active()||!selected;
  $('restore-vocal-original').disabled=applying||(p?.vocal_variant||'original')==='original';
  const labels={queued:'等待本机歌声合成',synthesizing:'正在按固定旋律重新演唱',preparing:'正在对齐整曲并准备试听'};
  $('vocal-candidate-status').textContent=error||(active()?`${labels[job.stage]} · ${job.rendered_seconds||0}秒已合成 · 已用${job.elapsed_seconds}秒`:
    job?.stage==='ready'?`完整重唱候选已准备好 · 合成用时 ${Number(job.synthesis_seconds).toFixed(1)} 秒${job.reused_completed_synthesis?'（本次复用已完成的合成）':''}。听感与吐字待试听确认。`:job?.error||'先生成并核对演唱谱，再用固定声库按相同旋律和歌词重新演唱。');
  $('vocal-current-singer').textContent=(p?.vocal_variant||'original')==='original'?'当前主唱：原始演唱':`当前主唱：${p.vocal_candidates?.find(c=>c.id===p.vocal_variant)?.label||'重唱版本'}`;
  $('vocal-preview-panel').hidden=job?.stage!=='ready';
 }
 async function refresh(force=false){const p=getProject();if(!p||loading)return;
  if(projectId!==p.id){window.pauseVocalPreview();audio.removeAttribute('src');projectId=p.id;job=null;selected='';error='';force=true;paint();}
  if(!force&&!active())return;loading=true;const id=projectId;
  try{const data=await request('/api/vocals/project/'+id);if(getProject().id!==id)return;job=data.job;error='';
   const options=data.candidates||[];$('vocal-candidate-select').replaceChildren(...options.map(c=>new Option(c.label+' · '+c.id.slice(-6),c.id)));
   if(!options.some(c=>c.id===selected))selected=options[0]?.id||'';$('vocal-candidate-select').value=selected;
   paint();
  }catch(e){if(getProject()?.id===id){error=e.message;paint();}}finally{loading=false;}
 }
 async function create(force_new){if(starting||active())return;starting=true;error='';paint();
  const id=getProject().id;
  try{if(!await settle()||getProject().id!==id)return;const p=getProject();job=await request('/api/vocals/jobs',{request_id:crypto.randomUUID(),project_id:id,revision:p.revision,preset_id:$('vocal-preset').value,force_new});await refresh(true);}
  catch(e){if(getProject()?.id===id)error=e.message;}finally{starting=false;paint();}
 }
 async function switchVoice(variant){if(applying)return;applying=true;error='';window.pauseVocalPreview();paint();try{await apply(variant);await refresh(true);}catch(e){error=e.message;}finally{applying=false;paint();}}
 $('create-vocal-candidate').onclick=()=>create(false);$('resing-vocal').onclick=()=>create(true);
 $('apply-vocal-candidate').onclick=()=>{if(selected)switchVoice(selected);};$('restore-vocal-original').onclick=()=>switchVoice('original');
 $('vocal-candidate-select').onchange=async e=>{window.pauseVocalPreview();audio.removeAttribute('src');selected=e.target.value;const id=projectId;const c=(await request('/api/vocals/project/'+id)).candidates.find(c=>c.id===selected);if(getProject().id!==id)return;if(c)job=await request('/api/vocals/jobs/'+c.job_id);paint();};
 function audition(){if(job?.stage!=='ready')return;const at=audio.currentTime||0;cancel();const serial=previewSerial,id=projectId,key=$('vocal-preview-kind').value,url=job.files[key];audio.pause();
  if(audio.getAttribute('src')!==url){audio.src=url;audio.load();}
  const play=()=>{metadataHandler=null;if(serial!==previewSerial||getProject().id!==id)return;audio.currentTime=Math.min(at,Math.max(0,audio.duration-.1));audio.play().catch(e=>{if(serial!==previewSerial||e.name==='AbortError')return;error=e.message;paint();});};
  if(audio.readyState>=1)play();else{metadataHandler=play;audio.addEventListener('loadedmetadata',play,{once:true});}
 }
 $('vocal-preview-play').onclick=audition;$('vocal-preview-kind').onchange=()=>{if(audio.hasAttribute('src'))audition();};
 audio.onplay=()=>{transport.pause();window.pauseScorePreview?.();window.pauseGenerationPreview?.();};
 window.refreshVocalCandidates=()=>refresh(true);
 setInterval(()=>{if(projectId!==getProject()?.id||active())refresh();else paint();},1500);refresh(true);
}
