// Microphone audio is transcribed locally; text stays a draft until Send is clicked.
export function initializeSpeech(studio){
 const button=document.getElementById('studio-record'),input=document.getElementById('prompt');
 if(!button||!input||!studio?.engine)return;
 const report=document.createElement('div');report.id='studio-speech-status';report.className='studio-status';report.setAttribute('role','status');report.setAttribute('aria-live','polite');button.closest('form').after(report);
 const preview=document.createElement('div');preview.id='studio-speech-result';preview.hidden=true;report.after(preview);
 let operation=null,sequence=0;
 const recordLabel='语音输入',support=!!navigator.mediaDevices?.getUserMedia&&typeof MediaRecorder!=='undefined';
 function label(text,recording=false){button.setAttribute('aria-label',text);button.setAttribute('aria-pressed',String(recording));button.textContent=recording?'停止录音':recordLabel;button.title=text;}
 function message(text,error=false){report.textContent=text;report.classList.toggle('error',error);}
 function stopTracks(op){op.stream?.getTracks().forEach(t=>t.stop());clearTimeout(op.timer);clearInterval(op.watch);}
 function state(){return studio.engine.getProject();}
 function sameProject(op){return state()?.id===op.projectId;}
 function sameSelection(op){const current=window.trackEditorState?.selection;return current&&JSON.stringify(current)===JSON.stringify(op.selection);}
 function insert(op,text){
  if(!sameProject(op)||studio.page!=='editor'){message('歌曲已经切换，保留了识别结果，请回到原歌曲编辑页再填入。',true);return;}
  if(op.selection&&!sameSelection(op))studio.engine.setSelection(op.selection.track_id,op.selection.start_seconds,op.selection.end_seconds);
  input.value=(input.value.trim()?input.value.trim()+'\n':'')+text;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();preview.hidden=true;
  message('识别文字已填入，请核对后再点击“发送修改”。');
 }
 function showTranscript(op,text){
  preview.replaceChildren();const p=document.createElement('p');p.textContent=text;p.className='studio-transcript';const insertButton=document.createElement('button');insertButton.type='button';insertButton.textContent='填入识别结果';insertButton.onclick=()=>insert(op,text);preview.append(p,insertButton);preview.hidden=false;
  if(sameProject(op)&&sameSelection(op)&&input.value===op.originalDraft&&studio.page==='editor')insert(op,text);
  else message('语音已识别。输入或选区已经变化，请核对后填入；尚未修改歌曲。');
 }
 async function upload(op,blob){
  const response=await fetch('/api/speech/jobs',{method:'POST',headers:{'Content-Type':blob.type||'audio/webm','X-Request-Id':op.id,'X-Project-Id':op.projectId,'X-Project-Revision':String(op.revision)},body:blob});
  const job=await response.json();if(!response.ok)throw Error(job.error||'语音提交失败');return job;
 }
 async function transcribe(op,blob){
  if(op.cancelled||operation!==op)return;
  button.disabled=true;message('正在本机识别语音…');
  try{
   let job=await upload(op,blob);const deadline=performance.now()+180000;
   while(operation===op&&!op.cancelled&&['queued','decoding','transcribing'].includes(job.stage)){
    if(performance.now()>deadline)throw Error('语音识别等待较久，任务已保留，请稍后重试或手动输入。');
    await new Promise(resolve=>setTimeout(resolve,800));job=await studio.api('/api/speech/jobs/'+op.id);
   }
   if(operation!==op||op.cancelled)return;
   if(job.project_id!==op.projectId)throw Error('识别结果与录音歌曲不匹配');
   if(job.stage!=='ready')throw Error(job.error||'语音识别尚未完成');
   showTranscript(op,job.text);
  }catch(error){if(operation===op&&!op.cancelled)message(error.message,true);}
  finally{if(operation===op){operation=null;button.disabled=false;label(recordLabel);}}
 }
 function stopRecording(cancelled=false){const op=operation;if(!op)return;op.cancelled=cancelled;
  if(op.recorder&&op.recorder.state!=='inactive')op.recorder.stop();stopTracks(op);label(recordLabel);
  if(cancelled){operation=null;sequence++;button.disabled=false;message('录音已取消，歌曲没有修改。');}
 }
 async function begin(){
  const project=state();if(!support)throw Error('当前浏览器不支持麦克风录音，请在 Chrome 等桌面浏览器中打开工作台。');
  if(!project||studio.page!=='editor')throw Error('请先打开要修改的歌曲。');
  if(!studio.engine.ready())throw Error('歌曲音轨正在准备，请稍后录音。');
  const op={id:crypto.randomUUID(),projectId:project.id,revision:project.revision,selection:window.trackEditorState?.selection,originalDraft:input.value,parts:[],cancelled:false,serial:++sequence};operation=op;button.disabled=true;preview.hidden=true;message('请允许浏览器使用麦克风。');
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});op.stream=stream;
   if(operation!==op||op.cancelled||!sameProject(op)||studio.page!=='editor'){stopTracks(op);if(operation===op){operation=null;button.disabled=false;label(recordLabel);message('录音目标已经变化，请回到歌曲编辑页重新录音。');}return;}
   // Avoid transcribing our own playback as the requested edit.
   studio.engine.pause();window.pauseGenerationPreview?.();window.pauseScorePreview?.();window.pauseCandidatePreview?.();window.pauseSVCPreview?.();window.pauseVoiceLibraryPreview?.();
   const type=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
   const recorder=new MediaRecorder(stream,type?{mimeType:type}:{});op.recorder=recorder;
   recorder.ondataavailable=e=>{if(e.data.size)op.parts.push(e.data);};
   recorder.onerror=()=>{stopRecording(true);message('麦克风录音中断，请重试。',true);};
   recorder.onstop=()=>{stopTracks(op);if(op.cancelled||operation!==op)return;const blob=new Blob(op.parts,{type:recorder.mimeType||type||'audio/webm'});if(!blob.size){operation=null;button.disabled=false;message('没有收到录音，请重试。',true);return;}void transcribe(op,blob);};
   recorder.start(1000);button.disabled=false;label('停止语音录音',true);message('正在录音，点击停止后识别。最多60秒。');
   op.timer=setTimeout(()=>{message('已达到录音时长，正在识别…');stopRecording();},59000);
   op.watch=setInterval(()=>{if(!sameProject(op)||studio.page!=='editor')stopRecording(true);},300);
  }catch(error){stopTracks(op);if(operation===op){operation=null;button.disabled=false;label(recordLabel);message(error.name==='NotAllowedError'?'麦克风未获授权，请在浏览器权限中允许后重试。':error.message||'无法打开麦克风',true);}}
 }
 label(recordLabel);button.disabled=!support;
 if(!support)button.title='此浏览器不支持录音，请使用桌面 Chrome';
 button.onclick=()=>{if(operation?.recorder?.state==='recording')stopRecording();else if(!operation)void studio.guarded(begin);};
 window.addEventListener('pagehide',()=>stopRecording(true));
 window.osmanthusSpeech={cancel:()=>stopRecording(true),get state(){return operation?{recording:operation.recorder?.state==='recording',projectId:operation.projectId,requestId:operation.id}:null;}};
}
