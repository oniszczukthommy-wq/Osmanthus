// Shared by the guided MV page and server. All times are original-song seconds.
export const DIRECTOR_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
export const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Math.round(value * 1000) / 1000;
export function timedLyrics(project) {
  return (project.lyrics || []).map((line, index) => ({...line, index}))
    .filter(line => Number.isFinite(line.start) && Number.isFinite(line.end) && line.start >= 0 && line.end > line.start && line.end <= project.source.duration + .15 && typeof line.text === 'string')
    .sort((a, b) => a.start - b.start);
}
export function selectMusicRange(project, selection) {
  const total = project.source?.duration;
  if (!Number.isFinite(total) || total < 2 || total > 1200) throw Error('歌曲时长不可用');
  let start, end;
  if (selection?.mode === 'full') { start = 0; end = total; }
  else if (selection?.mode === 'lyrics') {
    const lines = timedLyrics(project), from = selection.from, to = selection.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= lines.length) throw Error('请选择一句或连续多句歌词');
    start = Math.max(0, lines[from].start - .18); end = Math.min(total, lines[to].end + .3);
    if (selection.start !== undefined) start = selection.start;
    if (selection.end !== undefined) end = selection.end;
  } else if (selection?.mode === 'range') { start = selection.start; end = selection.end; }
  else throw Error('请选择歌词、时间片段或整首歌曲');
  if (![start, end].every(Number.isFinite) || start < 0 || end > total + .001 || end - start < 2 || end - start > 600) throw Error('音乐范围需为歌曲内的 2 秒至 10 分钟');
  return {mode: selection.mode, start: round(start), end: round(end), duration: round(end - start), ...(selection.mode === 'lyrics' ? {from: selection.from, to: selection.to} : {})};
}

// Phrase endings take precedence over detected acoustic accents. These are
// editing suggestions, not a claim of precise beat/downbeat transcription.
export function musicSlots(project, range, analysis = {}) {
  const lyrics = timedLyrics(project);
  const candidates = [...lyrics.map(l => ({time: l.end + .12, weight: 1.4})), ...(analysis.accents || []).map(time => ({time, weight: .25}))];
  const cuts = [range.start];
  while (range.end - cuts.at(-1) > 10) {
    const last = cuts.at(-1), energy = (analysis.energy || []).filter(x => x.time >= last && x.time < last + 8);
    const mean = energy.reduce((n, x) => n + x.value, 0) / Math.max(1, energy.length);
    const target = last + (mean > .6 ? 5 : 7);
    const valid = candidates.filter(x => x.time - last >= 3 && x.time - last <= 10 && range.end - x.time >= 2);
    valid.sort((a, b) => (Math.abs(a.time - target) - a.weight) - (Math.abs(b.time - target) - b.weight));
    cuts.push(round(valid[0]?.time ?? Math.min(last + 7, range.end - 2)));
  }
  cuts.push(range.end);
  return cuts.slice(0, -1).map((start, i) => {
    const end = cuts[i + 1];
    return {id: `shot-${i + 1}`, start, end, duration: round(end - start), lyrics: lyrics.filter(l => l.end > start && l.start < end).map(l => ({start: l.start, end: l.end, text: l.text}))};
  });
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw Error(`${label}内容不完整`);
  return value.trim();
}
export function validateCreativePlan(raw, slots) {
  if (!raw || !Array.isArray(raw.characters) || raw.characters.length > 3 || !Array.isArray(raw.scenes) || !raw.scenes.length || raw.scenes.length > 8 || !Array.isArray(raw.shots) || raw.shots.length !== slots.length) throw Error('角色、场景或分镜数量不完整');
  const entities = (list, prefix) => list.map((e, i) => ({id: `${prefix}-${i + 1}`, name: text(e.name, 60, '名称'), description: text(e.description, 650, '形象描述')}));
  const characters = entities(raw.characters, 'character'), scenes = entities(raw.scenes, 'scene');
  const shots = raw.shots.map((s, i) => {
    if (s.id !== slots[i].id || !scenes.some(x => x.id === s.sceneId) || !Array.isArray(s.characterIds) || s.characterIds.length > 2 || new Set(s.characterIds).size !== s.characterIds.length || s.characterIds.some(id => !characters.some(c => c.id === id))) throw Error('分镜关联的角色或场景不完整');
    return {...slots[i], name: text(s.name, 60, '分镜名称'), description: text(s.description, 650, '镜头描述'), sceneId: s.sceneId, characterIds: s.characterIds};
  });
  return {summary: text(raw.summary, 600, '方案说明'), style: text(raw.style, 300, '整体画风'), characters, scenes, shots};
}
export function affectedShots(plan, target) {
  if (target === 'all') return plan.shots.map(s => s.id);
  if (plan.shots.some(s => s.id === target)) return [target];
  if (plan.characters.some(s => s.id === target)) return plan.shots.filter(s => s.characterIds.includes(target)).map(s => s.id);
  if (plan.scenes.some(s => s.id === target)) return plan.shots.filter(s => s.sceneId === target).map(s => s.id);
  throw Error('请选择要修改的角色、场景或分镜');
}
export function applyCreativeEdit(plan, target, response) {
  const result = clone(plan); affectedShots(result, target);
  if (target === 'all') return validateCreativePlan(response, result.shots.map(({id, start, end, duration, lyrics}) => ({id, start, end, duration, lyrics})));
  const item = [...result.characters, ...result.scenes, ...result.shots].find(x => x.id === target);
  item.name = text(response.name, 60, '名称'); item.description = text(response.description, 650, '修改描述');
  return result;
}
export function previewRecipe(plan, item, ratio, references = []) {
  const isShot = item.id.startsWith('shot-');
  const dependencies = isShot ? [...item.characterIds, item.sceneId] : [];
  const details = dependencies.map(id => [...plan.characters, ...plan.scenes].find(x => x.id === id));
  const prompt = `${plan.style}。${isShot ? 'MV单个镜头关键画面，参考图中的角色和场景保持一致。' : item.id.startsWith('character-') ? 'MV角色形象设定，单人清晰全身形象，保持外貌和服装。' : 'MV场景设定，展示空间、光线和环境。'}${item.description}。${details.map(x => x.description).join('。')}。无文字、无拼贴、无字幕。`.slice(0, 1200);
  return {prompt, ratio, dependencies, references: isShot ? [] : references};
}
export function videoRecipe(shot, image, ratio) {
  return {prompt: `${shot.description}。保持首帧的主体外貌、服装、场景和画风。自然连续运动，画面不添加文字。`, ratio, duration: Math.max(2, Math.ceil(shot.duration)), image: {material_id: image.materialId}};
}
