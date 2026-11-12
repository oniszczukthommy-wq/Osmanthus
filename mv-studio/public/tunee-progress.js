// Summarise only information already stored in a project. These labels do not
// claim tempo, genre or other audio characteristics have been analysed.
export function projectFacts(session, start, end) {
  const duration = Number(session?.source?.duration);
  const facts = [];
  if (Number.isFinite(duration) && duration >= 0) facts.push({label: '歌曲时长', seconds: duration});
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration)
    facts.push({label: '选择片段', start, end});
  const lines = Array.isArray(session?.lyrics) ? session.lyrics.filter(line => typeof line === 'string' ? line.trim() : typeof line?.text === 'string' && line.text.trim()).length : 0;
  if (lines) facts.push({label: '已载入歌词', lines});
  return facts;
}

// A selected imported version is authoritative: an invalid selected version
// never silently falls back to a previously generated clip.
export function shotReadiness(shotId, importedShots, selected, generatedUrl) {
  if (importedShots?.[shotId]?.selected) {
    return selected?.valid === true && typeof selected.url === 'string' && !!selected.url
      ? {ready: true, kind: 'imported', url: selected.url}
      : {ready: false, kind: 'stale', url: ''};
  }
  return typeof generatedUrl === 'string' && generatedUrl
    ? {ready: true, kind: 'generated', url: generatedUrl}
    : {ready: false, kind: 'missing', url: ''};
}

export function stageSummary({hasPlan = false, assetsTotal = 0, assetsConfirmed = 0, shotsTotal = 0, shotsReady = 0, hasOutput = false} = {}) {
  return [
    {id: 'blueprint', label: '创意蓝图', state: hasPlan ? '已设计' : '待设计'},
    {id: 'script', label: '创意脚本', state: hasPlan ? '可查看' : '待设计'},
    {id: 'assets', label: '角色与场景', state: !hasPlan ? '等待脚本' : assetsTotal ? `${assetsConfirmed}/${assetsTotal} 已确认` : '无角色与场景'},
    {id: 'storyboard', label: '故事板', state: !hasPlan ? '等待脚本' : `${shotsReady}/${shotsTotal} 可用镜头`},
    {id: 'result', label: '导出成片', state: hasOutput ? '可下载' : '待合成'},
  ];
}
