// Persistent player for the actual shared project engine and existing candidate audio.
// Home playback changes the audio source, never the page or editor navigation.
const seconds=value=>Number.isFinite(value)?Math.max(0,value):0;
const clock=value=>`${Math.floor(seconds(value)/60)}:${String(Math.floor(seconds(value)%60)).padStart(2,'0')}`;

// Space is a player shortcut only outside editing and modal interactions.
// Contenteditable can be inherited, empty, or plaintext-only, not just "true".
export function isPlaybackSpace(event,{modalOpen=false}={}){
 if(event.code!=='Space'||event.repeat||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||modalOpen)return false;
 const target=event.target;
 return !target?.isContentEditable&&!target?.closest?.('input,textarea,select,button,a,audio,video,[role="textbox"],[contenteditable]:not([contenteditable="false"])');
}

export function createPlaybackQueue(engine,{onChange=()=>{}}={}){
 let serial=0,queued=null,working=false,destroyed=false,activeToken=null;
 function cancelPending(){serial++;if(queued){queued.resolve({superseded:true});queued=null;}}
 function pause(){cancelPending();engine.transport.pause();onChange();}
 async function drain(){
  if(working||destroyed)return;working=true;onChange();
  try{while(queued&&!destroyed){
   const op=queued;queued=null;activeToken=op.token;
   try{
    await engine.transport.unlock?.();
    if(op.token!==serial){op.resolve({superseded:true});continue;}
    if(!engine.ready()&&!engine.canPrepareAudio?.())throw Error('歌曲音轨正在更新，请稍后播放。');
    if(!await engine.settle())throw Error('请先完成当前轨道修改。');
    if(op.token!==serial){op.resolve({superseded:true});continue;}
    if(engine.getProject()?.id!==op.id)await engine.activate(op.id);
    if(op.token!==serial){op.resolve({superseded:true});continue;}
    await engine.transport.play(op.id,op.at,()=>!destroyed&&op.token===serial);
    op.resolve({played:op.token===serial,project_id:op.id,superseded:op.token!==serial});
   }catch(error){if(op.token!==serial)op.resolve({superseded:true});else op.reject(error);}
   finally{onChange();}
  }}finally{working=false;onChange();}
 }
 function playSong(id,{toggle=true,at}={}){
  if(destroyed)return Promise.reject(Error('播放器已关闭。'));
  if(typeof id!=='string'||!id)return Promise.reject(Error('请选择一首歌曲。'));
  const state=engine.transport.state();
  if(toggle&&!working&&!queued&&state.projectId===id&&state.playing){pause();return Promise.resolve({paused:true,project_id:id});}
  if(queued)queued.resolve({superseded:true});
  return new Promise((resolve,reject)=>{queued={id,at,token:++serial,resolve,reject};void drain();});
 }
 return {playSong,pause,cancelPending,get loading(){return !!queued||(working&&activeToken===serial);},get working(){return working;},destroy(){destroyed=true;cancelPending();}};
}

export function mixOverviewPeaks(project,trackBuffers,points=190){
 if(!project?.tracks?.length||!trackBuffers)return [];
 const solo=project.tracks.some(t=>t.solo),sources=[];
 for(const track of project.tracks){
  if(track.muted||(solo&&!track.solo))continue;
  const buffer=trackBuffers[track.id]?.buffer;if(!buffer)continue;
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
  sources.push({channels,frames:buffer.length,gain:10**(track.gain_db/20)*(project.master_gain??1)});
 }
 if(!sources.length)return Array(points).fill(0);
 const length=Math.min(...sources.map(s=>s.frames)),result=[];
 // Sample the decoded, edited tracks with their current mixer routing. This
 // is a compact waveform overview, not invented decorative bars or an LUFS meter.
 for(let bin=0;bin<points;bin++){
  const lo=Math.floor(bin*length/points),hi=Math.floor((bin+1)*length/points),step=Math.max(1,Math.floor((hi-lo)/72));let peak=0;
  for(let k=lo;k<hi;k+=step){
   for(let channel=0;channel<2;channel++){
    let value=0;for(const source of sources)value+=(source.channels[Math.min(channel,source.channels.length-1)][k]||0)*source.gain;
    peak=Math.max(peak,Math.abs(value));
   }
  }
  result.push(peak);
 }
 return result;
}

