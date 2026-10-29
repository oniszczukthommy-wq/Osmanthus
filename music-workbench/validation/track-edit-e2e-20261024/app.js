import { initializeGeneration } from './generation.js';
import { initializeLyrics } from './lyrics.js';
import { initializeScore } from './score.js';
import { initializeVocals } from './vocals.js';
import { initializeVoiceLibrary } from './voice-library.js';
import { initializeConversions } from './svc.js';
import { initializeSections } from './sections.js';
import { initializeCandidateReview } from './candidate_review.js';
const $ = (id) => document.getElementById(id);
let project=null, busy=true, audioContext=null, position=0, began=0, playing=false, nodes=[], playUntil=0;
let original=null, mode='mix', selected=new URLSearchParams(location.search).get('track')||'bass', selection=[30,45], lastExport=null;
let outputGain=null,playbackVolume=1;
let instrumentStatus=null, instrumentPolling=false;
let arrangementJob=null,arrangementProject=null,arrangementPolling=false,arrangementStarting=false,arrangementError='',candidateId=null;
let chatPending=false;
let candidateReview=null;
const pendingSwitches=new Map(),switchWaiters=[];
let switchSyncing=false,switchSequence=0,switchFailure=null,confirmedMix=null;
const buffers=new Map(), telemetry={events:[],audioErrors:[]};
const clock=(n)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${(n%60).toFixed(1).padStart(4,'0')}`;
const liveTime=()=>playing?Math.min(playUntil,position+audioContext.currentTime-began):position;
Object.defineProperty(window,'trackEditorState',{get:()=>({project,selection:{track_id:selected,start_seconds:selection[0],end_seconds:selection[1]},
  audioReady:!busy&&!!original&&project?.tracks.every(t=>buffers.get(t.id)?.key===t.audio_key),isPlaying:playing,currentTime:liveTime(),listenMode:mode,lastExport,telemetry,
  pendingTrackSwitches:pendingSwitches.size,switchSyncing,arrangementJob})});
Object.defineProperty(window,'trackEditorBuffers',{get:()=>({tracks:Object.fromEntries(buffers),original})});
function notice(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';}
function event(type,extra={}){telemetry.events.push({type,time:Date.now(),position:liveTime(),...extra});}
async function api(path,body){const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const result=await response.json();if(!response.ok){const error=Error(result.error||`HTTP ${response.status}`);error.status=response.status;throw error;}return result;}
function context(){if(!audioContext){audioContext=new AudioContext({sampleRate:project?.sample_rate||44100});
    outputGain=audioContext.createGain();outputGain.gain.value=playbackVolume;outputGain.connect(audioContext.destination);}return audioContext;}
async function decode(url){const response=await fetch(url);if(!response.ok)throw Error('音轨载入失败');return context().decodeAudioData(await response.arrayBuffer());}
function setBusy(value){busy=value;for(const id of ['play','stop','play-selection','apply-gain','mute-selection','restore-selection','send','export-wav','export-mp3'])$(id).disabled=value;
  $('remove-track').disabled=value||!project||project.tracks.length<=1;
  $('undo').disabled=value||!project?.can_undo;$('redo').disabled=value||!project?.can_redo;
  $('add-piano').disabled=value||!project?.piano_available||project?.piano_added;
  $('add-piano').textContent=project?.piano_added?'钢琴估计轨已加入':project?.removed_track_ids?.includes('piano')?'＋ 恢复钢琴估计轨':project?.piano_available?'＋ 加入钢琴分离候选':'钢琴候选待提取';
  $('add-guitar').disabled=value||!project?.guitar_available||project?.guitar_added;
  $('add-guitar').textContent=project?.guitar_added?'吉他估计轨已加入':project?.removed_track_ids?.includes('guitar')?'＋ 恢复吉他估计轨':project?.guitar_available?'＋ 加入吉他分离候选':'吉他候选待提取';
  paintArrangementUI();
  const stage=instrumentStatus?.projectId===project?.id?instrumentStatus.stage:null;
  const prepared=project?.piano_available&&project?.guitar_available;
  $('prepare-instruments').disabled=value||prepared||stage==='separating';
  $('prepare-instruments').textContent=prepared?'器乐候选已提取':stage==='separating'?'正在提取器乐候选…':'提取钢琴 / 吉他候选';
  $('instrument-status').textContent=prepared?'钢琴、吉他分离候选已准备。模型固定输出这些声部，并不证明原曲含有这些乐器；尚未可靠确认，请试听核对。':stage==='separating'?'正在本机提取目标乐器的分离候选；此操作不确认原曲是否存在对应乐器。可继续编辑已有轨道。':
    instrumentStatus?.projectId===project?.id&&instrumentStatus.error?instrumentStatus.error:'原曲乐器尚未确认。可提取目标声部候选试听；没有可靠依据时保留其他伴奏，不自动加入乐器轨。';
  $('piano-cleanup').disabled=value;
  for(const el of document.querySelectorAll('.track button,.track input'))el.disabled=value;
  $('send').disabled=value||chatPending;
  $('ready').textContent=value?'正在处理…':'工程已就绪';}
function stop(reset=false){if(playing)position=liveTime();playing=false;
  for(const node of nodes){try{node.source.stop();}catch{}node.source.disconnect();node.gain.disconnect();node.analyser.disconnect();}nodes=[];
  if(reset)position=0;$('play').textContent='播放';event(reset?'stop':'pause');window.syncGenerationTransport?.();}
async function play(start=position,end=project.duration,shouldPlay=()=>true){
  window.pauseCandidatePreview?.();
  window.pauseVoiceLibraryPreview?.();
  window.pauseVocalPreview?.();
  window.pauseScorePreview?.();
  const ctx=context();await ctx.resume();if(ctx.state!=='running')throw Error('请点击播放按钮以启用音频');
  if(!shouldPlay())return;
  window.pauseGenerationPreview?.();
  stop();
  position=Math.max(0,Math.min(start,project.duration));if(position>=end)position=0;
  const startAt=ctx.currentTime+.035;began=startAt;playUntil=end;
  const candidates=mode==='original'?[{id:'original',gain:1,buffer:original}]:project.tracks.map(t=>{
    const hasSolo=project.tracks.some(x=>x.solo);return{id:t.id,buffer:buffers.get(t.id).buffer,
      gain:t.muted||(hasSolo&&!t.solo)?0:10**(t.gain_db/20)*project.master_gain};});
  for(const item of candidates){const source=ctx.createBufferSource(),gain=ctx.createGain(),analyser=ctx.createAnalyser();source.buffer=item.buffer;
    analyser.fftSize=2048;gain.gain.value=item.gain;source.connect(gain).connect(analyser).connect(outputGain);
    source.start(startAt,position,end-position);nodes.push({source,gain,analyser,id:item.id,targetGain:item.gain});}
  playing=true;$('play').textContent='暂停';event('play',{mode,end,contextState:ctx.state,sourceCount:nodes.length,
    audibleTracks:candidates.filter(t=>t.gain>0).map(t=>t.id)});
  window.syncGenerationTransport?.();
}
window.trackEditorAudioProbe=()=>({contextState:audioContext?.state,playing,currentTime:liveTime(),tracks:nodes.map(n=>{
  const samples=new Float32Array(n.analyser.fftSize);n.analyser.getFloatTimeDomainData(samples);
  let power=0;for(const value of samples)power+=value*value;
  return {id:n.id,gain:n.gain.gain.value,targetGain:n.targetGain,rms:Math.sqrt(power/samples.length),bufferMatchesProject:n.source.buffer===(n.id==='original'?original:buffers.get(n.id)?.buffer)};})});
function visibleSegments(edits){let visible=[];
  for(const edit of edits){const a=edit.start_frame,b=edit.end_frame,next=[];
    for(const old of visible){if(old.end_frame<=a||old.start_frame>=b)next.push(old);else{
      if(old.start_frame<a)next.push({...old,end_frame:a});if(old.end_frame>b)next.push({...old,start_frame:b});}}
    if(edit.gain!==1)next.push(edit);visible=next;
  }return visible.sort((a,b)=>a.start_frame-b.start_frame);
}
function enabledTrack(t){return !t.muted&&(!project.tracks.some(x=>x.solo)||t.solo);}
function mixControls(){return {id:project.id,revision:project.revision,fingerprint:project.fingerprint,
  tracks:Object.fromEntries(project.tracks.map(t=>[t.id,{segments:t.segments,gain_db:t.gain_db,muted:t.muted,solo:t.solo}])),
  history:project.history,can_undo:project.can_undo,can_redo:project.can_redo};}
function mergeControls(c){project={...project,revision:c.revision,fingerprint:c.fingerprint,history:c.history,can_undo:c.can_undo,can_redo:c.can_redo,
  tracks:project.tracks.map(t=>({...t,...c.tracks[t.id]}))};}
function switchIntent(id,enabled){
  if(project.tracks.some(t=>t.solo))for(const t of project.tracks){t.muted=t.muted||!t.solo;t.solo=false;}
  const t=project.tracks.find(t=>t.id===id);if(t)t.muted=!enabled;
}
function paintSwitches(){
  for(const t of project.tracks){const enabled=enabledTrack(t),row=document.querySelector(`.track[data-id="${t.id}"]`),button=row?.querySelector('.track-name');
    if(button&&button.getAttribute('aria-pressed')!==String(enabled)){
      button.setAttribute('aria-pressed',enabled);button.title=`点击${enabled?'关闭':'开启'}${t.label}声音`;
      button.querySelector('.track-status').textContent=enabled?'已开启':'已关闭';
      row.classList.toggle('is-enabled',enabled);row.classList.toggle('is-disabled',!enabled);}
    if(playing&&mode==='mix'){const node=nodes.find(n=>n.id===t.id),gain=enabled?10**(t.gain_db/20)*project.master_gain:0;
      if(node&&node.targetGain!==gain){node.gain.gain.cancelScheduledValues(audioContext.currentTime);
        node.gain.gain.setTargetAtTime(gain,audioContext.currentTime,.005);node.targetGain=gain;}}
  }
}
function updateMixHistory(){
  $('undo').disabled=busy||!project.can_undo;$('redo').disabled=busy||!project.can_redo;
  $('project-info').textContent=`工程 ${project.id} · 版本 ${project.revision} · 状态 ${project.fingerprint.slice(0,12)}`;
  $('history').replaceChildren(...project.history.map(h=>{const li=document.createElement('li');li.className=h.applied?'':'pending';li.textContent=`${h.origin==='dialogue'?'对话':'手动'}：${h.label}`;return li;}));
}
function toggleTrack(id){if(busy)return;const started=performance.now(),t=project.tracks.find(t=>t.id===id);if(!t)return;
  const preview=window.activeGenerationPreview?.();
  if(preview){notice('正在试听的歌曲还在准备分轨，准备完成后即可边听边调整这首歌的声部。');return;}
  if(!switchSyncing&&!pendingSwitches.size)confirmedMix=mixControls();
  switchFailure=null;const enabled=!enabledTrack(t);pendingSwitches.set(id,{enabled,sequence:++switchSequence});
  switchIntent(id,enabled);paintSwitches();$('downloads').replaceChildren();lastExport=null;
  window.handoffReadyGenerationPreview?.();
  if(mode==='original'){
    const resume=playing,at=liveTime(),until=playUntil;mode='mix';$('listen-mode').value=mode;
    if(resume)void play(at,until).catch(e=>notice(e.message,true));
  }
  event('track-switch-immediate',{track:id,enabled,responseMs:performance.now()-started,audibleTracks:project.tracks.filter(enabledTrack).map(t=>t.id)});
  void syncTrackSwitches();
}
async function syncTrackSwitches(){if(switchSyncing)return;switchSyncing=true;const id=project.id;
  try{while(pendingSwitches.size){const [track,intent]=pendingSwitches.entries().next().value;
      const result=await api('/api/track-switch',{project_id:id,revision:project.revision,track_id:track,enabled:intent.enabled});
      if(project.id!==id)throw Error('当前歌曲已切换，停止保存旧歌曲开关');
      confirmedMix=result.controls;
      if(pendingSwitches.get(track)?.sequence===intent.sequence)pendingSwitches.delete(track);
      mergeControls(result.controls);for(const [key,desired] of pendingSwitches)switchIntent(key,desired.enabled);
      paintSwitches();
    }
    updateMixHistory();event('track-switch-saved',{revision:project.revision});
  }catch(error){switchFailure=error;pendingSwitches.clear();
    try{const fresh=await api('/api/project');
      if(fresh.id!==project.id||fresh.tracks.some(t=>buffers.get(t.id)?.key!==t.audio_key))stop();
      await accept(fresh);paintSwitches();confirmedMix=mixControls();
    }catch{if(project.id===id&&confirmedMix){mergeControls(confirmedMix);paintSwitches();updateMixHistory();}}
    pendingSwitches.clear();switchFailure=error;
    notice('轨道开关未保存，请刷新后重试：'+error.message,true);
  }finally{switchSyncing=false;for(const waiter of switchWaiters.splice(0))switchFailure?waiter.reject(switchFailure):waiter.resolve();}
}
function flushTrackSwitches(){if(!switchSyncing&&!pendingSwitches.size)return switchFailure?Promise.reject(switchFailure):Promise.resolve();
  return new Promise((resolve,reject)=>switchWaiters.push({resolve,reject}));}
async function settleTrackSwitches(){try{await flushTrackSwitches();return true;}catch(e){notice(e.message,true);return false;}}
function selectedCandidate(){return project?.available_parts?.find(t=>t.id===candidateId)||project?.available_parts?.[0];}
const formatSeconds=n=>Number(n.toFixed(2));
function paintArrangementUI(){
  const candidates=(project?.available_parts||[]).filter(t=>!project.tracks.some(a=>a.id===t.id));
  const select=$('piano-candidate-select'),key=candidates.map(t=>t.id).join('|');
  if(select.dataset.key!==key){select.replaceChildren(...(candidates.length?candidates.map(t=>new Option(`${t.label} · ${t.range_seconds.map(formatSeconds).join('–')}秒`,t.id)):[new Option('暂无可加入候选','')]));select.dataset.key=key;}
  if(!candidates.some(t=>t.id===candidateId))candidateId=candidates[0]?.id||null;
  select.value=candidateId||'';select.disabled=!candidates.length;
  const part=selectedCandidate(),job=arrangementJob?.project_id===project?.id?arrangementJob:null;
  const running=job&&['queued','analyzing','rendering'].includes(job.stage);
  const source=project?.tracks.find(t=>t.id===selected);
  $('reorchestrate-guitar').disabled=busy||arrangementStarting||!!running||!source?.id.startsWith('piano_add_');
  $('add-arrangement-candidate').textContent=part?.operation==='reorchestrate'?'试听并决定替换（钢琴 → 木吉他）':'试听并决定加入';
  $('generate-piano-range').disabled=busy||arrangementStarting||!!running;$('generate-piano-full').disabled=busy||arrangementStarting||!!running;
  for(const id of ['add-piano-part','add-arrangement-candidate'])$(id).disabled=busy||!part;
  $('add-piano-part').hidden=!part;
  if(part)$('add-piano-part').textContent=`试听${part.operation==='reorchestrate'?'木吉他替换':'钢琴候选'} · ${part.range_seconds.map(formatSeconds).join('–')}秒`;
  const stages={queued:'等待本机编配',analyzing:'分析拍点与和声',rendering:'编写并渲染伴奏'};
  $('arrangement-status').textContent=arrangementError||(
    arrangementStarting?'正在提交本地伴奏任务…':running?`${stages[job.stage]} · ${formatSeconds(job.start_seconds)}–${formatSeconds(job.end_seconds)}秒 · ${job.elapsed_seconds}秒`:
    job?.stage==='ready'?`${job.reused_from?'已复用':'已生成'} ${job.note_count} 个音符的候选，请选择后加入试听。`:
    job?.error?job.error:'可使用当前选区，也可为整首歌曲生成钢琴伴奏候选。');
}
async function refreshArrangements(force=false){if(!project||arrangementPolling)return;
  if(!force&&arrangementProject===project.id&&!['queued','analyzing','rendering'].includes(arrangementJob?.stage))return;
  arrangementPolling=true;const id=project.id;
  try{const result=await api(`/api/arrangements/project/${id}`);if(project.id!==id)return;
    const becameReady=result.job?.stage==='ready'&&(arrangementJob?.id!==result.job.id||arrangementJob?.stage!=='ready');
    arrangementProject=id;arrangementJob=result.job;arrangementError='';
    project.available_parts=result.candidates.filter(t=>!project.tracks.some(a=>a.id===t.id));
    if(becameReady)candidateId=result.job.candidate.id;
    paintArrangementUI();
  }catch(e){if(project.id===id){arrangementError=e.message;paintArrangementUI();}}
  finally{arrangementPolling=false;}
}
async function createPiano(full,rearrange=false){if(busy||arrangementStarting)return;
  const id=project.id,start=full?0:selection[0],end=full?project.duration:selection[1];
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>project.duration||end-start<1){arrangementError='请选择歌曲内至少1秒的区间';paintArrangementUI();return;}
  arrangementStarting=true;arrangementError='';paintArrangementUI();
  try{if(!await settleTrackSwitches())return;if(project.id!==id)throw Error('歌曲已切换，请重新选择生成区间');
    const job=await api('/api/arrangements/jobs',{request_id:crypto.randomUUID(),project_id:id,revision:project.revision,start_seconds:start,end_seconds:end,...(rearrange?{operation:'reorchestrate',source_track_id:selected}:{})});
    if(project.id===id){arrangementJob=job;arrangementProject=id;if(job.candidate)candidateId=job.candidate.id;await refreshArrangements(true);}
  }catch(e){if(project.id===id)arrangementError=e.message;}
  finally{arrangementStarting=false;paintArrangementUI();}
}
$('reorchestrate-guitar').onclick=()=>createPiano(false,true);
$('generate-piano-range').onclick=()=>createPiano(false);$('generate-piano-full').onclick=()=>createPiano(true);
$('piano-candidate-select').onchange=e=>{window.pauseCandidatePreview?.();candidateId=e.target.value;paintArrangementUI();};
setInterval(refreshArrangements,1000);
function drawWave(canvas,track){const box=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;
  canvas.width=Math.max(1,Math.round(box.width*dpr));canvas.height=Math.round(85*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=box.width,h=85;
  ctx.strokeStyle='#252a35';ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  const peak=Math.max(.025,...track.peaks),step=w/track.peaks.length;ctx.fillStyle=track.color;
  track.peaks.forEach((v,i)=>{const height=Math.max(.5,v/peak*34);ctx.fillRect(i*step,h/2-height,Math.max(.6,step*.78),height*2);});
  const displayed=visibleSegments(track.segments);canvas.dataset.displayedSegments=JSON.stringify(displayed);
  for(const edit of displayed){const a=edit.start_frame/project.sample_rate/project.duration*w,b=edit.end_frame/project.sample_rate/project.duration*w;
    ctx.fillStyle=edit.gain===0?'#0b101acb':'#a8eed51c';ctx.fillRect(a,0,b-a,h);
    ctx.fillStyle='#e5f3ed';ctx.font='10px sans-serif';ctx.fillText(edit.gain===0?'静音':`${(20*Math.log10(edit.gain)).toFixed(0)} dB`,a+5,16);}
}
function updateSelection(){selection=[Number($('start').value),Number($('end').value)];selected=$('track-select').value;
  const piano=project.tracks.find(t=>t.id==='piano');const levels=project.piano_cleanup_levels||[];
  $('piano-cleanup-panel').hidden=selected!=='piano'||levels.length<2;
  $('piano-cleanup').replaceChildren(...levels.map(level=>new Option({'original':'原始分离','gentle':'轻度净化','strong':'较强净化'}[level],level)));
  $('piano-cleanup').value=piano?.cleanup||'original';
  for(const row of document.querySelectorAll('.track')){const isSelected=row.dataset.id===selected;row.classList.toggle('selected',isSelected);
    const overlay=row.querySelector('.selection');overlay.hidden=!isSelected;
    overlay.style.left=`${selection[0]/project.duration*100}%`;overlay.style.width=`${Math.max(0,selection[1]-selection[0])/project.duration*100}%`;}paintArrangementUI();}
function renderRuler(){
  if(!project)return;
  const scale=$('ruler-scale');const width=scale.clientWidth||700;
  const labelStep=width/project.duration*5>=44?5:(width/project.duration*10>=44?10:20);
  scale.replaceChildren();
  function tick(time,label,edge){const span=document.createElement('span');span.className='ruler-tick'+(label?' major':'')+(edge?' '+edge:'');
    span.style.left=`${time/project.duration*100}%`;if(label){const text=document.createElement('span');text.textContent=Number.isInteger(time)?clock(time).slice(0,-2):clock(time);span.append(text);}
    scale.append(span);}
  for(let time=0;time<project.duration;time+=5){const label=time%labelStep===0&&project.duration-time>labelStep*.65;tick(time,label,time===0?'first':'');}
  tick(project.duration,true,'last');
}
function attachSeekHandle(handle,wrap){let drag=null;
  const seconds=e=>Math.max(0,Math.min(project.duration,(e.clientX-wrap.getBoundingClientRect().left)/wrap.clientWidth*project.duration));
  handle.onpointerdown=e=>{if(busy)return;e.preventDefault();e.stopPropagation();drag={wasPlaying:playing,end:playUntil};stop();handle.setPointerCapture(e.pointerId);};
  handle.onpointermove=e=>{if(!drag)return;e.stopPropagation();position=seconds(e);};
  const endDrag=e=>{if(!drag)return;e.stopPropagation();position=seconds(e);const previous=drag;drag=null;
    event('playhead-drag',{target:position});if(previous.wasPlaying&&position<project.duration)play(position,previous.end>position?previous.end:project.duration).catch(e=>notice(e.message,true));};
  handle.onpointerup=endDrag;handle.onpointercancel=()=>{drag=null;};
  handle.onkeydown=e=>{let next=liveTime();if(e.key==='ArrowLeft')next-=e.shiftKey?5:1;else if(e.key==='ArrowRight')next+=e.shiftKey?5:1;
    else if(e.key==='Home')next=0;else if(e.key==='End')next=project.duration;else return;
    e.preventDefault();const resume=playing;stop();position=Math.max(0,Math.min(project.duration,next));
    if(resume&&position<project.duration)play().catch(e=>notice(e.message,true));};
}
function render(){
  $('song-title').textContent=project.title;
  $('separation-note').textContent=project.tracks.some(t=>t.generated)?'新增钢琴是新编伴奏候选，听感待验收；原钢琴、吉他为估计分轨，可能有串音，其他伴奏已扣除对应估计。':project.instrument_routing?.length?'独立器乐轨道由原歌曲估计分离，可能有串音或残留；其他伴奏持续扣除对应估计。移除声部后可撤销恢复。':'当前分为人声、鼓组、贝斯和其他伴奏。其他伴奏仍可能包含钢琴、吉他和弦乐。';
  $('duration').textContent=clock(project.duration);$('seek').max=project.duration;$('start').max=project.duration;$('end').max=project.duration;
  $('track-count').textContent=`${project.tracks.length} 条音轨 · 本地工程`;
  const order=['vocals','drums','bass','other','piano','guitar'];
  const rank=t=>order.includes(t.id)?order.indexOf(t.id):order.length;
  const ordered=[...project.tracks].sort((a,b)=>rank(a)-rank(b));
  if(!ordered.some(t=>t.id===selected))selected=ordered[0].id;
  $('track-select').replaceChildren(...ordered.map(t=>new Option(t.label,t.id)));$('track-select').value=selected;
  $('tracks').replaceChildren();
  const hasSolo=ordered.some(t=>t.solo);
  for(const track of ordered){const enabled=!track.muted&&(!hasSolo||track.solo);
    const row=document.createElement('div');row.className='track '+(enabled?'is-enabled':'is-disabled');row.dataset.id=track.id;row.style.setProperty('--track-color',track.color);
    row.innerHTML=`<div class="track-left"><button class="track-name" aria-label="${track.label}声音开关" aria-pressed="${enabled}" title="点击${enabled?'关闭':'开启'}${track.label}声音"><span class="dot"></span>${track.label}<span class="track-status">${enabled?'已开启':'已关闭'}</span></button><label>dB <input type="number" min="-60" max="6" step="1" value="${track.gain_db}" aria-label="${track.label}整轨音量dB"></label></div><div class="wave-wrap" role="group" aria-label="${track.label}波形，拖动选择时间"><canvas></canvas><div class="selection"></div><div class="playhead" role="slider" tabindex="0" aria-label="${track.label}播放游标" aria-valuemin="0" aria-valuemax="${project.duration}" aria-valuenow="${Math.max(0,liveTime())}"></div></div>`;
    const patch=(values)=>mutate('/api/edit',{command:{type:'track_mix',track_id:track.id,...values}},'已修改轨道混音设置');
    row.querySelector('.track-name').onclick=()=>toggleTrack(track.id);
    row.querySelector('input').onchange=e=>patch({gain_db:Number(e.target.value)});
    const wrap=row.querySelector('.wave-wrap');let dragStart=null;
    const seconds=e=>Math.max(0,Math.min(project.duration,(e.clientX-wrap.getBoundingClientRect().left)/wrap.clientWidth*project.duration));
    wrap.onpointerdown=e=>{if(busy||e.target.closest('.playhead'))return;dragStart=seconds(e);wrap.setPointerCapture(e.pointerId);$('track-select').value=track.id;};
    wrap.onpointermove=e=>{if(dragStart===null)return;const end=seconds(e);$('start').value=Math.min(dragStart,end).toFixed(2);$('end').value=Math.max(dragStart,end).toFixed(2);updateSelection();};
    wrap.onpointerup=e=>{if(dragStart===null)return;const end=seconds(e);if(Math.abs(end-dragStart)<.1){stop();position=end;}else{
      $('start').value=Math.min(dragStart,end).toFixed(2);$('end').value=Math.max(dragStart,end).toFixed(2);}dragStart=null;updateSelection();};
    wrap.onpointercancel=()=>{dragStart=null;};attachSeekHandle(row.querySelector('.playhead'),wrap);$('tracks').append(row);drawWave(row.querySelector('canvas'),track);
  }
  $('project-info').textContent=`工程 ${project.id} · 版本 ${project.revision} · 状态 ${project.fingerprint.slice(0,12)}`;
  $('history').replaceChildren(...project.history.map(h=>{const li=document.createElement('li');li.className=h.applied?'':'pending';li.textContent=`${h.origin==='dialogue'?'对话':'手动'}：${h.label}`;return li;}));
  updateSelection();renderRuler();setBusy(busy);
}
async function accept(next){const old=project;
  const newOriginal=next.id!==old?.id||!original?decode(next.original_audio_url):Promise.resolve(original);
  const loaded=await Promise.all(next.tracks.map(async t=>{
    if(buffers.get(t.id)?.key===t.audio_key)return [t.id,buffers.get(t.id)];
    return [t.id,{key:t.audio_key,buffer:await decode(t.audio_url)}];}));
  // Publish metadata and playback buffers together, only after every changed
  // track decoded. A failed download must never mix revisions in playback.
  const decodedOriginal=await newOriginal;
  for(const [id,item] of loaded)buffers.set(id,item);project=next;original=decodedOriginal;
  if(old?.id!==next.id){stop(true);selected='bass';mode='mix';$('listen-mode').value=mode;$('messages').replaceChildren();
    arrangementJob=null;arrangementProject=null;arrangementError='';candidateId=null;
    $('start').value=next.duration>45?30:0;$('end').value=Math.min(45,next.duration);}
  for(const id of buffers.keys())if(!next.tracks.some(t=>t.id===id))buffers.delete(id);
  // Export links are revision-specific; never present an old mix as the current export.
  if(old?.fingerprint!==next.fingerprint){$('downloads').replaceChildren();lastExport=null;}
  render();
}
async function mutate(path,body={},success='已更新工程',{preservePlayback=false}={}){
  if(busy||!await settleTrackSwitches()||busy)return;const resume=preservePlayback&&playing,from=liveTime(),until=playUntil;
  const liveGains=resume&&mode==='mix'&&nodes.every(n=>project.tracks.some(t=>t.id===n.id));
  const previousKeys=new Map(project.tracks.map(t=>[t.id,t.audio_key]));
  window.pauseGenerationPreview?.();if(!liveGains)stop();setBusy(true);notice('正在更新工程…');const started=performance.now();
  try{const result=await api(path,{...body,revision:project.revision,project_id:project.id});
    if(result.command){if(result.command.track_id)selected=result.command.track_id;
      if(Number.isFinite(result.command.start_seconds)&&Number.isFinite(result.command.end_seconds)){$('start').value=result.command.start_seconds;$('end').value=result.command.end_seconds;}}
    await accept(result.project);
    const audioChanged=project.tracks.some(t=>previousKeys.get(t.id)!==t.audio_key)||project.tracks.length!==previousKeys.size;
    if(liveGains&&playing&&audioChanged){const at=liveTime();stop();if(at<until)await play(at,until);event('source-switch',{at,uninterruptedClock:true});}
    else if(liveGains&&playing){const hasSolo=project.tracks.some(t=>t.solo),audible=[];
      for(const node of nodes){const t=project.tracks.find(t=>t.id===node.id);
        const gain=t&&!t.muted&&(!hasSolo||t.solo)?10**(t.gain_db/20)*project.master_gain:0;
        node.gain.gain.cancelScheduledValues(audioContext.currentTime);node.gain.gain.setTargetAtTime(gain,audioContext.currentTime,.005);
        node.targetGain=gain;
        if(gain>0)audible.push(node.id);}
      event('mix-switch',{audibleTracks:audible,uninterrupted:true});
    }else if(resume&&!liveGains&&from<until)await play(from,until);
    event('edit',{path,revision:project.revision,fingerprint:project.fingerprint,elapsedMs:performance.now()-started,applied:result.applied??true});
    notice(result.message||success);return result;
  }catch(error){notice(error.message,true);if(error.message.includes('工程已变化'))await accept(await api('/api/project'));}
  finally{setBusy(false);}
}
function segment(mode,db){return mutate('/api/edit',{command:{type:'segment_gain',track_id:selected,start_seconds:selection[0],end_seconds:selection[1],mode,gain_db:db}},'片段修改已写入工程，可以试听或撤销。');}
$('apply-gain').onclick=()=>segment('gain',Number($('segment-db').value));$('mute-selection').onclick=()=>segment('mute',0);$('restore-selection').onclick=()=>segment('restore',0);
$('remove-track').onclick=()=>mutate('/api/edit',{command:{type:'remove_track',track_id:selected}},'所选轨道已移除，可点击撤销恢复。',{preservePlayback:true});
$('add-piano').onclick=async()=>{const result=await mutate('/api/edit',{command:{type:'add_piano'}},'已加入钢琴分离候选；原曲是否确实含钢琴仍待试听确认，候选可能含串音。');
  if(result){selected='piano';render();}};
$('add-guitar').onclick=async()=>{const result=await mutate('/api/edit',{command:{type:'add_instrument',track_id:'guitar'}},'已加入吉他分离候选；原曲是否确实含吉他仍待试听确认，可撤销。');
  if(result){selected='guitar';render();}};
async function addPianoCandidate(){const part=selectedCandidate();if(!part)return;
  await candidateReview?.open({kind:'arrangement',candidate_id:part.id,range_seconds:part.range_seconds});}
$('add-piano-part').onclick=addPianoCandidate;$('add-arrangement-candidate').onclick=addPianoCandidate;
$('prepare-instruments').onclick=async()=>{if(busy||!await settleTrackSwitches()||busy)return;setBusy(true);
  try{const id=project.id;const state=await api('/api/instruments/prepare',{project_id:id,revision:project.revision});
    instrumentStatus={...state,projectId:id};notice('器乐分轨准备已启动，不影响已有修改。');}
  catch(e){notice(e.message,true);}finally{setBusy(false);refreshInstruments();}};
async function refreshInstruments(){if(!project||instrumentPolling||(project.piano_available&&project.guitar_available))return;instrumentPolling=true;const id=project.id;
  try{const state=await api(`/api/instruments/${id}`);if(project.id!==id)return;
    instrumentStatus={...state,projectId:id};setBusy(busy);
    if(state.stage==='ready'&&(!project.piano_available||!project.guitar_available)&&!busy){
      await mutate('/api/instruments/load',{},'钢琴和吉他估计分轨已准备。点击对应按钮加入工程，再试听判断分离质量。');}}
  catch(e){if(project.id===id){instrumentStatus={projectId:id,stage:'error',error:e.message};setBusy(busy);}}
  finally{instrumentPolling=false;}}
setInterval(refreshInstruments,3000);
$('piano-cleanup').onchange=e=>mutate('/api/edit',{command:{type:'piano_cleanup',track_id:'piano',level:e.target.value}},'已切换钢琴净化版本。可单独试听对比，也可以撤销。');
for(const id of ['start','end','track-select'])$(id).oninput=()=>{if(project){updateSelection();paintArrangementUI();}};
$('undo').onclick=()=>mutate('/api/undo',{},'已撤销；音轨已恢复至上一步。',{preservePlayback:true});$('redo').onclick=()=>mutate('/api/redo',{},'已重做。',{preservePlayback:true});
$('play').onclick=async()=>{try{if(playing)stop();else await play(position>=project.duration?0:position);}catch(e){telemetry.audioErrors.push(e.message);notice(e.message,true);}};
$('stop').onclick=()=>stop(true);$('play-selection').onclick=async()=>{try{if(!(selection[0]<selection[1]))throw Error('请选择有效区间');await play(...selection);}catch(e){notice(e.message,true);}};
$('seek').oninput=e=>{const wasPlaying=playing;stop();position=Number(e.target.value);if(wasPlaying)play().catch(e=>notice(e.message,true));};
$('listen-mode').onchange=e=>{const wasPlaying=playing;stop();mode=e.target.value;if(wasPlaying)play().catch(e=>notice(e.message,true));};
function appendMessage(text,type){const div=document.createElement('div');div.className='message '+type;div.textContent=text;$('messages').append(div);}
$('chat-form').onsubmit=async e=>{e.preventDefault();const message=$('prompt').value.trim();if(!message||busy||chatPending)return;
  if(!await settleTrackSwitches()||busy)return;
  const id=project.id;chatPending=true;$('send').disabled=true;appendMessage(message,'user');
  try{const result=await api('/api/assistant',{message,project_id:id,revision:project.revision,selection:{track_id:selected,start_seconds:selection[0],end_seconds:selection[1]}});
    if(project.id!==id)return;
    if(result.resolved_selection){$('start').value=result.resolved_selection.start_seconds;$('end').value=result.resolved_selection.end_seconds;updateSelection();}
    if(result.candidate_review)await candidateReview?.open(result.candidate_review);
    if(result.applied){await flushTrackSwitches();
      if(result.project.revision<project.revision)throw Error('工程已有更新，请刷新后确认对话结果');
      const resume=playing,until=playUntil;setBusy(true);
      try{await accept(result.project);if(resume&&playing){const at=liveTime();if(at<until)await play(at,until);}}
      finally{setBusy(false);}
      if(result.command){selected=project.tracks.some(t=>t.id===result.command.track_id)?result.command.track_id:project.tracks[0]?.id;$('track-select').value=selected;
        if(Number.isFinite(result.command.start_seconds)&&Number.isFinite(result.command.end_seconds)){$('start').value=result.command.start_seconds;$('end').value=result.command.end_seconds;}updateSelection();
        if(result.command.type==='vocal_variant'){window.pauseScorePreview?.();await window.refreshVocalScore?.();await window.refreshVocalCandidates?.();await window.refreshVoiceConversion?.();}}
      event('edit',{path:'/api/assistant',revision:project.revision,applied:true});
    }
    if(result.arrangement_job){arrangementJob=result.arrangement_job;arrangementProject=id;arrangementError='';await refreshArrangements(true);}
    if(result.vocal_job)await window.refreshVocalCandidates?.();
    if(result.voice_conversion_job)await window.refreshVoiceConversion?.();
    appendMessage(result.message,'assistant');notice(result.message);
  }catch(error){if(project.id===id){appendMessage(error.message,'assistant');notice(error.message,true);}}
  finally{chatPending=false;$('send').disabled=busy;}
};
async function exportSong(format){if(busy||!await settleTrackSwitches()||busy)return;setBusy(true);notice(`正在导出完整 ${format.toUpperCase()}…`);
  try{const exported=await api('/api/export',{revision:project.revision,project_id:project.id,format});
    const a=document.createElement('a');a.href=exported.url;a.download=exported.filename;a.dataset.format=format;
    a.textContent=`重新下载 ${format.toUpperCase()} · ${clock(exported.duration)} · 版本 ${exported.revision}`;
    const previous=$('downloads').querySelector(`a[data-format="${format}"]`);if(previous)previous.replaceWith(a);else $('downloads').append(a);
    lastExport={...exported,downloadInitiated:false};
    // A single export action also starts the download. Keep the same-origin
    // attachment link as a fallback if browser download handling blocks it.
    a.click();lastExport.downloadInitiated=true;event('export',lastExport);
    notice(`${format.toUpperCase()} 已导出并发起下载。若未出现保存窗口，可点击“重新下载”。`);}
  catch(e){notice(e.message,true);}finally{setBusy(false);}}
$('export-wav').onclick=()=>exportSong('wav');$('export-mp3').onclick=()=>exportSong('mp3');
function animate(){const now=liveTime();$('clock').textContent=`${clock(Math.max(0,now))} / ${clock(project?.duration||0)}`;
  if(project){$('seek').value=Math.max(0,now);for(const el of document.querySelectorAll('.playhead')){el.style.left=`${now/project.duration*100}%`;el.setAttribute('aria-valuenow',Math.max(0,now).toFixed(2));}}
  if(playing&&now>=playUntil){position=playUntil;stop();event('ended');}requestAnimationFrame(animate);}
new ResizeObserver(()=>{if(project){renderRuler();for(const t of project.tracks){const canvas=document.querySelector(`.track[data-id="${t.id}"] canvas`);if(canvas)drawWave(canvas,t);}}}).observe($('tracks'));
async function activateProject(identifier,{preservePreview=false}={}){if(busy)throw Error('请先等待当前音频操作完成');
  window.pauseCandidatePreview?.();
  window.pauseVoiceLibraryPreview?.();
  window.pauseVocalPreview?.();
  if(preservePreview&&(switchSyncing||pendingSwitches.size))throw Error('当前歌曲正在保存开关修改，请稍后手动打开新歌工程');
  if(!await settleTrackSwitches()||busy)throw Error('请先完成当前轨道修改');
  if(!preservePreview)window.pauseGenerationPreview?.();stop();setBusy(true);
  try{const result=await api('/api/projects/activate',{target_id:identifier,project_id:project.id,revision:project.revision});await accept(result.project);notice('当前歌曲工程已切换。');}
  catch(e){if(e.message.includes('工程'))await accept(await api('/api/project'));throw e;}finally{setBusy(false);}}
try{project=await api('/api/project');await accept(project);
  setBusy(false);notice('工程已就绪。先试听，再用对话或手动控件修改同一段。');event('ready');}
catch(e){notice(e.message,true);$('ready').textContent='载入失败';}
const sharedTransport={
  unlock:()=>context().resume(),
  state:()=>({projectId:project?.id,playing,currentTime:Math.max(0,liveTime()),duration:project?.duration||0,volume:playbackVolume,
    ready:!busy&&!!original&&project?.tracks.every(t=>buffers.get(t.id)?.key===t.audio_key)}),
  async play(identifier,at,shouldPlay=()=>true){if(identifier!==project.id)await activateProject(identifier);
    if(!shouldPlay())return;
    if(busy)throw Error('正在载入歌曲音轨，请稍后播放');
    mode='mix';$('listen-mode').value=mode;await play(at??(position>=project.duration?0:position),project.duration,shouldPlay);
    if(playing&&$('notice').textContent.includes('还在准备分轨'))notice('歌曲分轨已就绪，播放时可随时开关声部。');},
  pause:()=>stop(),
  async seek(identifier,at){if(identifier!==project.id)await activateProject(identifier);
    if(busy)throw Error('歌曲音轨正在载入');
    const resume=playing;stop();position=Math.max(0,Math.min(project.duration,at));
    if(resume&&position<project.duration)await play();},
  volume(value){playbackVolume=Math.max(0,Math.min(1,Number(value)));if(outputGain)outputGain.gain.setTargetAtTime(playbackVolume,audioContext.currentTime,.005);}
};
if(project&&original)candidateReview=initializeCandidateReview({getProject:()=>project,getSelection:()=>selection,transport:sharedTransport,settle:settleTrackSwitches,
  container:document.getElementById('studio-candidate-mount'),
  apply:async review=>{const result=await mutate(`/api/candidate-reviews/${review.id}/apply`,{},'已应用试听候选，可撤销恢复。');
    if(!result)throw Error('候选尚未应用，请检查工程提示');
    if(review.kind==='vocal'){await window.refreshVocalScore?.();await window.refreshVoiceConversion?.();}
    return result;}});
if(project&&original)initializeSections({getProject:()=>project,transport:sharedTransport,settle:settleTrackSwitches,mount:document.getElementById('studio-navigation-mount'),
  onSelectRange:range=>{$('start').value=range.start_seconds;$('end').value=range.end_seconds;updateSelection();}});
if(project&&original)initializeScore({getProject:()=>project,transport:sharedTransport,settle:settleTrackSwitches});
if(project&&original&&!window.osmanthusIntegrated)initializeGeneration({getProject:()=>project,activate:activateProject,stopEditor:()=>{window.pauseScorePreview?.();window.pauseVocalPreview?.();window.pauseVoiceLibraryPreview?.();stop();},transport:sharedTransport});
if(project&&original)initializeVoiceLibrary({getProject:()=>project,transport:sharedTransport,settle:settleTrackSwitches});
if(project&&original)initializeLyrics({getProject:()=>project,transport:sharedTransport});
if(project&&original)initializeConversions({getProject:()=>project,transport:sharedTransport,settle:settleTrackSwitches,
  review:async variant=>candidateReview.open({kind:'vocal',candidate_id:variant}),
  apply:async variant=>{if(variant!=='original')return candidateReview.open({kind:'vocal',candidate_id:variant});
    const result=await mutate('/api/edit',{command:{type:'vocal_variant',track_id:'vocals',variant_id:variant}},'主唱已恢复，所有轨道修改已保留。',{preservePlayback:true});if(!result)throw Error('主唱切换未完成，请查看工程提示后重试');}});
if(project&&original&&!document.getElementById('experimental-vocals').hidden)initializeVocals({getProject:()=>project,transport:sharedTransport,settle:settleTrackSwitches,
  apply:async variant=>{if(variant!=='original')return candidateReview.open({kind:'vocal',candidate_id:variant});
    window.pauseScorePreview?.();await mutate('/api/edit',{command:{type:'vocal_variant',track_id:'vocals',variant_id:variant}},'主唱已恢复，试听开关与片段修改已保留。',{preservePlayback:true});await window.refreshVocalScore?.();}});
document.addEventListener('play',event=>{if(event.target?.id!=='candidate-review-audio')window.pauseCandidatePreview?.();},true);
if(window.osmanthusIntegrated)window.osmanthusEngine={
  api,transport:sharedTransport,activate:activateProject,accept,mutate,settle:settleTrackSwitches,
  getProject:()=>project,ready:()=>!busy&&!!project,
  setSelection(track,start,end){if(track)$('track-select').value=track;$('start').value=start;$('end').value=end;updateSelection();},
  playRange:(start,end)=>play(start,end),pause:()=>stop(),toggleTrack,
  attachSeekHandle,drawWave,exportSong,
  async reload(){await accept(await api('/api/project'));},
};
animate();
