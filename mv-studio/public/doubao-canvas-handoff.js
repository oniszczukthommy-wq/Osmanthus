// The consumer website is a manual handoff, not a generation API.
export const DOUBAO_URL = 'https://www.doubao.com/chat/';

export function doubaoPrompt(value) {
  const prompt = String(value ?? '').trim();
  if (!prompt) throw Error('请先填写这个画框的提示词');
  return prompt;
}

export function doubaoImportPlan({expected, currentProjectId, nodes, item}) {
  if (!expected || currentProjectId !== expected.projectId) throw Error('工程已切换，素材已保留在素材库，请回到原工程重新导入');
  const node = nodes.find(n => n.id === expected.nodeId);
  if (!node || node.type !== expected.type) throw Error('原画框不存在或类型已改变，素材已保留在素材库');
  if ((item?.kind || item?.type) !== node.type) throw Error('素材类型与画框不一致，素材已保留在素材库');
  return {node, addVersion: !!node.asset?.url};
}
