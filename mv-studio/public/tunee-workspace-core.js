export function workspacePrefix(pathname){return pathname.startsWith('/mv/')?'/mv':'';}
export function workspaceLocal(pathname,path){
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\\\x00-\x1f\x7f]/.test(path))throw Error('无效的本地地址');
  return workspacePrefix(pathname)+path;
}
export function selectedImport(session,materials,id){
  const info=session?.importedShots?.[id];if(!info)return null;
  const selected=info.versions?.find(v=>v.id===info.selected);if(!selected)return null;
  const material=materials.find(m=>m.id===selected.materialId);
  return {...selected,valid:info.valid===true,url:material?.url};
}
export function readyShotPath(session,job,shot){
  if(session?.planStale||session?.importedShots?.[shot?.id]?.selected)return '';
  const candidate=session?.shotVideos?.[shot?.id];
  if(typeof candidate==='string'&&/^\/files\/(wan3-tasks|seedance25-video|aliyun-video)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/video\.mp4$/.test(candidate))return candidate;
  if(job?.session_id!==session?.id||job?.revision!==session?.revision)return '';
  const v=job?.shots?.find(x=>x.id===shot.id);if(v?.status!=='ready'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.taskId||''))return '';
  const mode=session.productionMode,folder=mode==='lip-sync'?'wan3-tasks':mode?'seedance25-video':'aliyun-video';
  return `/files/${folder}/${v.taskId}/video.mp4`;
}
export function safeOutputHistory(session){
  if(!Array.isArray(session?.outputs))return [];
  return session.outputs.filter(x=>x&&typeof x.url==='string'&&/^\/files\/mv-director\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/mv\.mp4$/.test(x.url));
}
export function safeCandidatePath(value){
  return typeof value==='string'&&/^\/files\/materials\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|jpeg|webp|gif)$/.test(value)?value:'';
}
