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
   if(error.status===404){change('missing','上一次请求尚未被接受，可以继续原请求，或取消后重新填写。');return{kind:'missing'};}
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

export function creationProgress(value){
 const batch=value.batch||value,candidates=batch.candidates||[];
 if(value.error||batch.error)return value.error||batch.error;
 if(['preparing','separating'].includes(batch.stage))return '正在准备歌曲音轨，可继续试听';
 if(batch.stage==='ready')return '歌曲已就绪，可以继续编辑';
 if(batch.stage==='preparation_error')return '歌曲已生成，音轨准备未完成，请查看任务提示';
 if(batch.stage==='error')return '本次生成未完成，请查看任务提示';
 const complete=candidates.filter(c=>c.media?.complete||c.download_ready).length;
 if(candidates.length&&complete===candidates.length)return '两版歌曲已生成，试听后选择喜欢的一版';
 if(complete)return '已有完整歌曲可试听，另一版仍在生成';
 if(candidates.some(c=>c.media?.stream))return '已可试听，模型正在完成整首歌曲';
 if(candidates.some(c=>c.status==='done'))return '模型已完成，正在接收完整音频';
 return batch.instrumental?'正在生成纯音乐，请稍候':candidates.length?'模型正在生成歌曲，请稍候':'正在创作歌词，请稍候';
}
export function candidateProgress(candidate,fallback){
 if(candidate.media?.complete||candidate.download_ready)return fallback;
 if(candidate.media?.stream)return '可试听 · 正在完成整曲';
 if(candidate.status==='done')return '正在接收完整音频';
 return fallback;
}