export function streamNeedsContinuation(song,{url='',time=0}={}){
 if(!url.endsWith('/stream'))return false;
 const duration=song?.duration_seconds;
 return !(song?.status==='done'&&Number.isFinite(duration)&&duration>0&&time>=duration-.5);
}

export function previewBufferReady(audio,seconds=8){
 const at=audio.currentTime||0,duration=audio.duration;
 const needed=Number.isFinite(duration)?Math.min(seconds,Math.max(0,duration-at-.1)):seconds;
 for(let i=0;i<audio.buffered.length;i++)if(audio.buffered.start(i)<=at+.15&&audio.buffered.end(i)-at>=needed&&audio.readyState>=2)return true;
 return false;
}

// A little headroom prevents each small network pause from interrupting the
// listener. The bound still permits slow connections to make visible progress.
export function waitForPreviewBuffer(audio,{allowed=()=>true,seconds=8,maxWait=12000}={}){
 return new Promise((resolve,reject)=>{
  let timer;const started=Date.now();
  function finish(error){clearInterval(timer);audio.removeEventListener('error',failed);error?reject(error):resolve();}
  function failed(){finish(Error('音频连接中断'));}
  function check(){if(!allowed())return finish();if(audio.error)return failed();if(previewBufferReady(audio,seconds)||Date.now()-started>=maxWait)finish();}
  audio.addEventListener('error',failed,{once:true});timer=setInterval(check,100);check();
 });
}

function icon(name){return `<i data-lucide="${name}" aria-hidden="true"></i>`;}

