// The web handoff only prepares text and reference choices. It does not call
// Doubao or claim that reference images guarantee character consistency.
export function imageHandoff(plan, itemId, ratio) {
  const characters=Array.isArray(plan?.characters)?plan.characters:[];
  const scenes=Array.isArray(plan?.scenes)?plan.scenes:[];
  const shots=Array.isArray(plan?.shots)?plan.shots:[];
  const entity=[...characters,...scenes].find(item=>item.id===itemId);
  const shot=shots.find(item=>item.id===itemId);
  if(!entity&&!shot)throw Error('找不到当前素材');
  const prefix=[`画面风格：${plan.style||'与当前 MV 视觉风格保持一致'}`,`画面比例：${ratio||'16:9'}`];
  if(entity){
    const isCharacter=characters.some(item=>item.id===entity.id);
    const prompt=[...prefix,`制作${isCharacter?'角色定妆图':'场景设定图'}：${entity.name||''}`,`具体描述：${entity.description||''}`,
      isCharacter?'清楚展示角色的脸部、发型、服装和整体造型，便于后续镜头保持一致。':'展示清楚场景布局、环境细节和光线，便于后续镜头保持一致。',
      '只生成一张完整画面，不添加文字、水印或分格。'].join('\n');
    return {prompt,referenceIds:[]};
  }
  const relatedCharacters=characters.filter(item=>(shot.characterIds||[]).includes(item.id));
  const scene=scenes.find(item=>item.id===shot.sceneId);
  const prompt=[...prefix,`制作 MV 单镜关键帧：${shot.name||''}`,`画面描述：${shot.description||''}`,
    ...relatedCharacters.map(item=>`角色 ${item.name||''}：${item.description||''}`),
    ...(scene?[`场景 ${scene.name||''}：${scene.description||''}`]:[]),
    '如有上传参考图，请尽量参考已确认角色的面容、服装以及场景风格。只生成一张完整画面，不添加文字、水印或分格。'].join('\n');
  return {prompt,referenceIds:[...relatedCharacters.map(item=>item.id),...(scene?[scene.id]:[])]};
}
