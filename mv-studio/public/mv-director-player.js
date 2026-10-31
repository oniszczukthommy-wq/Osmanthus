import {icon} from './icons.js';

// One persistent media element backs every listen button and the bottom transport.
export function mountDirectorPlayer(audio,{onError=()=>{}}={}){
  const get=id=>document.getElementById(id);
  const bar=get('song-bar'),toggle=get('music-toggle'),seek=get('music-seek'),volume=get('music-volume'),mute=get('music-mute'),loading=get('music-loading');
  let durationHint=0;
  const clock=n=>{const seconds=Math.max(0,Math.floor(Number.isFinite(n)?n:0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
  const fill=(el,value,max)=>el.style.setProperty('--fill',`${Math.min(100,Math.max(0,max?value/max*100:0))}%`);
  const setButton=(button,label,name)=>{button.setAttribute('aria-label',label);button.title=label;button.innerHTML=icon(name);};
  function syncProgress(){
    const duration=Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:durationHint;
    const current=Number.isFinite(audio.currentTime)?audio.currentTime:0;
    get('music-current').value=clock(current);get('music-duration').value=clock(duration);
    seek.max=String(duration||0);seek.value=String(current);seek.disabled=audio.readyState<1||!duration;
    seek.setAttribute('aria-valuetext',`${clock(current)} / ${clock(duration)}`);fill(seek,current,duration);
    get('music-restart').disabled=seek.disabled;
  }
  function syncPlayback(){
    const playing=!audio.paused&&!audio.ended;
    bar.classList.toggle('is-playing',playing);
    setButton(toggle,playing?'暂停歌曲':'播放歌曲',playing?'pause':'play');
    if(!playing)loading.hidden=true;
  }
  function syncVolume(){
    const silent=audio.muted||audio.volume===0;
    setButton(mute,silent?'取消歌曲静音':'静音歌曲',silent?'volume-off':'volume');
    mute.setAttribute('aria-pressed',String(silent));volume.value=String(audio.volume);
    fill(volume,audio.muted?0:audio.volume,1);
  }
  toggle.addEventListener('click',async()=>{
    if(!audio.paused){audio.pause();return;}
    try{if(audio.ended)audio.currentTime=0;await audio.play();}catch(e){if(e.name!=='AbortError')onError('歌曲暂时无法播放，请稍后重试。');}
  });
  get('music-restart').addEventListener('click',()=>{if(audio.readyState>=1){audio.currentTime=0;syncProgress();}});
  seek.addEventListener('input',()=>{if(!seek.disabled){audio.currentTime=Number(seek.value);syncProgress();}});
  volume.addEventListener('input',()=>{audio.volume=Number(volume.value);if(audio.volume>0)audio.muted=false;syncVolume();});
  mute.addEventListener('click',()=>{if(audio.muted||audio.volume===0){audio.muted=false;if(audio.volume===0)audio.volume=.7;}else audio.muted=true;syncVolume();});
  for(const event of ['timeupdate','durationchange','loadedmetadata','emptied'])audio.addEventListener(event,syncProgress);
  for(const event of ['play','pause','ended'])audio.addEventListener(event,syncPlayback);
  audio.addEventListener('volumechange',syncVolume);
  audio.addEventListener('waiting',()=>{if(!audio.paused)loading.hidden=false;});
  audio.addEventListener('playing',()=>{loading.hidden=true;syncPlayback();});
  audio.addEventListener('error',()=>{loading.hidden=true;syncPlayback();onError('歌曲音频未能加载，请刷新后重试。');});
  syncProgress();syncPlayback();syncVolume();
  return {setDuration(seconds){durationHint=Number(seconds)||0;syncProgress();}};
}
