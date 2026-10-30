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
 let serial=0,queued=null,working=false,destroyed=false;
 function cancelPending(){serial++;if(queued){queued.resolve({superseded:true});queued=null;}}
 function pause(){cancelPending();engine.transport.pause();onChange();}
 async function drain(){
  if(working||destroyed)return;working=true;onChange();
  try{while(queued&&!destroyed){
   const op=queued;queued=null;
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
 return {playSong,pause,cancelPending,get working(){return working;},destroy(){destroyed=true;cancelPending();}};
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

function icon(name){return `<i data-lucide="${name}" aria-hidden="true"></i>`;}

export function initializeStudioPlayer(studio,{getSongs=()=>[],getSong=null,onShare=null,onCopyShare=null,onExport=null,onDetails=null,onQueue=null,onFavorite=null,onStateChange=null}={}){
 const root=document.getElementById('os-mix-28'),engine=studio?.engine;
 if(!root||!engine)return null;
 document.getElementById('studio-player')?.remove();
 const footer=document.createElement('footer');footer.id='studio-player';footer.className='rs-player ng-transport sp-player';footer.setAttribute('aria-label','歌曲播放器');
 footer.innerHTML=`<div class="sp-now">
 <button type="button" class="sp-cover studio-player-cover" data-player="details" aria-label="查看当前歌曲详情" title="歌曲详情"><img data-player-cover alt="" hidden><span data-player-cover-fallback aria-hidden="true">${icon('music-2')}</span></button>
 <button type="button" class="sp-song-name" data-player="details" aria-label="查看当前歌曲详情"><strong data-player-title>选择一首歌</strong><span data-player-subtitle></span></button></div>
 <div class="sp-center"><div class="sp-controls" aria-label="播放控制">
 <button type="button" data-player="shuffle" aria-label="开启随机播放" aria-pressed="false" title="随机播放">${icon('shuffle')}</button>
 <button type="button" data-player="previous" aria-label="上一首" title="上一首">${icon('skip-back')}</button>
 <button type="button" class="sp-play" data-player="play" aria-label="播放歌曲" aria-pressed="false">${icon('play')}</button>
 <button type="button" data-player="next" aria-label="下一首" title="下一首">${icon('skip-forward')}</button>
 <button type="button" data-player="loop" aria-label="开启单曲循环" aria-pressed="false" title="单曲循环">${icon('repeat-2')}</button></div>
 <div class="sp-progress"><span data-player-position>00:00</span><div class="sp-seek-track"><input data-player-seek type="range" min="0" max="0" step="0.01" value="0" aria-label="歌曲播放进度" disabled></div><span data-player-duration>00:00</span></div></div>
 <div class="sp-actions">
 <button type="button" data-player="queue" aria-label="播放队列" aria-expanded="false" title="播放队列">${icon('list-music')}</button>
 <button type="button" data-player="favorite" aria-label="收藏当前歌曲" aria-pressed="false" title="收藏">${icon('thumbs-up')}</button>
 <button type="button" data-player="share" aria-label="分享当前歌曲" title="分享">${icon('share-2')}</button>
 <button type="button" data-player="more" aria-label="歌曲更多操作" aria-haspopup="menu" aria-expanded="false" title="更多">${icon('ellipsis')}</button>
 <button type="button" data-player="mute" aria-label="播放器静音" aria-pressed="false" title="静音">${icon('volume-2')}</button><input data-player-volume type="range" min="0" max="100" step="1" value="100" aria-label="播放器音量">
 <button type="button" data-player="details-toggle" aria-label="展开歌曲详情" aria-expanded="false" title="展开歌曲详情">${icon('panel-right')}</button></div>
 <span class="sp-status" data-player-status role="status" aria-live="polite" hidden></span>
 <canvas data-player-wave aria-hidden="true" hidden></canvas>
 <div class="studio-player-menu" role="menu" hidden><button role="menuitem" type="button" data-player="edit">${icon('pencil-line')}编辑歌曲</button><button role="menuitem" type="button" data-player="share">${icon('share-2')}分享歌曲</button><button role="menuitem" type="button" data-player="copy" ${onCopyShare?'':'hidden'}>${icon('link')}复制分享链接</button><button role="menuitem" type="button" data-player="export">${icon('download')}导出歌曲</button></div>`;
 root.append(footer);
 const q=selector=>footer.querySelector(selector),playButton=q('[data-player="play"]'),seek=q('[data-player-seek]'),volume=q('[data-player-volume]'),seekTrack=q('.sp-seek-track'),menu=q('.studio-player-menu');
 const icons=()=>globalThis.lucide?.createIcons({attrs:{width:18,height:18}});
 let preview=null,sourceKind='engine',loop=false,shuffle=false,scrubbing=false,scrubProject=null,seekTimer=null,lastNonzero=1,metadataKey='',stateKey='',lastPlaying=false,lastTime=0,lastId=null,frame=0,lastFrame=0,closed=false,manualPause=false,pendingLoop=false;
 let pendingMessage='',lastEngineProjectId=null,nativeIntent=0,shuffleBag=[],shuffleContext='',shuffleHistory=[];
 const registeredSongs=new Map(),ownedAudio=new Map(),nativeRequests=new WeakMap();
 const songById=id=>getSong?.(id)||getSongs().find(s=>s.id===id)||registeredSongs.get(id)||null;
 const controller=createPlaybackQueue(engine,{onChange:()=>paint(true)});
 const safe=async action=>{try{return await action();}catch(error){pendingMessage=error.message;studio.status?.(error.message,true);paint(true);return null;}};
 const detailFor=state=>({project_id:state.id,candidate_id:state.kind==='preview'?state.id:null,source:state.kind});
 const nativeById=id=>[...document.querySelectorAll('audio[data-candidate]')].find(audio=>audio.dataset.candidate===id)||null;
 function registerPreviewSong(song){
  if(!song||typeof song.id!=='string'||!song.id)throw Error('歌曲标识无效。');
  registeredSongs.set(song.id,{...registeredSongs.get(song.id),...song});
  const existing=nativeById(song.id),raw=song.media?.complete||song.media?.stream;
  if(existing?.getAttribute('src')&&(!ownedAudio.has(song.id)||!raw||!existing.paused))return existing;
  if(!raw)return existing||null;
  let url;try{url=new URL(raw,location.href);}catch{throw Error('歌曲音频地址无效。');}
  if(url.origin!==location.origin)throw Error('请使用工作台提供的歌曲音频地址。');
  const audio=existing||document.createElement('audio');
  if(!existing){audio.hidden=true;audio.preload='none';audio.dataset.candidate=song.id;audio.dataset.playerOwnedPreview='true';footer.append(audio);ownedAudio.set(song.id,audio);}
  if(audio.getAttribute('src')!==url.href){const resumeAt=audio.currentTime||0;audio.src=url.href;if(resumeAt>0)audio.dataset.playerResumeAt=String(resumeAt);}
  audio.dataset.url=raw;return audio;
 }
 function previewSong(audio){
  const id=audio.dataset.candidate,card=audio.closest('[data-candidate-card]'),batch=audio.closest('.studio-batch'),song=songById(id)||{};
  return {...song,id,title:song.title||batch?.querySelector('h3')?.textContent||'歌曲候选',duration:seconds(audio.duration)||song.duration_seconds||song.duration||0,candidate_label:card?.querySelector('strong')?.textContent||song.candidate_label||'原始歌曲'};
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
 function cancelPending(){nativeIntent++;controller.cancelPending();clearTimeout(seekTimer);}
 function pause(){manualPause=true;pendingMessage='';cancelPending();controller.pause();if(preview)preview.pause();paint(true);}
 async function playPreview(audio,{at}={}){
  cancelPending();const token=nativeIntent;nativeRequests.set(audio,token);
  manualPause=false;pendingMessage='';if(preview&&preview!==audio)preview.pause();preview=audio;sourceKind='preview';controller.pause();
  audio.muted=false;audio.volume=engine.transport.state().volume;
  const resumeAt=at??(audio.dataset.playerResumeAt!==undefined?Number(audio.dataset.playerResumeAt):undefined);delete audio.dataset.playerResumeAt;
  if(resumeAt!==undefined||audio.ended){const value=Math.max(0,Number(resumeAt)||0);try{audio.currentTime=Number.isFinite(audio.duration)?Math.min(audio.duration,value):value;}catch{audio.addEventListener('loadedmetadata',()=>{if(token===nativeIntent)audio.currentTime=Math.min(audio.duration,value);},{once:true});}}
  try{await audio.play();if(token!==nativeIntent){if(nativeRequests.get(audio)===token)audio.pause();return{superseded:true};}paint(true);return{played:true,project_id:audio.dataset.candidate};}
  catch(error){if(token!==nativeIntent)return{superseded:true};throw error;}
  finally{if(nativeRequests.get(audio)===token)nativeRequests.delete(audio);}
 }
 async function playSong(id,options={}){
  const state=current();
  if(options.toggle!==false&&!controller.working&&state.id===id&&state.playing){pause();return{paused:true,project_id:id};}
  const song=songById(id);
  if(song?.project_ready===false){const audio=registerPreviewSong(song);if(!audio)throw Error('完整歌曲尚未准备好，请稍后再试听。');return playPreview(audio,options);}
  cancelPending();manualPause=false;pendingMessage='';sourceKind='engine';if(preview)preview.pause();preview=null;
  const result=await controller.playSong(id,options);paint(true);return result;
 }
 async function toggle(){
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
 function chooseShuffled(choices,id,direction){
  const ids=choices.map(item=>item.id),key=ids.join('|');
  if(key!==shuffleContext){shuffleContext=key;shuffleBag=[];shuffleHistory=[];}
  if(direction<0){while(shuffleHistory.length){const prior=shuffleHistory.pop();if(prior!==id&&ids.includes(prior))return choices.find(item=>item.id===prior);}}
  shuffleBag=shuffleBag.filter(value=>value!==id&&ids.includes(value));
  if(!shuffleBag.length)shuffleBag=ids.filter(value=>value!==id);
  if(!shuffleBag.length)return choices[0];
  const at=Math.floor(Math.random()*shuffleBag.length),next=shuffleBag.splice(at,1)[0];return choices.find(item=>item.id===next);
 }
 async function skip(direction){
  const state=current();manualPause=false;if(direction<0&&state.time>3){await seekTo(0);return;}
  const choices=contextChoices(state);if(!choices.length)return;
  const index=choices.findIndex(item=>item.id===state.id),next=shuffle?chooseShuffled(choices,state.id,direction):choices[(Math.max(0,index)+direction+choices.length)%choices.length];
  if(!next)return;
  if(next.audio)await playPreview(next.audio,{at:0});else await playSong(next.id,{toggle:false,at:0});
  if(shuffle&&direction>0&&state.id&&state.id!==next.id)shuffleHistory.push(state.id);
 }
 async function seekTo(at){
  clearTimeout(seekTimer);const state=current();at=Math.max(0,Math.min(state.duration,Number(at)||0));
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
  if(action==='shuffle'){shuffle=!shuffle;shuffleBag=[];shuffleHistory=[];paint(true);}
  if(action==='mute'){const state=current();changeVolume(state.volume>0?0:lastNonzero);}
  if(action==='loop'){loop=!loop;paint(true);}
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
 document.addEventListener('play',onNativePlay,true);
 const previousPausePreviews=window.pauseGenerationPreview;
 const pauseAllPreviews=()=>{previousPausePreviews?.();if(preview)preview.pause();};
 window.pauseGenerationPreview=pauseAllPreviews;
 function onDocumentClick(event){if(!footer.contains(event.target))closeMenu();}
 function onKey(event){if(event.key==='Escape')closeMenu();if(isPlaybackSpace(event,{modalOpen:!!document.querySelector('dialog[open]')})){event.preventDefault();void safe(toggle);}}
 document.addEventListener('click',onDocumentClick);document.addEventListener('keydown',onKey);
 function paint(force=false){
  if(closed)return;const state=current(),song=state.song||{},busy=controller.working;
  if(footer.dataset.playing!==String(state.playing))footer.dataset.playing=String(state.playing);
  const mk=JSON.stringify([state.id,song.title,song.cover_url,song.artwork,state.kind,song.candidate_label]);
  if(mk!==metadataKey){metadataKey=mk;q('[data-player-title]').textContent=studio.displaySongTitle?.(song.title)||song.title||'选择一首歌';q('[data-player-subtitle]').textContent=state.kind==='preview'?song.style||song.candidate_label||'原始歌曲':song.style||'当前作品';footer.dataset.songId=state.id||'';footer.dataset.source=state.kind;updateCover(song);}
  setIcon(playButton,state.playing?'pause':'play');playButton.setAttribute('aria-label',state.playing?'暂停歌曲':'播放歌曲');playButton.setAttribute('aria-pressed',String(state.playing));playButton.disabled=!state.id;
  const like=q('[data-player="favorite"]'),liked=!!song.favorite;like.setAttribute('aria-pressed',String(liked));like.setAttribute('aria-label',liked?'取消收藏当前歌曲':'收藏当前歌曲');
  const random=q('[data-player="shuffle"]');random.setAttribute('aria-pressed',String(shuffle));random.setAttribute('aria-label',shuffle?'关闭随机播放':'开启随机播放');
  const repeat=q('[data-player="loop"]');repeat.setAttribute('aria-pressed',String(loop));repeat.setAttribute('aria-label',loop?'关闭单曲循环':'开启单曲循环');
  for(const key of ['favorite','share','more','details','details-toggle','queue'])for(const button of footer.querySelectorAll(`[data-player="${key}"]`))button.disabled=!state.id;
  if(state.volume>0)lastNonzero=state.volume;
  const mute=q('[data-player="mute"]');setIcon(mute,state.volume>0?'volume-2':'volume-x');mute.setAttribute('aria-pressed',String(state.volume===0));mute.setAttribute('aria-label',state.volume>0?'播放器静音':'恢复播放器音量');
  if(document.activeElement!==volume)volume.value=Math.round(state.volume*100);volume.setAttribute('aria-valuetext',`${Math.round(state.volume*100)}%`);
  seek.disabled=!state.ready||busy||!state.duration;seek.max=state.duration||0;
  if(!scrubbing){seek.value=Math.min(state.duration,state.time)||0;q('[data-player-position]').textContent=clock(state.time);paintProgress(state.time,state.duration);}
  seek.setAttribute('aria-valuetext',`${clock(state.time)}，共${clock(state.duration)}`);q('[data-player-duration]').textContent=clock(state.duration);
  const text=(studio.statusIsTransient?.(pendingMessage)?'':pendingMessage)||(busy?'正在载入歌曲…':'');q('[data-player-status]').hidden=!text;if(q('[data-player-status]').textContent!==text)q('[data-player-status]').textContent=text;
  const sk=JSON.stringify([state.id,state.kind,state.playing,busy]);if(sk!==stateKey){stateKey=sk;onStateChange?.({...state,busy});root.dispatchEvent(new CustomEvent('osmanthus:playback',{detail:{id:state.id,kind:state.kind,playing:state.playing,busy},bubbles:true}));}
  const ended=lastId===state.id&&lastPlaying&&!state.playing&&!manualPause&&!busy&&state.duration>0&&state.time>=state.duration-.08&&lastTime<state.duration;
  lastPlaying=state.playing;lastTime=state.time;lastId=state.id;
  if(ended&&!pendingLoop){pendingLoop=true;void safe(async()=>{if(loop){if(state.kind==='preview')await playPreview(preview,{at:0});else await playSong(state.id,{toggle:false,at:0});}else await skip(1);}).finally(()=>{pendingLoop=false;});}
 }
 function tick(now){if(closed)return;frame=requestAnimationFrame(tick);if(now-lastFrame<40)return;lastFrame=now;paint();}
 icons();paint(true);frame=requestAnimationFrame(tick);
 const result={playSong,pause,cancelPending,registerPreviewSong,sync:()=>paint(true),get state(){return{...current(),busy:controller.working,loop,shuffle};},destroy(){closed=true;cancelPending();controller.destroy();cancelAnimationFrame(frame);clearTimeout(seekTimer);for(const audio of ownedAudio.values()){audio.pause();audio.removeAttribute('src');audio.load();audio.remove();}ownedAudio.clear();if(window.pauseGenerationPreview===pauseAllPreviews)window.pauseGenerationPreview=previousPausePreviews;footer.removeEventListener('click',onClick);document.removeEventListener('play',onNativePlay,true);document.removeEventListener('click',onDocumentClick);document.removeEventListener('keydown',onKey);footer.remove();}};
 Object.defineProperty(window,'osmanthusPlaybackState',{configurable:true,get:()=>result.state});return result;
}
