// A shot's timed directions are stored as text in the existing validated
// description field; the backend does not yet have a structured segment API.
const HEADER='【镜头分段】';
const MAX_LENGTH=650;
const round=n=>Math.round(n*1000)/1000;
const stamp=n=>String(round(n));
const bad=message=>{throw Error(message)};

export function normalizeSegments(segments,duration){
  duration=Number(duration);
  if(!Number.isFinite(duration)||duration<=0||!Array.isArray(segments)||segments.length<1||segments.length>8)bad('请填写有效的镜头时间段');
  let previous=0;
  const rows=segments.map(row=>{
    const start=Number(row.start),end=Number(row.end),description=String(row.description??'').replace(/\r\n?/g,'\n').trim();
    if(!Number.isFinite(start)||!Number.isFinite(end)||Math.abs(start-previous)>.011||end<=start||end>duration+.011)bad('时间段需从 0 开始、连续排列并覆盖整个镜头');
    if(!description||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description))bad('请填写每个时间段的画面描述');
    previous=end;return {start:round(start),end:round(end),description};
  });
  if(Math.abs(previous-duration)>.011)bad('最后一段的结束时间必须等于镜头时长');
  return rows;
}

export function serializeSegments(segments,duration){
  const rows=normalizeSegments(segments,duration);
  const text=rows.length===1?rows[0].description:HEADER+'\n'+rows.map(r=>`${stamp(r.start)}～${stamp(r.end)}秒：${r.description.replace(/\s+/g,' ')}`).join('\n');
  if(text.length>MAX_LENGTH)bad('镜头描述最多 650 字，请精简各时间段');
  return text;
}

export function parseSegments(description,duration){
  const original=String(description||'');
  if(original.startsWith(HEADER+'\n')){
    const rows=original.slice(HEADER.length+1).split('\n').map(line=>{
      const match=/^(\d+(?:\.\d+)?)～(\d+(?:\.\d+)?)秒：(.+)$/.exec(line);
      return match?{start:Number(match[1]),end:Number(match[2]),description:match[3]}:null;
    });
    try{if(rows.every(Boolean))return normalizeSegments(rows,duration);}catch{}
  }
  return [{start:0,end:round(Number(duration)||0),description:original}];
}

export function splitLastSegment(segments,duration){
  const copy=segments.map(x=>({...x}));
  if(copy.length>=8)bad('最多添加 8 个时间段');
  const row=copy.at(-1),start=Number(row?.start),end=Number(row?.end),mid=round((start+end)/2);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end>Number(duration)+.011||mid<=start||mid>=end)bad('请先填写有效的最后时间段');
  copy[copy.length-1]={...row,start,end:mid};copy.push({start:mid,end,description:''});return copy;
}

export function buildShotEdit(plan,shotId,segments,sceneId,characterIds){
  const selected=plan?.shots?.find(shot=>shot.id===shotId);
  if(!selected||!Array.isArray(plan.scenes)||!Array.isArray(plan.characters)||!plan.scenes.some(scene=>scene.id===sceneId)||!Array.isArray(characterIds)||characterIds.length>2||new Set(characterIds).size!==characterIds.length||characterIds.some(id=>!plan.characters.some(ch=>ch.id===id)))bad('请选择已有的场景和最多两个角色');
  const description=serializeSegments(segments,selected.duration);
  return plan.shots.map(shot=>({id:shot.id,description:shot.id===shotId?description:shot.description,sceneId:shot.id===shotId?sceneId:shot.sceneId,characterIds:shot.id===shotId?[...characterIds]:[...shot.characterIds],...(typeof shot.musicStructure==='string'?{musicStructure:shot.musicStructure}:{})}));
}

export function validateRelipEstimate(estimate){
  if(!estimate||estimate.available!==true||estimate.canSubmit!==true)bad(estimate?.reason||'对口型服务暂不可用或当前镜头不能提交');
  const amount=Number(estimate.estimatedCostCny),remaining=Number(estimate.remainingCny),input=Number(estimate.inputDuration),output=Number(estimate.outputDuration);
  if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(remaining)||remaining<amount||!Number.isFinite(input)||input<=0||!Number.isFinite(output)||output<=0)bad('无法核实制作费用或可用额度，未提交任务');
  return {estimatedCostCny:amount,remainingCny:remaining,inputDuration:input,outputDuration:output};
}
