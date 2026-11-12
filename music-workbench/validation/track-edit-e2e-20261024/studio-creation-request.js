// A form draft is separate from submission recovery and never starts a request.
// A per-tab shadow protects edits if another tab has changed the shared draft.
export function createBrowserDraft({storage,session,key,onWarning=()=>{}}){
 const shadowKey=key+':tab';let observed=null,locked=false;
 const parse=raw=>{try{const item=JSON.parse(raw);return item&&item.version===1&&item.value&&typeof item.value==='object'?item.value:null;}catch{return null;}};
 const warn=text=>onWarning(text);
 const read=(target,name)=>{try{return target?.getItem(name)??null;}catch{return null;}};
 const write=(target,name,value)=>{try{if(!target)return false;target.setItem(name,value);return true;}catch{return false;}};
 function load(){
  observed=read(storage,key);const shared=parse(observed),shadowRaw=read(session,shadowKey);let shadow=null;
  try{const data=JSON.parse(shadowRaw);if(data&&typeof data.base==='string'||data&&data.base===null)shadow=data;}catch{}
  const local=shadow&&parse(shadow.raw);
  if(local&&shadow.base!==observed){locked=true;warn('其他标签页的草稿已变化，当前修改暂存在本标签页，请复制保存后再处理。');return local;}
  if(observed!==null&&!shared){locked=true;warn('已有本地草稿无法读取，请先备份当前内容。');return local;}
  return shared||local;
 }
 function save(value){
  const raw=JSON.stringify({version:1,value});
  const shadow=write(session,shadowKey,JSON.stringify({base:observed,raw}));
  let current;try{current=storage?.getItem(key)??null;}catch{current=undefined;}
  if(current===undefined){warn(shadow?'草稿仅暂存在当前标签页，请复制保存重要内容。':'草稿无法保存，请复制保存当前内容。');return false;}
  if(locked||current!==observed){locked=true;warn(shadow?'其他标签页的草稿已变化，当前修改暂存在本标签页，请复制保存后再处理。':'草稿无法保存，请复制保存当前内容。');return false;}
  if(!write(storage,key,raw)){warn(shadow?'草稿仅暂存在当前标签页，请复制保存重要内容。':'草稿无法保存，请复制保存当前内容。');return false;}
  observed=raw;write(session,shadowKey,JSON.stringify({base:observed,raw}));warn('');return true;
 }
 return{load,save,lock:()=>{locked=true;}};
}

// Keep an uncertain music submission tied to its original id until the server
// identifies it, or atomically prevents that id from being accepted later.
export function createCreationRequestRecovery({api,storage,key='osmanthus-direct-generation-request',uuid=()=>crypto.randomUUID(),onAccepted=()=>{},onChange=()=>{}}){
 let pending=null,phase='idle',message='',working=false;
 try{pending=JSON.parse(storage.getItem(key)||'null');if(pending&&(!/^[a-f0-9-]{36}$/i.test(pending.id)||!pending.payload||!['simple','advanced'].includes(pending.payload.mode)))throw Error('invalid');}
 catch{phase='blocked';message='上一次创作的本地记录不完整，请先核对原任务。';pending={invalid:true};}
 const state=()=>({pending,phase,message,working});
 const change=(next,text='')=>{phase=next;message=text;onChange(state());};
 const clear=()=>{storage.removeItem(key);pending=null;};
 const accepted=flow=>{onAccepted(flow);clear();change('idle');return{kind:'accepted',flow};};
 async function lookup(){
  if(!pending)return{kind:'none'};
  if(pending.invalid)throw Error(message);
  change('checking','正在核对上一次创作请求…');
  try{return accepted(await api('/api/creation/jobs/'+pending.id));}
  catch(error){
   if(error.status===404&&!error.responseInvalid){change('missing','上一次请求尚未被接受，可以继续原请求，或取消后重新填写。');return{kind:'missing'};}
   change(error.status===409?'blocked':'unknown',error.message||'暂时无法确认上一次请求，请稍后重新检查。');throw error;
  }
 }
 async function perform(action){if(working)throw Error('正在核对创作请求，请稍候。');working=true;onChange(state());try{return await action();}finally{working=false;onChange(state());}}
 async function send(){
  change('submitting','正在创建歌曲…');
  try{return accepted(await api('/api/creation/jobs',{request_id:pending.id,...pending.payload}));}
  catch(error){change('unknown',error.message||'提交结果尚未确认，请检查原任务。');throw error;}
 }
 return{
  get state(){return state();},
  inspect:()=>perform(lookup),
  start:payload=>perform(async()=>{
   if(pending){const result=await lookup();if(result.kind==='accepted')return result;throw Error('请先继续原请求，或取消未接受的请求。');}
   pending={id:uuid(),payload:JSON.parse(JSON.stringify(payload))};
   // Persist before any POST. Storage failure must not launch paid work.
   storage.setItem(key,JSON.stringify(pending));return send();
  }),
  continue:()=>perform(async()=>{const result=await lookup();if(result.kind!=='missing')return result;return send();}),
  cancel:()=>perform(async()=>{
   const result=await lookup();if(result.kind!=='missing')return result;
   // A 404 alone is insufficient: the original POST could still arrive late.
   const response=await api('/api/creation/jobs/'+pending.id+'/cancel',{});
   if(response.creation)return accepted(response.creation);
   if(!response.cancelled)throw Error('无法确认请求已取消，请再次检查。');
   clear();change('idle');return{kind:'cancelled'};
  })
 };
}

export const generationIsBlocked=({creating,lyricsRequest,recovering})=>Boolean(creating||lyricsRequest||recovering);

// Report only stages actually supplied by the server, without estimating time.
const progressLabels={
 submitting:'正在提交创作请求…',
 lyrics:'正在准备歌词…',
 writing:'正在准备歌词…',
 queued:'创作任务已排队…',
 generating:'正在生成歌曲…',
 partially_available:'部分版本已可试听',
 awaiting_selection:'正在准备试听…',
 separating:'正在处理分轨…',
 preparing:'正在准备编辑音轨…',
};

export function creationProgress(value){
 const batch=value.batch||value,candidates=batch.candidates||[];
 if(value.error||batch.error)return value.error||batch.error;
 if(batch.stage==='preparation_error')return '音轨准备未完成，请重试';
 if(batch.stage==='error')return '本次创作未完成，请重试';
 if(batch.stage==='ready')return '可以继续编辑';
 const complete=candidates.filter(c=>c.media?.complete||c.download_ready).length;
 if(candidates.length&&complete===candidates.length)return '试听并选择喜欢的一版';
 if(candidates.some(c=>c.media?.complete||c.media?.preview_complete||c.media?.stream))return '可试听';
 return progressLabels[batch.stage]||'';
}
export function candidateProgress(candidate,fallback){
 if(candidate.stage==='error')return fallback||'请重试';
 if(candidate.media?.complete||candidate.download_ready)return fallback||'可试听';
 if(candidate.media?.preview_complete||candidate.media?.stream)return '可试听';
 return progressLabels[candidate.stage]||'';
}