export function initializeStudioPlayer(studio,{getSongs=()=>[],getSong=null,onShare=null,onCopyShare=null,onExport=null,onDetails=null,onQueue=null,onFavorite=null,onStateChange=null}={}){
 const root=document.getElementById('os-mix-28'),engine=studio?.engine;
 if(!root||!engine)return null;
 document.getElementById('studio-player')?.remove();
 const footer=document.createElement('footer');footer.id='studio-player';footer.className='rs-player ng-transport sp-player';footer.setAttribute('aria-label','歌曲播放器');
 footer.innerHTML=`<div class="sp-now">
 <button type="button" class="sp-cover studio-player-cover" data-player="details" aria-label="查看当前歌曲详情" title="歌曲详情"><span class="sp-vinyl"><img data-player-cover alt="" hidden><span data-player-cover-fallback aria-hidden="true">${icon('music-2')}</span></span></button>
 <button type="button" class="sp-song-name" data-player="details" aria-label="查看当前歌曲详情"><strong data-player-title>选择一首歌</strong><span data-player-subtitle></span></button></div>
 <div class="sp-center"><div class="sp-controls" aria-label="播放控制">
 <button type="button" data-player="previous" aria-label="上一首" title="上一首">${icon('skip-back')}</button>
 <button type="button" class="sp-play" data-player="play" aria-label="播放歌曲" aria-pressed="false">${icon('play')}</button>
 <button type="button" data-player="next" aria-label="下一首" title="下一首">${icon('skip-forward')}</button>
 </div>
 <div class="sp-progress"><span data-player-position>00:00</span><div class="sp-seek-track"><input data-player-seek type="range" min="0" max="0" step="0.01" value="0" aria-label="歌曲播放进度" disabled></div><span data-player-duration>00:00</span></div></div>
 <div class="sp-actions">
 <button type="button" data-player="queue" aria-label="播放队列" aria-expanded="false" title="播放队列">${icon('list-music')}</button>
 <button type="button" data-player="favorite" aria-label="收藏当前歌曲" aria-pressed="false" title="收藏">${icon('thumbs-up')}</button>
 <button type="button" data-player="share" aria-label="分享当前歌曲" title="分享">${icon('share-2')}</button>
 <button type="button" data-player="more" aria-label="歌曲更多操作" aria-haspopup="menu" aria-expanded="false" title="更多">${icon('ellipsis')}</button>
 <button type="button" data-player="mute" aria-label="播放器静音" aria-pressed="false" title="静音">${icon('volume-2')}</button><input data-player-volume type="range" min="0" max="100" step="1" value="100" aria-label="播放器音量">
 <button type="button" data-player="details-toggle" aria-label="展开歌曲详情" aria-expanded="false" title="展开歌曲详情">${icon('panel-right')}</button></div>
 <span class="sp-status" data-player-status role="status" aria-live="polite" hidden></span>
 <section class="sp-loading-panel" data-player-loading role="status" aria-live="polite" hidden><span class="sp-loading-spinner" aria-hidden="true"></span><div><strong>正在加载歌曲</strong><p data-player-loading-title></p><small>音频准备好后自动播放</small></div><button type="button" data-player="cancel-loading" aria-label="取消歌曲加载">取消</button></section>
 <canvas data-player-wave aria-hidden="true" hidden></canvas>
 <div class="studio-player-menu" role="menu" hidden><button role="menuitem" type="button" data-player="edit">${icon('pencil-line')}编辑歌曲</button><button role="menuitem" type="button" data-player="share">${icon('share-2')}分享歌曲</button><button role="menuitem" type="button" data-player="copy" ${onCopyShare?'':'hidden'}>${icon('link')}复制分享链接</button><button role="menuitem" type="button" data-player="export">${icon('download')}导出歌曲</button></div>`;
 root.append(footer);
 const q=selector=>footer.querySelector(selector),playButton=q('[data-player="play"]'),seek=q('[data-player-seek]'),volume=q('[data-player-volume]'),seekTrack=q('.sp-seek-track'),menu=q('.studio-player-menu');
 const icons=()=>globalThis.lucide?.createIcons({attrs:{width:18,height:18}});
 let preview=null,sourceKind='engine',scrubbing=false,scrubProject=null,seekTimer=null,lastNonzero=1,metadataKey='',stateKey='',lastPlaying=false,lastTime=0,lastId=null,frame=0,lastFrame=0,closed=false,manualPause=false,pendingLoop=false;
 let pendingMessage='',lastEngineProjectId=null,nativeIntent=0,nativeLoading=null,pendingContinuation=null;
 const registeredSongs=new Map(),ownedAudio=new Map(),nativeRequests=new WeakMap();
 const songById=id=>getSong?.(id)||getSongs().find(s=>s.id===id)||registeredSongs.get(id)||null;
 const controller=createPlaybackQueue(engine,{onChange:()=>paint(true)});
 const safe=async action=>{try{return await action();}catch(error){pendingMessage=error.message;studio.status?.(error.message,true);paint(true);return null;}};
 const detailFor=state=>({project_id:state.id,candidate_id:state.kind==='preview'?state.id:null,source:state.kind});
 const nativeById=id=>[...document.querySelectorAll('audio[data-candidate]')].find(audio=>audio.dataset.candidate===id)||null;
 function registerPreviewSong(song){
  if(!song||typeof song.id!=='string'||!song.id)throw Error('歌曲标识无效。');
  registeredSongs.set(song.id,{...registeredSongs.get(song.id),...song});
  const existing=nativeById(song.id),finished=song.media?.complete||song.media?.preview_complete;
  // A metadata refresh may register every candidate. Only the active listening
  // intent owns continuation; finishing another song must never start it.
  const active=existing&&sourceKind==='preview'&&preview===existing&&!manualPause;
  const continuation=active&&pendingContinuation?.id===song.id&&pendingContinuation.intent===nativeIntent?pendingContinuation:active&&nativeLoading===existing&&finished&&existing.dataset.url?.endsWith('/stream')?{id:song.id,at:existing.currentTime||0,intent:nativeIntent}:null,raw=finished||song.media?.stream;
  if(!continuation&&existing?.getAttribute('src')&&(!ownedAudio.has(song.id)||!raw||!existing.paused))return existing;
  if(continuation&&(!finished||(continuation.localOnly&&!song.media?.complete)))return existing;
  if(continuation&&song.duration_seconds>0&&continuation.at>=song.duration_seconds-.5){pendingContinuation=null;nativeLoading=null;manualPause=true;return existing;}
  if(!raw)return existing||null;
  let url;try{url=new URL(raw,location.href);}catch{throw Error('歌曲音频地址无效。');}
  if(url.origin!==location.origin)throw Error('请使用工作台提供的歌曲音频地址。');
  const audio=existing||document.createElement('audio');
  if(!existing){audio.hidden=true;audio.preload='none';audio.dataset.candidate=song.id;audio.dataset.playerOwnedPreview='true';footer.append(audio);ownedAudio.set(song.id,audio);}
  if(audio.getAttribute('src')!==url.href){if(audio===preview)lastPlaying=false;const resumeAt=audio.ended?0:audio.currentTime||0;audio.src=url.href;if(resumeAt>0)audio.dataset.playerResumeAt=String(resumeAt);}
  audio.dataset.url=raw;if(continuation&&finished){pendingContinuation=null;void safe(()=>playPreview(audio,{at:continuation.at}));}return audio;
 }
 function recordNativeEvent(event){const audio=event.target;if(!audio?.dataset?.candidate)return;const type=event.type;
  if(!['playing','waiting','stalled','pause','ended','error'].includes(type))return;
  void fetch('/api/generation/jobs/'+audio.dataset.candidate+'/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:type,current_time:audio.currentTime||0,source:audio.dataset.url?.endsWith('/stream')?'stream':'complete'}),keepalive:true}).catch(()=>{});
 }
 const telemetryEvents=['playing','waiting','stalled','pause','ended','error'];for(const type of telemetryEvents)document.addEventListener(type,recordNativeEvent,true);
 function previewSong(audio){
  const id=audio.dataset.candidate,card=audio.closest('[data-candidate-card]'),batch=audio.closest('.studio-batch'),song=songById(id)||{};
  return {...song,id,title:song.title||batch?.querySelector('h3')?.textContent||'歌曲候选',duration:song.duration_seconds||seconds(audio.duration)||song.duration||0,candidate_label:card?.querySelector('strong')?.textContent||song.candidate_label||'原始歌曲'};
 }
 function current(){
  const state=engine.transport.state();
  if(state.projectId!==lastEngineProjectId){lastEngineProjectId=state.projectId;if(!preview||preview.paused)sourceKind='engine';}
  if(state.playing)sourceKind='engine';
  if(sourceKind==='preview'&&preview?.isConnected){const song=previewSong(preview);return{kind:'preview',id:song.id,song,playing:!preview.paused&&!preview.ended,time:seconds(preview.currentTime),duration:song.duration,volume:preview.muted?0:preview.volume,ready:Number.isFinite(preview.duration)&&preview.readyState>0};}
  const project=engine.getProject(),metadata=songById(state.projectId)||{},song={...metadata,...project,favorite:metadata.favorite??project?.favorite};
  return{kind:'engine',id:state.projectId,song,playing:state.playing,time:seconds(state.currentTime),duration:seconds(state.duration),volume:state.volume,ready:state.ready};
 }
 function setIcon(button,name){if(button.dataset.icon===name)return;button.dataset.icon=name;button.innerHTML=icon(name);icons();}
 function updateCover(song){
  const image=q('[data-player-cover]'),fallback=q('[data-player-cover-fallback]'),url=song.cover_url||song.artwork?.cover_url||song.artwork?.url||'';
  if(image.dataset.source===url)return;image.dataset.source=url;image.hidden=true;fallback.hidden=false;
  if(!url){image.removeAttribute('src');return;}
  let parsed;try{parsed=new URL(url,location.href);}catch{return;}
  if(parsed.origin!==location.origin&&!url.startsWith('data:image/'))return;
  image.alt=`${song.title||'歌曲'}封面`;image.onload=()=>{if(image.dataset.source===url){image.hidden=false;fallback.hidden=true;}};
  image.onerror=()=>{image.hidden=true;fallback.hidden=false;};image.src=url;
 }
 function cancelPending(){nativeIntent++;nativeLoading=null;pendingContinuation=null;controller.cancelPending();clearTimeout(seekTimer);}
 function pause(){root.dispatchEvent(new CustomEvent('osmanthus:manual-playback',{bubbles:true}));manualPause=true;pendingMessage='';cancelPending();controller.pause();if(preview)preview.pause();paint(true);}
 async function playPreview(audio,{at}={}){
  cancelPending();const token=nativeIntent;nativeRequests.set(audio,token);
  manualPause=false;pendingMessage='';if(preview&&preview!==audio)preview.pause();preview=audio;sourceKind='preview';controller.pause();
  nativeLoading=audio;paint(true);
  audio.muted=false;audio.volume=engine.transport.state().volume;
  audio.preload='auto';
  if(audio.readyState===0)audio.load();
  const resumeAt=at??(audio.dataset.playerResumeAt!==undefined?Number(audio.dataset.playerResumeAt):undefined);delete audio.dataset.playerResumeAt;
  if(resumeAt!==undefined||audio.ended){const value=Math.max(0,Number(resumeAt)||0);try{audio.currentTime=Number.isFinite(audio.duration)?Math.min(audio.duration,value):value;}catch{audio.addEventListener('loadedmetadata',()=>{if(token===nativeIntent)audio.currentTime=Math.min(audio.duration,value);},{once:true});}}
  try{
   await waitForPreviewBuffer(audio,{allowed:()=>token===nativeIntent});
   if(token!==nativeIntent)return{superseded:true};
   await audio.play();if(token!==nativeIntent){if(nativeRequests.get(audio)===token)audio.pause();return{superseded:true};}paint(true);return{played:true,project_id:audio.dataset.candidate};
  }
  catch(error){if(token!==nativeIntent)return{superseded:true};if(pendingContinuation?.id===audio.dataset.candidate&&pendingContinuation.intent===token)return{recovering:true};throw Error(error.name==='NotAllowedError'?'点击播放即可开始试听。':'音频连接中断，请重试播放。');}
  finally{if(nativeRequests.get(audio)===token)nativeRequests.delete(audio);if(token===nativeIntent&&nativeLoading===audio&&!pendingContinuation)nativeLoading=null;paint(true);}
 }
 async function playSong(id,options={}){
  if(!options.automatic)root.dispatchEvent(new CustomEvent('osmanthus:manual-playback',{bubbles:true}));
  const state=current();
  if(options.toggle!==false&&!controller.working&&state.id===id&&state.playing){pause();return{paused:true,project_id:id};}
  const song=songById(id);
  if(song?.project_ready===false){const audio=registerPreviewSong(song);if(!audio)throw Error('完整歌曲尚未准备好，请稍后再试听。');return playPreview(audio,options);}
  cancelPending();manualPause=false;pendingMessage='';sourceKind='engine';if(preview)preview.pause();preview=null;
  const result=await controller.playSong(id,options);paint(true);return result;
 }
 async function toggle(){
  root.dispatchEvent(new CustomEvent('osmanthus:manual-playback',{bubbles:true}));
  if(controller.loading||nativeLoading){pause();return;}
  const state=current();pendingMessage='';if(state.playing){pause();return;}
  manualPause=false;
  if(state.kind==='preview')return playPreview(preview);
  if(!state.id)throw Error('请先选择一首歌曲。');return playSong(state.id,{toggle:false});
 }
 function contextChoices(state=current()){
  if(state.kind==='preview'){
   const unique=new Map();
   for(const song of getSongs())if(song.id&&(song.project_ready!==false||song.media?.complete||nativeById(song.id)?.getAttribute('src')))unique.set(song.id,{id:song.id,song});
   for(const audio of document.querySelectorAll('audio[data-candidate]'))if(audio.getAttribute('src')&&!unique.has(audio.dataset.candidate))unique.set(audio.dataset.candidate,{id:audio.dataset.candidate,audio,song:previewSong(audio)});
   return [...unique.values()];
  }
  return getSongs().filter(song=>song.id&&(song.project_ready!==false||song.media?.complete||nativeById(song.id)?.getAttribute('src'))).map(song=>({id:song.id,song}));
 }
 async function skip(direction){
  const state=current();manualPause=false;if(direction<0&&state.time>3){await seekTo(0);return;}
  const choices=contextChoices(state);if(!choices.length)return;
  const index=choices.findIndex(item=>item.id===state.id),next=choices[(Math.max(0,index)+direction+choices.length)%choices.length];
  if(!next)return;
  if(next.audio)await playPreview(next.audio,{at:0});else await playSong(next.id,{toggle:false,at:0});
 }
 async function seekTo(at){
  clearTimeout(seekTimer);const state=current();at=Math.max(0,Math.min(state.duration,Number(at)||0));
  if(at>=state.duration){manualPause=true;if(state.kind==='preview')preview?.pause();else engine.transport.pause();}
  if(state.kind==='preview'){if(preview&&Number.isFinite(preview.duration))preview.currentTime=at;paint(true);return;}
  if(!state.id||!state.ready||controller.working)return;await engine.transport.seek(state.id,at);paint(true);
 }
 function changeVolume(value){value=Math.max(0,Math.min(1,Number(value)||0));if(value>0)lastNonzero=value;engine.transport.volume(value);if(preview){preview.muted=false;preview.volume=value;}paint(true);}
 function closeMenu(){menu.hidden=true;q('[data-player="more"]').setAttribute('aria-expanded','false');}
 async function edit(){closeMenu();const state=current();if(!state.id)return;cancelPending();await studio.openProject(state.id);}
 async function showDetails(drawer=false){closeMenu();const state=current();if(!state.id)return;if(onDetails)return onDetails(detailFor(state),{drawer});return edit();}
 function emitAction(name,callback){closeMenu();const state=current();if(!state.id)return;const detail=detailFor(state);if(callback)void safe(async()=>{await callback(detail);paint(true);});else root.dispatchEvent(new CustomEvent('osmanthus:'+name,{detail,bubbles:true}));}
 function onClick(event){const button=event.target.closest('[data-player]');if(!button)return;const action=button.dataset.player;
  if(action==='play')void safe(toggle);if(action==='previous')void safe(()=>skip(-1));if(action==='next')void safe(()=>skip(1));
  if(action==='cancel-loading')pause();
  if(action==='mute'){const state=current();changeVolume(state.volume>0?0:lastNonzero);}
  if(action==='share')emitAction('share',onShare);if(action==='queue')emitAction('queue',onQueue);if(action==='favorite')emitAction('favorite',onFavorite);
  if(action==='details'||action==='details-toggle')void safe(()=>showDetails(action==='details-toggle'));if(action==='edit')void safe(edit);
  if(action==='copy'&&onCopyShare)emitAction('copy-share',onCopyShare);
  if(action==='more'){menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));}
  if(action==='export')emitAction('export',onExport);
 }
 footer.addEventListener('click',onClick);
 volume.addEventListener('input',()=>changeVolume(Number(volume.value)/100));
 const paintProgress=(at,duration)=>seekTrack.style.setProperty('--sp-progress',`${duration?Math.min(100,Math.max(0,at/duration*100)):0}%`);
 seek.addEventListener('pointerdown',()=>{scrubbing=true;scrubProject=current().id;});
 seek.addEventListener('input',()=>{const state=current(),at=Number(seek.value);q('[data-player-position]').textContent=clock(at);paintProgress(at,state.duration);clearTimeout(seekTimer);if(!scrubbing)seekTimer=setTimeout(()=>{if(current().id===state.id)void safe(()=>seekTo(at));},90);});
 seek.addEventListener('change',()=>{const id=scrubProject||current().id;scrubbing=false;scrubProject=null;if(current().id===id)void safe(()=>seekTo(Number(seek.value)));});
 seek.addEventListener('pointercancel',()=>{scrubbing=false;scrubProject=null;paint(true);});
 function onNativePlay(event){
  const audio=event.target;if(!audio?.dataset?.candidate||audio.paused)return;
  const request=nativeRequests.get(audio);if(request!==undefined&&request!==nativeIntent){audio.pause();return;}
  if(request===undefined)nativeIntent++;
  if(preview&&preview!==audio)preview.pause();manualPause=true;controller.pause();sourceKind='preview';preview=audio;manualPause=false;pendingMessage='';audio.volume=engine.transport.state().volume;paint(true);
 }
 function onUserSeek(event){if(event.detail?.time>=event.detail?.duration)manualPause=true;}
 window.addEventListener('osmanthus:user-seek',onUserSeek);
 document.addEventListener('play',onNativePlay,true);
 function onNativeBuffer(event){if(event.target!==preview)return;
  if(['ended','error'].includes(event.type)&&!manualPause&&(streamNeedsContinuation(previewSong(preview),{url:preview.dataset.url||'',time:preview.currentTime||0})||(event.type==='error'&&preview.dataset.url?.endsWith('/preview-complete')))){
   const audio=preview,at=audio.currentTime||0;audio.pause();pendingContinuation={id:audio.dataset.candidate,at,intent:nativeIntent,localOnly:audio.dataset.url?.endsWith('/preview-complete')};nativeLoading=audio;lastPlaying=false;const song=songById(audio.dataset.candidate);if(song?.media?.complete||song?.media?.preview_complete)registerPreviewSong(song);paint(true);return;
  }
  if(['waiting','stalled','loadstart'].includes(event.type)){if(!preview.paused)nativeLoading=preview;}else if(nativeLoading===preview&&!pendingContinuation&&(event.type==='playing'||!nativeRequests.has(preview)))nativeLoading=null;paint(true);
 }
 const bufferEvents=['waiting','stalled','loadstart','playing','canplay','pause','ended','error'];for(const type of bufferEvents)document.addEventListener(type,onNativeBuffer,true);
 const previousPausePreviews=window.pauseGenerationPreview;
 const pauseAllPreviews=()=>{previousPausePreviews?.();if(preview)preview.pause();};
 window.pauseGenerationPreview=pauseAllPreviews;
 function onDocumentClick(event){if(!footer.contains(event.target))closeMenu();}
 function onKey(event){if(event.key==='Escape')closeMenu();if(isPlaybackSpace(event,{modalOpen:!!document.querySelector('dialog[open]')})){event.preventDefault();void safe(toggle);}}
 document.addEventListener('click',onDocumentClick);document.addEventListener('keydown',onKey);
 function paint(force=false){
  if(closed)return;const state=current(),song=state.song||{},busy=controller.loading||!!nativeLoading;
  if(footer.dataset.playing!==String(state.playing&&!busy))footer.dataset.playing=String(state.playing&&!busy);
  for(const record of root.querySelectorAll('[data-record-song]'))record.dataset.playing=String(record.dataset.recordSong===state.id&&state.playing&&!busy);
  footer.dataset.loading=String(busy);q('[data-player-loading]').hidden=!busy;q('[data-player-loading-title]').textContent=studio.displaySongTitle?.(song.title)||song.title||'正在准备音频…';
  const mk=JSON.stringify([state.id,song.title,song.cover_url,song.artwork,state.kind,song.candidate_label]);
  if(mk!==metadataKey){metadataKey=mk;q('[data-player-title]').textContent=studio.displaySongTitle?.(song.title)||song.title||'选择一首歌';q('[data-player-subtitle]').textContent=state.kind==='preview'?song.style||song.candidate_label||'原始歌曲':song.style||'当前作品';footer.dataset.songId=state.id||'';footer.dataset.source=state.kind;updateCover(song);}
  setIcon(playButton,busy?'loader-circle':state.playing?'pause':'play');playButton.setAttribute('aria-label',busy?'取消歌曲加载':state.playing?'暂停歌曲':'播放歌曲');playButton.setAttribute('aria-pressed',String(state.playing));playButton.disabled=!state.id;
  const like=q('[data-player="favorite"]'),liked=!!song.favorite;like.setAttribute('aria-pressed',String(liked));like.setAttribute('aria-label',liked?'取消收藏当前歌曲':'收藏当前歌曲');
  for(const key of ['favorite','share','more','details','details-toggle','queue'])for(const button of footer.querySelectorAll(`[data-player="${key}"]`))button.disabled=!state.id;
  if(state.volume>0)lastNonzero=state.volume;
  const mute=q('[data-player="mute"]');setIcon(mute,state.volume>0?'volume-2':'volume-x');mute.setAttribute('aria-pressed',String(state.volume===0));mute.setAttribute('aria-label',state.volume>0?'播放器静音':'恢复播放器音量');
  if(document.activeElement!==volume)volume.value=Math.round(state.volume*100);volume.setAttribute('aria-valuetext',`${Math.round(state.volume*100)}%`);
  seek.disabled=!state.ready||busy||!state.duration;seek.max=state.duration||0;
  if(!scrubbing){seek.value=Math.min(state.duration,state.time)||0;q('[data-player-position]').textContent=clock(state.time);paintProgress(state.time,state.duration);}
  seek.setAttribute('aria-valuetext',`${clock(state.time)}，共${clock(state.duration)}`);q('[data-player-duration]').textContent=state.kind==='preview'&&!state.duration&&song.media?.stream?'--:--':clock(state.duration);
  const text=studio.statusIsTransient?.(pendingMessage)?'':pendingMessage;q('[data-player-status]').hidden=!text;if(q('[data-player-status]').textContent!==text)q('[data-player-status]').textContent=text;
  const sk=JSON.stringify([state.id,state.kind,state.playing,busy]);if(sk!==stateKey){stateKey=sk;onStateChange?.({...state,busy});root.dispatchEvent(new CustomEvent('osmanthus:playback',{detail:{id:state.id,kind:state.kind,playing:state.playing,busy},bubbles:true}));}
  const ended=lastId===state.id&&lastPlaying&&!state.playing&&!manualPause&&!busy&&state.duration>0&&state.time>=state.duration-.08&&lastTime<state.duration;
  lastPlaying=state.playing;lastTime=state.time;lastId=state.id;
  if(ended&&!preview?.error&&!pendingContinuation&&!pendingLoop){pendingLoop=true;void safe(async()=>{await skip(1);}).finally(()=>{pendingLoop=false;});}
 }
 function tick(now){if(closed)return;frame=requestAnimationFrame(tick);if(now-lastFrame<40)return;lastFrame=now;paint();}
 icons();paint(true);frame=requestAnimationFrame(tick);
 window.osmanthusSeekTo=seekTo;
 const result={seekTo,playSong,pause,cancelPending,registerPreviewSong,sync:()=>paint(true),get state(){return{...current(),busy:controller.loading||!!nativeLoading};},destroy(){closed=true;if(window.osmanthusSeekTo===seekTo)delete window.osmanthusSeekTo;cancelPending();controller.destroy();cancelAnimationFrame(frame);clearTimeout(seekTimer);for(const audio of ownedAudio.values()){audio.pause();audio.removeAttribute('src');audio.load();audio.remove();}ownedAudio.clear();if(window.pauseGenerationPreview===pauseAllPreviews)window.pauseGenerationPreview=previousPausePreviews;footer.removeEventListener('click',onClick);for(const type of bufferEvents)document.removeEventListener(type,onNativeBuffer,true);window.removeEventListener('osmanthus:user-seek',onUserSeek);document.removeEventListener('play',onNativePlay,true);for(const type of telemetryEvents)document.removeEventListener(type,recordNativeEvent,true);document.removeEventListener('click',onDocumentClick);document.removeEventListener('keydown',onKey);footer.remove();}};
 Object.defineProperty(window,'osmanthusPlaybackState',{configurable:true,get:()=>result.state});return result;
}
