// Pause once while dragging, commit once on release, and invalidate late resumes.
export function initializeSeekControl({input,getProject,getTime,getEnd,isPlaying,canSeek,pause,setTime,resume,onSeek=()=>{},onError=()=>{}}){
 input.step='any';
 let drag=null,serial=0;
 const view=input.ownerDocument.defaultView;
 const clamp=value=>Math.max(0,Math.min(getProject()?.duration||0,Number(value)||0));
 function apply(value,previous,token){const project=getProject();if(!project||project.id!==previous.id)return;
  const at=clamp(value);setTime(at);input.value=at;onSeek(at);
  if(previous.playing&&at<project.duration)Promise.resolve(resume(at,previous.end>at?previous.end:project.duration,()=>token===serial&&getProject()?.id===previous.id)).catch(onError);
 }
 function start(event){if(!canSeek()){event.preventDefault();return;}const p=getProject();serial++;drag={id:p.id,playing:isPlaying(),end:getEnd(),at:getTime()};pause();}
 function move(){if(!canSeek())return;const p=getProject();if(!p)return;if(drag){if(drag.id===p.id)setTime(clamp(input.value));return;}
  const previous={id:p.id,playing:isPlaying(),end:getEnd()};pause();apply(input.value,previous,++serial);
 }
 function finish(event){if(!drag)return;const previous=drag;drag=null;apply(event?.type==='pointercancel'?previous.at:input.value,previous,serial);}
 input.addEventListener('pointerdown',start);input.addEventListener('input',move);input.addEventListener('change',finish);
 view.addEventListener('pointerup',finish);view.addEventListener('pointercancel',finish);
 return {get dragging(){return !!drag&&drag.id===getProject()?.id;},destroy(){serial++;drag=null;input.removeEventListener('pointerdown',start);input.removeEventListener('input',move);input.removeEventListener('change',finish);view.removeEventListener('pointerup',finish);view.removeEventListener('pointercancel',finish);}};
}
