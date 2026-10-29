const el=id=>document.getElementById(id);
export async function initializeGeneration({getProject,activate,stopEditor,transport}){
  let job=null,pollTimer=null,lastSource='',autoContext=null,activeRequest=null,submitting=false,legacyId=null;
  const player=el('generation-audio');
  const mixPlayer=el('generation-mix-player');let seeking=false,playRequest=0;
  const voiceTemplates={
    'lyrical-male':'温暖醇厚的成年男声，主歌轻柔叙述，副歌舒展有力量，普通话自然清楚',
    'clear-female':'清亮自然的女声，音色明亮但不过分尖细，主歌轻盈，副歌舒展，普通话吐字清楚',
    'magnetic-male':'低沉磁性的成年男声，略带颗粒感，主歌贴近叙述，副歌有力量，普通话自然，避免过度播音腔'
  };
  try{const saved=localStorage.getItem('musicVoiceDescriptionDraft');if(saved)el('generation-voice').value=saved;}catch{}
  function saveVoice(){try{localStorage.setItem('musicVoiceDescriptionDraft',el('generation-voice').value);}catch{}}
  el('generation-voice-template').onchange=e=>{if(voiceTemplates[e.target.value]){el('generation-voice').value=voiceTemplates[e.target.value];saveVoice();}};
  el('generation-voice').oninput=()=>{el('generation-voice-template').value='custom';saveVoice();};
  const clock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}`;
  try{autoContext=JSON.parse(localStorage.getItem('musicPendingAuto')||'null');activeRequest=JSON.parse(localStorage.getItem('musicPendingRequest')||'null');}catch{}
  Object.defineProperty(window,'generationWorkflowState',{get:()=>{const state=transport.state(),same=state.projectId===job?.project_id;
    const preview={currentTime:player.currentTime,paused:player.paused,source:player.dataset.source||null,error:player.error?.message||null};
    return {job,autoContext,player:job?.project_ready?{currentTime:same?state.currentTime:0,paused:!same||!state.playing,source:'shared_mix',error:null}:preview,previewPlayer:preview};}});
  async function request(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();
    if(!r.ok){const e=Error(value.error||`HTTP ${r.status}`);e.status=r.status;throw e;}return value;}
  function message(text,error=false){el('generation-message').textContent=text;el('generation-message').className=error?'error':'';}
  function buttons(){const active=job&&!['ready','error'].includes(job.stage);el('generate-song').disabled=submitting||active||!!activeRequest;
    el('import-existing').disabled=submitting||active||!el('existing-song').value;el('open-legacy').disabled=submitting;}
  function clearAuto(){autoContext=null;localStorage.removeItem('musicPendingAuto');}
  async function list(){const result=await request('/api/generation/jobs');legacyId=result.legacy_project_id;
    const select=el('recent-job');select.replaceChildren(new Option('选择最近的歌曲',''),...result.jobs.map(j=>new Option(j.title+(j.stage==='ready'?' · 可编辑':j.stage==='error'?' · 待重试':' · 处理中'),j.id)));
    if(job)select.value=job.id;return result.jobs;}
  function source(kind){if(!job)return;const url=`/api/generation/media/${job.id}/${kind}`;
    if(lastSource!==url){player.pause();player.src=url;player.dataset.source=kind;lastSource=url;player.hidden=false;}}
  async function play(at){const requestId=++playRequest,expectedJob=job;try{
      if(expectedJob?.project_ready){await transport.play(expectedJob.project_id,at,()=>requestId===playRequest&&job?.id===expectedJob.id);
        if(requestId!==playRequest||job?.id!==expectedJob.id)return;
        player.pause();player.hidden=true;mixPlayer.hidden=false;
        message('当前歌曲已连接分轨混音，播放时可用下方开关即时控制声部。');}
      else{transport.volume(player.muted?0:player.volume);void transport.unlock().catch(()=>{});await player.play();message('正在试听生成的歌曲，分轨准备完成后可边听边调整声部。');}
    }catch(e){if(requestId===playRequest)message(e.message||'歌曲已可试听，请点击播放器播放。',true);}}
  async function open(auto=false){if(!job?.project_ready)return;
    if(auto&&(!autoContext||autoContext.job_id!==job.id))return;
    const current=getProject();
    if(current.id===job.project_id){clearAuto();return;}
    if(auto&&(current.id!==autoContext.project_id||current.revision!==autoContext.revision)){
      clearAuto();message('新歌工程已准备好。当前工程有新修改，点击“打开歌曲工程”再切换。');return;}
    try{await activate(job.project_id,{preservePreview:auto});clearAuto();message('新歌已进入下方工程，可以用对话或手动调整后导出。');}
    catch(e){clearAuto();message(e.message,true);}
  }
  async function render(){if(!job)return;const renderingId=job.id;el('generation-progress').hidden=false;
    const option=Array.from(el('recent-job').options).find(o=>o.value===job.id);
    if(option)option.textContent=job.title+(job.stage==='ready'?' · 可编辑':job.stage==='error'?' · 待重试':' · 处理中');
    const labels={lyrics:'正在根据创作要求写词…',generating:'歌曲正在生成，可试听后即可播放。',separating:'完整歌曲已取得，正在分离人声、鼓、贝斯和伴奏…',ready:'歌曲工程已准备好，可在下方编辑。',error:job.pipeline_error||job.error||'当前步骤未完成，可重试。'};
    el('generation-status').textContent=`${job.title} · ${labels[job.stage]||'处理中'} · ${job.elapsed_seconds??0} 秒`;
    const duration=job.duration_check,actual=duration?.actual_seconds;
    el('generation-duration').textContent=duration?.status==='pending'?'目标时长 2分30秒–3分30秒，完成后核验实际音频。':
      `歌曲时长 ${clock(actual)}（${Number(actual).toFixed(1)} 秒） · ${duration?.status==='pass'?'符合目标区间':'未达到 150–210 秒目标，可继续试听与编辑'}${duration?.measurement==='decoded_audio_frames'?' · 已按音频核验':' · 平台报告，待音频核验'}`;
    el('generation-duration').className=duration?.status==='outside_target'?'error':'';
    const seconds=n=>Number.isFinite(n)?`${Number(n).toFixed(1)}秒`:'待测';
    el('generation-timings').textContent=`从提交起：首次实际播放 ${seconds(job.first_play_seconds)} · 整曲生成完成 ${seconds(job.done_seconds)} · 成品文件就绪 ${seconds(job.complete_file_seconds)} · 工程可编辑 ${seconds(job.ready_seconds)}；分轨准备耗时 ${seconds(job.stem_preparation_seconds)}`;
    const order=['lyrics','generating','separating','ready'];for(const step of document.querySelectorAll('#generation-steps span')){
      step.classList.toggle('active',step.dataset.stage===job.stage);step.classList.toggle('done',order.indexOf(step.dataset.stage)<order.indexOf(job.stage));}
    el('generated-title').textContent=job.title;el('generated-lyrics').textContent=job.lyrics||(job.origin==='existing_audio'?'使用已有成品，无需重新写词。':'正在生成原创歌词…');el('generated-prompt').textContent=job.prompt||'';
    el('generated-voice-description').textContent=job.voice?`这首歌的生成人声要求：${job.voice}${job.voice_excerpt_accepted?' · 已试听片段的人声满足首版展示要求':''}`:'';
    el('open-generated-project').hidden=!job.project_ready;el('retry-generation').hidden=!(job.can_resume||activeRequest);
    el('play-generated').hidden=!(job.stream_available||job.download_ready);el('play-generated-complete').hidden=!job.download_ready;
    el('play-generated').textContent=job.download_ready?'试听完整歌曲':'播放生成中的歌曲';
    mixPlayer.hidden=!job.project_ready;
    if(!job.project_ready&&!lastSource){
      if(job.download_ready)source('complete');
      else if(job.stream_available){source('stream');if(el('generation-autoplay').checked)await play();}
    }
    buttons();if(job.project_ready){
      // Keep a running preview audible while stems load, then hand off once
      // to the shared editor clock. Never continue a hidden full-mix player.
      await open(true);
      if(job?.id!==renderingId)return;
      if(!player.paused&&getProject().id===job.project_id)await play(player.currentTime);
      else if(!player.paused){player.pause();message('分轨已准备好，点击播放即可切到这首歌的可编辑混音。');}
      player.hidden=true;
    }
    paintMixPlayer();
  }
  function schedule(){clearTimeout(pollTimer);if(job&&!['ready','error'].includes(job.stage))pollTimer=setTimeout(poll,2000);}
  async function poll(){if(!job)return;const id=job.id;try{const updated=await request('/api/generation/jobs/'+id);if(job?.id!==id)return;
      job=updated;await render();if(['ready','error'].includes(job.stage))await list();}
    catch(e){message('状态连接暂时中断，正在重连已有任务。',true);}finally{schedule();}}
  async function submit(body,kind){submitting=true;buttons();message(kind==='import'?'正在为已有成品建立工程…':'正在提交创作要求…');
    try{job=await request(kind==='import'?'/api/generation/import':'/api/generation/jobs',body);
      activeRequest=null;localStorage.removeItem('musicPendingRequest');localStorage.setItem('musicActiveJob',job.id);
      lastSource='';player.pause();player.removeAttribute('src');player.hidden=true;await list();await render();schedule();
    }catch(e){if(e.status&&e.status<500){activeRequest=null;localStorage.removeItem('musicPendingRequest');clearAuto();}
      message(e.message+(activeRequest?'；可重试同一请求，不会自动新建第二首。':''),true);el('retry-generation').hidden=!activeRequest;
      if(activeRequest)el('generation-progress').hidden=false;
    }finally{submitting=false;buttons();}}
  function intent(kind){const request_id=crypto.randomUUID();const current=getProject();
    autoContext={job_id:request_id,project_id:current.id,revision:current.revision};localStorage.setItem('musicPendingAuto',JSON.stringify(autoContext));
    const body=kind==='import'?{request_id,source_key:el('existing-song').value}:{request_id,brief:el('generation-brief').value,style:el('generation-style').value,voice:el('generation-voice').value};
    activeRequest={kind,body};localStorage.setItem('musicPendingRequest',JSON.stringify(activeRequest));return submit(body,kind);}
  el('generation-form').onsubmit=e=>{e.preventDefault();if(!el('generate-song').disabled)intent('generate');};
  el('import-existing').onclick=()=>intent('import');el('existing-song').onchange=buttons;
  el('play-generated').onclick=()=>{if(!job.project_ready){if(job.download_ready&&player.paused)source('complete');else if(!lastSource)source(job.stream_available?'stream':'complete');}play();};
  el('play-generated-complete').onclick=()=>{if(!job.project_ready)source('complete');play();};el('open-generated-project').onclick=()=>open();
  el('generation-mix-play').onclick=()=>{const state=transport.state();if(state.projectId===job?.project_id&&state.playing){playRequest++;transport.pause();}else play();};
  el('generation-mix-seek').oninput=()=>{seeking=true;el('generation-mix-clock').textContent=`${clock(Number(el('generation-mix-seek').value))} / ${clock(Number(el('generation-mix-seek').max))}`;};
  el('generation-mix-seek').onchange=async()=>{try{await transport.seek(job.project_id,Number(el('generation-mix-seek').value));}catch(e){message(e.message,true);}finally{seeking=false;paintMixPlayer();}};
  el('generation-mix-volume').oninput=e=>transport.volume(Number(e.target.value));
  function paintMixPlayer(){if(job?.project_ready&&!mixPlayer.hidden){const state=transport.state(),same=state.projectId===job.project_id;
      const time=same?state.currentTime:0,duration=same?state.duration:(job.duration_seconds||Number(el('generation-mix-seek').max)||0);
      el('generation-mix-play').textContent=same&&state.playing?'暂停':'播放';
      if(!seeking){el('generation-mix-seek').max=duration;el('generation-mix-seek').value=time;el('generation-mix-clock').textContent=`${clock(time)} / ${clock(duration)}`;}
      el('generation-mix-volume').value=state.volume;
    }}
  function syncMixPlayer(){paintMixPlayer();requestAnimationFrame(syncMixPlayer);}
  syncMixPlayer();
  el('retry-generation').onclick=async()=>{if(activeRequest)return submit(activeRequest.body,activeRequest.kind);
    try{job=await request(`/api/generation/jobs/${job.id}/resume`,{});await render();schedule();}catch(e){message(e.message,true);}};
  el('open-legacy').onclick=async()=>{playRequest++;try{await activate(legacyId);clearAuto();message('已返回原试听工程。');}catch(e){message(e.message,true);}};
  el('recent-job').onchange=async e=>{if(!e.target.value)return;const id=e.target.value;playRequest++;clearAuto();player.pause();stopEditor();message('');lastSource='';player.removeAttribute('src');
    try{const selected=await request('/api/generation/jobs/'+id);if(el('recent-job').value!==id)return;
      job=selected;localStorage.setItem('musicActiveJob',job.id);await render();schedule();}catch(e){message(e.message,true);}};
  let lastTick=-10;
  for(const kind of ['playing','waiting','stalled','ended','error','pause','timeupdate'])player.addEventListener(kind,()=>{
    if(!job)return;if(kind==='playing'&&!job.project_ready)stopEditor();if(kind==='timeupdate'){if(player.currentTime-lastTick<5)return;lastTick=player.currentTime;}
    request(`/api/generation/jobs/${job.id}/telemetry`,{event:kind,current_time:player.currentTime,source:player.dataset.source}).catch(()=>{});
  });
  player.addEventListener('play',()=>{transport.volume(player.muted?0:player.volume);
    if(job?.project_ready){const at=player.currentTime;player.pause();void play(at);}else void transport.unlock().catch(()=>{});});
  player.addEventListener('volumechange',()=>{if(job&&!job.project_ready)transport.volume(player.muted?0:player.volume);});
  window.pauseGenerationPreview=()=>player.pause();
  window.syncGenerationTransport=paintMixPlayer;
  window.activeGenerationPreview=()=>job&&!job.project_ready&&!player.paused?{jobId:job.id,stage:job.stage}:null;
  window.handoffReadyGenerationPreview=()=>{if(job?.project_ready&&!player.paused)void play(player.currentTime);};
  try{
    const [all,sources]=await Promise.all([list(),request('/api/generation/sources')]);
    el('existing-song').replaceChildren(...sources.sources.map(s=>new Option(s.title,s.key)));
    const remembered=localStorage.getItem('musicActiveJob');job=all.find(j=>!['ready','error'].includes(j.stage))||
      all.find(j=>j.project_id===getProject().id)||all.find(j=>j.id===remembered)||all[0]||null;
    if(activeRequest){const existing=all.find(j=>j.id===activeRequest.body.request_id);if(existing){job=existing;activeRequest=null;localStorage.removeItem('musicPendingRequest');}}
    if(job){el('recent-job').value=job.id;await render();schedule();}else if(activeRequest){el('generation-progress').hidden=false;el('retry-generation').hidden=false;message('上次提交结果未确认，可安全重试同一请求。');}
  }catch(e){message('暂未读取到生成服务：'+e.message,true);}buttons();
}
