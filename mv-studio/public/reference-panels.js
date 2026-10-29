import { STYLES, STORIES } from './domain.js';
import { localUrl } from './integration.js';
import { icon } from './icons.js';

export const escapePanelText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const esc = escapePanelText;
const array = value => Array.isArray(value) ? value : [];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => { let n = 0; for (const c of String(value)) n = Math.imul(31, n) + c.charCodeAt(0) | 0; return Math.abs(n).toString(36); };
const categories = item => array(item.categories).length ? item.categories : item.category ? [item.category] : [];

export function safePanelMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const url = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(url)) return '';
  if (/^(?:https?:|blob:|data:(?:image|video|audio)\/)/i.test(url)) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('\\')) return '';
  return localUrl(url);
}

export function filterPanelItems(items, query = '', category = 'all') {
  const text = String(query).trim().toLocaleLowerCase();
  return array(items).filter(item => (category === 'all' || categories(item).includes(category)) && (!text || [item.name, item.title, item.author, item.note, item.description, ...categories(item)].join(' ').toLocaleLowerCase().includes(text)));
}

/** Accepts uploaded material, canvas node or reference catalog entry. */
export function normalizePanelMaterial(item, index = 0) {
  const reference = item?.asset || item || {};
  const mime = String(reference.mimeType || item?.mimeType || (String(item?.type || '').includes('/') ? item.type : ''));
  const rawType = item?.type || item?.kind || mime.split('/')[0];
  const type = ['image', 'video', 'audio', 'text'].includes(rawType) ? rawType : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'text';
  const url = String(reference.url || item?.url || item?.src || '');
  const asset = {};
  for (const key of ['id', 'name', 'mimeType', 'thumbnailUrl']) if (typeof reference[key] === 'string') asset[key] = reference[key];
  if (url) asset.url = url;
  if (mime) asset.mimeType = mime;
  if (Number.isFinite(reference.duration) && reference.duration >= 0) asset.duration = reference.duration;
  if (!asset.id && !asset.url) asset.id = String(item?.id || `local-${index}`);
  const rawCategory = String(item?.category || 'role');
  return {
    id: String(item?.id || reference.id || `material-${hash(url || item?.name || item?.title || index)}`),
    name: String(item?.name || item?.title || reference.name || '未命名素材'),
    type, url, thumbnailUrl: String(item?.thumbnailUrl || item?.image || reference.thumbnailUrl || (type === 'image' ? url : '')),
    category: ({ '角色': 'role', '场景': 'scene', '道具': 'prop', '合集': 'collection' })[rawCategory] || rawCategory, library: String(item?.library || 'assets'),
    era: String(item?.era || ''), region: String(item?.region || ''),
    content: String(item?.content || ''), note: String(item?.note || item?.description || ''),
    asset,
  };
}

const STYLE_CATEGORIES = ['漫剧', '真人剧', '3D', '国风', '2D', 'Q版', '游戏', '日漫', '欧美', '韩流'];
const REFERENCE_STYLES = ['现代都市', '日系治愈', '科学修仙', '怀旧记忆', '民国诡事'].map((name, index) => ({ id: `reference-${index}`, name, author: '公开风格参考', referenceOnly: true, note: '保存视觉方向参考，生成模型尚未接入。', categories: [] }));
const MODEL_REFERENCES = [
  ['oii-image-fast', 'Oii Image 2.5 Fast', 'image', '高性能图片模型', 'New'],
  ['oii-image-pro', 'Oii Image 2.5 Pro', 'image', '高质量图片模型', 'Best'],
  ['oii-image-2', 'Oii Image 2', 'image', '图片生成', ''],
  ['seedream-5-pro', 'Seedream 5.0 Pro', 'image', '图片生成', ''],
  ['video-unconnected', 'AI 视频模型', 'video', '尚未接入视频执行端', ''],
  ['oii-eleven-v4', 'Oii Eleven V4', 'audio', '语音与情绪标签', ''],
].map(([id, name, category, description, badge]) => ({ id, name, category, description, badge, available: false }));
const DEFAULT_SKILLS = [
  { id: 'close', name: '镜头拉近', description: '让主体更清晰，使用现有取景调整。', prompt: '镜头拉近一点', icon: 'crop' },
  { id: 'soft', name: '动作自然', description: '缓和现有动作曲线。', prompt: '动作自然一点', icon: 'spark' },
  { id: 'warm', name: '暖色灯光', description: '调整当前画面的冷暖。', prompt: '灯光更温暖', icon: 'palette' },
  { id: 'pause', name: '情绪停顿', description: '在现有动作前留一点停顿。', prompt: '动作前稍作停顿', icon: 'pause' },
];
const LIBRARY_NAMES = { assets: '素材库' };
const ASSET_CATEGORIES = { role: '角色', scene: '场景', prop: '道具', collection: '合集' };
const MEDIA_NAMES = { all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本' };
const DEFAULT_SETTINGS = { grid: true, snap: true, showConnections: true, minimap: false, autosave: true };
const settingLabels = [
  ['grid', '显示网格', '在画布背景显示点阵，方便对齐。'],
  ['snap', '吸附对齐', '拖动材料时吸附到网格。'],
  ['showConnections', '显示连线', '显示材料之间保存的引用关系。'],
  ['minimap', '显示小地图', '查看材料分布和当前视野。'],
  ['autosave', '自动保存', '修改画布后自动保存当前工程。'],
];

/**
 * callbacks: read(), configure(studioPatch, invalidate=false), toast(message),
 * listMaterials(context), listActors(context), listVoices(context),
 * uploadMaterials(File[], {purpose,library,category,era,region}),
 * onSelectAssets(materials), onStyle(style), onModel(model), onAgent(agent),
 * onSkill(skill), onTemplate(template), onSettings(settings), getShareUrl(),
 * getExportData(). Selection callbacks never execute a model in this module.
 * Catalogs can be replaced with setCatalogs({styles,models,agents,skills,
 * templates,actors,voices,styleCategories,actorRegions}).
 */
export function mountReferencePanels(callbacks, initialCatalogs = {}) {
  if (typeof callbacks?.read !== 'function') throw new Error('reference-panels 需要 read() 回调');
  const doc = globalThis.document;
  if (!doc) throw new Error('reference-panels 需要浏览器文档');
  if (!doc.querySelector('link[data-reference-panels-css]')) {
    const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./reference-panels.css', import.meta.url).href; link.dataset.referencePanelsCss = ''; doc.head.append(link);
  }
  let catalogs = { styles: REFERENCE_STYLES, models: MODEL_REFERENCES, agents: [], skills: DEFAULT_SKILLS, templates: STORIES.map(story => ({ id: story.id, name: story.title, description: story.summary, storyId: story.id, styleId: story.style, prompt: story.summary })), ...initialCatalogs };
  const uid = `rp-${Math.random().toString(36).slice(2)}`;
  const dialog = doc.createElement('dialog'); dialog.className = 'reference-panel-dialog'; dialog.setAttribute('aria-labelledby', `${uid}-title`); doc.body.append(dialog);
  let kind = 'style', options = {}, returnFocus = null, generation = 0, destroyed = false;
  let stylePrefs = { favorites: [], recent: [], custom: [] }, assetPrefs = { favorites: [], tags: {} }, settings = { ...DEFAULT_SETTINGS };
  let state = {};
  const studio = () => callbacks.read()?.studio || {};
  const toast = message => callbacks.toast?.(String(message));
  const selectedStyle = () => studio().selectedReferenceStyle?.id || studio().selectedStyle?.id || callbacks.read()?.plan?.style;
  const persist = async patch => {
    if (typeof callbacks.configure !== 'function') throw new Error('保存入口尚未连接');
    if (await callbacks.configure(clone(patch), false) === false) throw new Error('当前修改尚未保存，请稍后重试');
  };
  const image = (url, alt = '', className = '') => {
    const safe = safePanelMediaUrl(url);
    return safe ? `<img src="${esc(safe)}" alt="${esc(alt)}" class="${esc(className)}" loading="lazy">` : '';
  };
  const button = (action, label, ico = '', extra = '') => `<button type="button" data-rp-action="${esc(action)}" ${extra}>${ico ? icon(ico) : ''}${esc(label)}</button>`;
  const closeButton = () => button('close', '关闭', 'close', 'class="rp-close" aria-label="关闭选择面板"');
  const tabs = (items, active, attr) => `<div class="rp-tabs" role="tablist">${items.map(([id, label]) => `<button role="tab" type="button" aria-selected="${active === id}" data-rp-${attr}="${esc(id)}">${esc(label)}</button>`).join('')}</div>`;
  const search = placeholder => `<label class="rp-search">${icon('scan')}<input type="search" data-rp-search placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" value="${esc(state.query)}"></label>`;
  const empty = (title, note) => `<div class="rp-empty">${icon('canvas')}<strong>${esc(title)}</strong><p>${esc(note)}</p></div>`;
  const pill = (id, label, active, attr) => `<button type="button" class="rp-pill ${active === id ? 'is-active' : ''}" data-rp-${attr}="${esc(id)}" aria-pressed="${active === id}">${esc(label)}</button>`;

  function allStyles() {
    const local = STYLES.map((style, index) => ({ ...style, renderStyle: style.id, author: 'Osmanthus', categories: [index === 1 ? '游戏' : '2D'], image: localUrl(`/assets/showcase/${['family', 'friendship', 'romance'][index]}.jpg`), referenceOnly: false }));
    const map = new Map(local.map(style => [style.id, style]));
    for (const item of [...array(catalogs.styles), ...array(stylePrefs.custom)]) if (item?.id != null && !map.has(String(item.id))) map.set(String(item.id), { ...item, id: String(item.id), name: String(item.name || item.title || '未命名风格'), referenceOnly: !STYLES.some(style => style.id === item.renderStyle) });
    return [...map.values()];
  }

  function styleMarkup() {
    const all = allStyles();
    let visible = state.tab === 'favorites' ? all.filter(item => stylePrefs.favorites.includes(item.id)) : state.tab === 'mine' ? all.filter(item => stylePrefs.custom.some(custom => custom.id === item.id)) : state.tab === 'recent' ? stylePrefs.recent.map(id => all.find(item => item.id === id)).filter(Boolean) : all;
    visible = filterPanelItems(visible, state.query, state.category);
    const selected = all.find(style => style.id === state.selectedStyle);
    return `<header class="rp-header"><h2 class="rp-sr" id="${uid}-title">选择风格</h2>${tabs([['all', '全部风格'], ['favorites', '我的收藏'], ['mine', '我的风格'], ['recent', '最近使用']], state.tab, 'tab')}<div class="rp-header-actions">${search('搜索风格')}${closeButton()}</div></header>
      <div class="rp-filter-row">${pill('all', '全部', state.category, 'category')}${array(catalogs.styleCategories || STYLE_CATEGORIES).map(name => pill(name, name, state.category, 'category')).join('')}</div>
      <main class="rp-body"><div class="rp-style-grid">${['all', 'mine'].includes(state.tab) ? `<button class="rp-upload-style" data-rp-action="upload-style" ${state.busy || !callbacks.uploadMaterials ? 'disabled' : ''}>${icon('plus')}<span>上传</span><small>我的风格参考</small></button>` : ''}${visible.map((style, index) => {
        const pictures = array(style.images).length ? style.images : style.image ? [style.image] : [];
        const favorite = stylePrefs.favorites.includes(style.id);
        return `<article class="rp-style-card ${state.selectedStyle === style.id ? 'is-selected' : ''}"><button class="rp-style-cover rp-tone-${index % 5}" data-rp-select-style="${esc(style.id)}" aria-label="选择风格 ${esc(style.name)}" aria-pressed="${state.selectedStyle === style.id}"><span class="rp-style-pictures ${pictures.length > 1 ? 'is-mosaic' : ''}">${pictures.slice(0, 4).map(url => image(url, style.name)).join('') || icon('palette')}</span><span class="rp-card-badge">${esc(style.badge || (style.referenceOnly ? '参考' : '本地可用'))}</span><strong>${esc(style.name)}</strong></button><button class="rp-favorite ${favorite ? 'is-active' : ''}" data-rp-favorite-style="${esc(style.id)}" aria-pressed="${favorite}" aria-label="${favorite ? '取消收藏' : '收藏'} ${esc(style.name)}">${favorite ? '★' : '☆'}</button><div class="rp-card-credit"><span>${esc(style.author || '视觉参考')}</span><span>${esc(style.useCount ?? style.usage ?? (style.referenceOnly ? '参考选择' : '代码预览'))}</span></div></article>`;
      }).join('')}</div>${!visible.length ? empty(state.tab === 'favorites' ? '暂无收藏的风格' : state.tab === 'recent' ? '暂无最近使用的风格' : state.tab === 'mine' ? '还没有自己的风格' : '没有匹配的风格', state.tab === 'favorites' ? '点击风格卡片右上角星标即可收藏。' : state.tab === 'recent' ? '选择任意风格后将在此显示。' : '上传自己的图片作为风格参考，或调整搜索条件。') : ''}</main>
      <footer class="rp-footer"><p>${esc(selected ? `${selected.name} · ${selected.referenceOnly ? '仅保存视觉参考，生成模型尚未接入' : '已安装的代码预览画风'}` : '选择风格。')} 参考项只记录视觉方向，生成模型尚未接入。</p>${button('confirm-style', '使用风格', 'check', `class="rp-primary" ${!selected || state.busy ? 'disabled' : ''}`)}</footer>`;
  }

  function assetMarkup() {
    if (state.preview) return previewMarkup(state.materialCache.get(state.preview));
    let materials = state.materials;
    if (state.library === 'assets') materials = materials.filter(item => item.category === state.assetCategory);
    if (state.library === 'actors') materials = materials.filter(item => (state.era === '默认' || item.era === state.era) && (state.region === '默认' || item.region === state.region));
    if (state.media !== 'all') materials = materials.filter(item => item.type === state.media);
    if (state.favoritesOnly) materials = materials.filter(item => assetPrefs.favorites.includes(item.id));
    materials = filterPanelItems(materials, state.query);
    const regions = [...new Set(['默认', ...array(catalogs.actorRegions), ...state.materials.map(item => item.region).filter(Boolean)])];
    return `<header class="rp-header"><h2 class="rp-sr" id="${uid}-title">资产</h2>${tabs(Object.entries(LIBRARY_NAMES), state.library, 'library')}<div class="rp-header-actions">${search(state.library === 'voices' ? '搜索音色' : state.library === 'actors' ? '搜索演员' : '搜索资产')}${closeButton()}</div></header>
      <div class="rp-filter-row">${state.library === 'assets' ? Object.entries(ASSET_CATEGORIES).map(([id, name]) => pill(id, `${name} (${state.materials.filter(item => item.category === id).length})`, state.assetCategory, 'asset-category')).join('') : state.library === 'actors' ? `<label class="rp-select-label">时代<select data-rp-era>${['默认', '现代', '古代', '近代', '架空', '科幻'].map(name => `<option ${state.era === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label><label class="rp-select-label">地区<select data-rp-region>${regions.map(name => `<option ${state.region === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>${button('more-filters', '更多筛选', 'settings', `class="rp-quiet" aria-expanded="${state.moreFilters}"`)}` : '<span class="rp-muted">当前本地参考声音</span>'}<button class="rp-favorite-filter ${state.favoritesOnly ? 'is-active' : ''}" data-rp-action="favorite-assets" aria-label="收藏" aria-pressed="${state.favoritesOnly}">${state.favoritesOnly ? '★' : '☆'}</button></div>
      ${state.library === 'assets' || state.moreFilters ? `<div class="rp-filter-row rp-filter-secondary">${Object.entries(MEDIA_NAMES).filter(([id])=>!options.type||id===options.type).map(([id, name]) => pill(id, name, state.media, 'media')).join('')}</div>` : ''}
      <main class="rp-body" data-rp-drop-zone><div class="rp-material-grid">${state.library !== 'voices' ? `<div class="rp-upload-material"><button class="rp-quiet" disabled title="资产生成模型尚未接入">${icon('spark')}生成</button>${button('upload-assets', '批量上传', 'upload', `class="rp-quiet" ${state.busy || !callbacks.uploadMaterials ? 'disabled' : ''}`)}<small>本地素材</small></div>` : ''}${materials.map(item => {
        const checked = state.assetSelection.has(item.id), favorite = assetPrefs.favorites.includes(item.id);
        return `<article class="rp-material-card ${checked ? 'is-selected' : ''}"><button class="rp-material-cover" data-rp-toggle-asset="${esc(item.id)}" aria-label="选择 ${esc(item.name)}" aria-pressed="${checked}">${image(item.thumbnailUrl, item.name) || icon(item.type === 'audio' ? 'music' : item.type === 'video' ? 'video' : item.type === 'text' ? 'book' : 'canvas')}<span class="rp-selection-mark">${checked ? '✓' : ''}</span></button><div class="rp-material-name"><strong>${esc(item.name)}</strong><button data-rp-preview="${esc(item.id)}" aria-label="预览 ${esc(item.name)}">${icon('play')}</button><button class="${favorite ? 'is-active' : ''}" data-rp-favorite-asset="${esc(item.id)}" aria-pressed="${favorite}" aria-label="收藏 ${esc(item.name)}">${favorite ? '★' : '☆'}</button></div><small>${esc([MEDIA_NAMES[item.type], item.era, item.region].filter(Boolean).join(' · '))}</small></article>`;
      }).join('')}</div>${state.loading ? '<p class="rp-inline-status" role="status">正在读取本地素材…</p>' : !materials.length ? empty(state.library === 'voices' ? '暂无参考声音' : state.library === 'actors' ? '上传角色参考' : '暂无本地资产', state.library === 'voices' ? '音乐工作台提供参考声音后会显示在这里。' : '这里显示你的本地素材，可上传、预览、收藏并多选加入画布。') : ''}</main>
      <footer class="rp-footer"><p>${esc(state.busy ? '正在上传，请稍候…' : `已选择 ${state.assetSelection.size} 项 · 仅使用本地或明确提供的参考素材`)}</p>${button('confirm-assets', `确认选择${state.assetSelection.size ? ` (${state.assetSelection.size})` : ''}`, 'check', `class="rp-primary" ${state.busy || !state.assetSelection.size ? 'disabled' : ''}`)}</footer>`;
  }

  function previewMarkup(item) {
    if (!item) { state.preview = null; return assetMarkup(); }
    const url = safePanelMediaUrl(item.url);
    const media = item.type === 'image' ? image(item.url, item.name) : item.type === 'video' && url ? `<video src="${esc(url)}" controls playsinline preload="metadata"></video>` : item.type === 'audio' && url ? `<audio src="${esc(url)}" controls preload="metadata"></audio>` : `<pre>${esc(item.content || '素材预览暂不可用，可保留引用。')}</pre>`;
    return `<header class="rp-header"><div class="rp-title-row">${button('preview-back', '返回素材', 'back', 'class="rp-quiet"')}<h2 id="${uid}-title">${esc(item.name)}</h2></div>${closeButton()}</header><main class="rp-body rp-preview"><figure>${media}</figure><p>${esc(item.note)}</p><div class="rp-filter-row">${[MEDIA_NAMES[item.type], item.era, item.region].filter(Boolean).map(value => `<span class="rp-tag">${esc(value)}</span>`).join('')}</div></main><footer class="rp-footer"><p>预览当前本地或提供的素材引用</p><button class="rp-primary" data-rp-toggle-asset="${esc(item.id)}">${esc(state.assetSelection.has(item.id) ? '取消选择' : '选择此素材')}</button></footer>`;
  }

  function modelMarkup() {
    const agents = state.tab === 'agents';
    const items = filterPanelItems(agents ? catalogs.agents : catalogs.models, state.query, state.category);
    const availableCallback = agents ? callbacks.onAgent : callbacks.onModel;
    return `<header class="rp-header"><h2 class="rp-sr" id="${uid}-title">模型与 Agent</h2>${tabs([['models', '模型'], ['agents', 'Agent']], state.tab, 'tab')}<div class="rp-header-actions">${search('搜索模型或 Agent')}${closeButton()}</div></header><div class="rp-filter-row">${['image', 'video', 'audio'].map(value => pill(value, MEDIA_NAMES[value], state.category, 'category')).join('')}</div><main class="rp-body"><div class="rp-option-list">${items.map(item => {
      const available = item.available === true && typeof availableCallback === 'function';
      return `<button class="rp-model-option" data-rp-select-model="${esc(item.id)}" ${available ? '' : 'disabled'}><span class="rp-model-icon">${icon(item.category === 'audio' ? 'music' : item.category === 'video' ? 'video' : 'spark')}</span><span><strong>${esc(item.name || item.title)}${item.badge ? `<em>${esc(item.badge)}</em>` : ''}</strong><small>${esc(item.description || item.note || '')}</small></span><span class="rp-availability">${available ? '可选择' : '尚未接入'}</span></button>`;
    }).join('')}</div>${!items.length ? empty(agents ? '暂无可用的 Agent' : '没有匹配的模型', '连接真实执行能力后，会显示对应的可用入口。') : ''}</main><footer class="rp-footer"><p>选择只设置后续使用的能力；此面板不提交模型任务。</p></footer>`;
  }

  function instructionMarkup(template = false) {
    const items = filterPanelItems(template ? catalogs.templates : catalogs.skills, state.query);
    return `<header class="rp-header"><h2 id="${uid}-title">${template ? '模板' : '技能'}</h2><div class="rp-header-actions">${search(template ? '搜索模板' : '搜索技能')}${closeButton()}</div></header><main class="rp-body"><div class="rp-instruction-grid">${items.map(item => `<button class="rp-instruction-card" data-rp-instruction="${esc(item.id)}" ${state.busy || typeof (template ? callbacks.onTemplate : callbacks.onSkill) !== 'function' ? 'disabled' : ''}>${icon(item.icon || (template ? 'book' : 'spark'))}<strong>${esc(item.name || item.title)}</strong><p>${esc(item.description || item.note || item.prompt)}</p><span>${template ? '使用模板' : '填入指令'} ↗</span></button>`).join('')}</div>${!items.length ? empty('没有匹配的内容', '调整搜索条件后再试。') : ''}</main><footer class="rp-footer"><p>${template ? '本地故事模板使用现有预设；选择后由工作台应用。' : '选择技能只回填指令，确认发送后再执行。'}</p></footer>`;
  }

  function settingsMarkup() {
    return `<header class="rp-header"><h2 id="${uid}-title">画布设置</h2>${closeButton()}</header><main class="rp-body"><div class="rp-setting-list">${settingLabels.map(([key, label, note]) => `<label class="rp-setting"><span><strong>${esc(label)}</strong><small>${esc(note)}</small></span><input type="checkbox" role="switch" data-rp-setting="${key}" ${settings[key] ? 'checked' : ''} ${state.busy ? 'disabled' : ''}></label>`).join('')}</div></main><footer class="rp-footer"><p>设置保存在当前 MV 工程中。</p>${button('close', '完成', 'check', 'class="rp-primary"')}</footer>`;
  }

  function shareMarkup() {
    const url = String(callbacks.getShareUrl?.() || globalThis.location?.href || '');
    return `<header class="rp-header"><h2 id="${uid}-title">分享与导出</h2>${closeButton()}</header><main class="rp-body rp-share"><label for="${uid}-share-url">本机工程链接</label><div class="rp-copy-row"><input id="${uid}-share-url" data-rp-share-url readonly value="${esc(url)}">${button('copy-url', '复制链接', 'link', 'class="rp-secondary"')}</div><p>此链接在当前本机服务中打开，不是公开发布链接。</p><div class="rp-export-box">${icon('download')}<div><strong>保存工程 JSON</strong><p>包含画布、当前方案和素材引用；媒体文件保留在本机。</p></div>${button('download-json', '下载 JSON', '', 'class="rp-secondary"')}</div></main>`;
  }

  function render() {
    if (destroyed) return;
    const focused = doc.activeElement;
    const searchFocus = focused?.matches?.('[data-rp-search]');
    const selection = searchFocus ? [focused.selectionStart, focused.selectionEnd] : null;
    dialog.querySelectorAll('video,audio').forEach(media => media.pause?.());
    const markup = kind === 'style' ? styleMarkup() : kind === 'assets' ? assetMarkup() : kind === 'models' ? modelMarkup() : kind === 'skills' || kind === 'templates' ? instructionMarkup(kind === 'templates') : kind === 'settings' ? settingsMarkup() : shareMarkup();
    dialog.dataset.panel = kind; dialog.setAttribute('aria-busy', Boolean(state.busy || state.loading)); dialog.innerHTML = markup;
    const input = dialog.querySelector('[data-rp-search]');
    if (searchFocus && input) { input.focus(); try { input.setSelectionRange(...selection); } catch {} }
  }

  async function refreshMaterials() {
    if (kind !== 'assets') { render(); return; }
    const current = ++generation, library = state.library;
    state.loading = true; render();
    try {
      const actorFallback = library === 'actors' && !callbacks.listActors && !array(catalogs.actors).length;
      const loader = library === 'actors' ? callbacks.listActors || (actorFallback ? callbacks.listMaterials : null) : library === 'voices' ? callbacks.listVoices : callbacks.listMaterials;
      const provided = typeof loader === 'function' ? await loader({ library, ...(options.type ? {type:options.type} : {}) }) : library === 'actors' ? catalogs.actors : library === 'voices' ? catalogs.voices : [];
      if (current !== generation || destroyed) return;
      state.materials = array(provided?.materials || provided?.assets || provided).map(normalizePanelMaterial).map(item => ({ ...item, ...assetPrefs.tags?.[item.id] })).filter(item => !options.type || item.type === options.type);
      if (actorFallback) state.materials = state.materials.filter(item => item.category === 'role' && ['image', 'video'].includes(item.type));
      for (const item of state.materials) state.materialCache.set(item.id, item);
    } catch (error) { if (current === generation) toast(error.message || error); }
    finally { if (current === generation) { state.loading = false; render(); } }
  }

  async function upload(purpose, files) {
    if (!files?.length || typeof callbacks.uploadMaterials !== 'function') return;
    await busy(async active => {
      const context = { purpose, library: state.library || 'assets', category: state.library === 'actors' ? 'role' : state.assetCategory || 'role', era: state.era === '默认' ? '' : state.era, region: state.region === '默认' ? '' : state.region };
      const result = await callbacks.uploadMaterials([...files], context);
      if (!active()) return;
      if (result === false) throw new Error('素材上传未完成');
      const materials = array(result?.materials || result?.assets || result).map(normalizePanelMaterial);
      if (purpose === 'style') {
        const custom = materials.filter(item => item.type === 'image').map(item => ({ id: `style-${item.id}`, name: item.name, image: item.url || item.thumbnailUrl, asset: item.asset, author: '我的风格', referenceOnly: true, categories: [] }));
        if (!custom.length) throw new Error('请上传图片作为风格参考');
        const merged = new Map(stylePrefs.custom.map(item => [item.id, item]));
        custom.forEach(item => merged.set(item.id, item));
        const nextPrefs = { ...stylePrefs, custom: [...merged.values()] };
        await persist({ styleLibrary: nextPrefs }); stylePrefs = nextPrefs; state.tab = 'mine'; state.category = 'all';
      } else {
        const tags = { ...assetPrefs.tags };
        for (const item of materials) tags[item.id] = { library: context.library, category: context.category, era: context.era || item.era, region: context.region || item.region };
        const nextPrefs = { ...assetPrefs, tags };
        if (callbacks.configure && materials.length) await persist({ assetLibrary: nextPrefs });
        assetPrefs = nextPrefs;
        await refreshMaterials();
        if (!active()) return;
        for (const item of materials) { const tagged = { ...item, ...tags[item.id] }; state.materialCache.set(item.id, tagged); if (!state.materials.some(existing => existing.id === item.id)) state.materials.push(tagged); }
      }
    });
  }

  function chooseFiles(purpose) {
    const input = doc.createElement('input'); input.type = 'file'; input.multiple = true;
    input.accept = purpose === 'style' ? 'image/*' : state.library === 'actors' ? 'image/*,video/*' : 'image/*,video/*,audio/*,text/plain';
    input.addEventListener('change', () => upload(purpose, input.files), { once: true }); input.click();
  }

  async function busy(action) {
    if (state.busy) return;
    const currentState = state;
    state.busy = true; render();
    try { await action(() => state === currentState && !destroyed); } catch (error) { toast(error.message || error); }
    finally { currentState.busy = false; if (state === currentState && dialog.open) render(); }
  }

  async function action(name) {
    if (name === 'close') return close();
    if (name === 'upload-style' || name === 'upload-assets') return chooseFiles(name === 'upload-style' ? 'style' : 'assets');
    if (name === 'more-filters') { state.moreFilters = !state.moreFilters; return render(); }
    if (name === 'favorite-assets') { state.favoritesOnly = !state.favoritesOnly; return render(); }
    if (name === 'preview-back') { state.preview = null; return render(); }
    if (name === 'confirm-style') return busy(async () => {
      const style = allStyles().find(item => item.id === state.selectedStyle); if (!style) return;
      if (callbacks.onStyle) { if (await callbacks.onStyle(clone(style)) === false) throw new Error('风格尚未应用'); }
      else await persist({ selectedReferenceStyle: style });
      const nextPrefs = { ...stylePrefs, recent: [style.id, ...stylePrefs.recent.filter(id => id !== style.id)].slice(0, 60) };
      if (callbacks.configure) await persist({ styleLibrary: nextPrefs }); stylePrefs = nextPrefs; close();
    });
    if (name === 'confirm-assets') return busy(async () => {
      const items = [...state.assetSelection].map(id => state.materialCache.get(id)).filter(Boolean);
      if (!items.length) return;
      if (callbacks.onSelectAssets) { if (await callbacks.onSelectAssets(clone(items)) === false) throw new Error('素材尚未加入'); }
      else await persist({ selectedAssets: items });
      close();
    });
    if (name === 'copy-url') {
      const input = dialog.querySelector('[data-rp-share-url]');
      try { if (globalThis.navigator?.clipboard?.writeText) await navigator.clipboard.writeText(input.value); else { input.select(); if (!doc.execCommand?.('copy')) throw new Error(); } toast('本机链接已复制'); }
      catch { input.focus(); input.select(); toast('请复制选中的本机链接'); }
    }
    if (name === 'download-json') {
      try {
        const payload = callbacks.getExportData ? await callbacks.getExportData() : { schema: 'osmanthus-mv-project-export-v1', exportedAt: new Date().toISOString(), project: callbacks.read() };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), anchor = doc.createElement('a'); anchor.href = url;
        anchor.download = `${String(callbacks.read()?.title || 'Osmanthus-MV').replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (error) { toast(error.message || '工程导出未完成'); }
    }
  }

  dialog.addEventListener('click', async event => {
    if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); return; }
    const target = event.target.closest('button'); if (!target || target.disabled || state.busy) return;
    try {
      if (target.dataset.rpAction) return await action(target.dataset.rpAction);
      if (target.dataset.rpTab) { state.tab = target.dataset.rpTab; render(); }
      if (target.dataset.rpCategory) { state.category = target.dataset.rpCategory; render(); }
      if (target.dataset.rpAssetCategory) { state.assetCategory = target.dataset.rpAssetCategory; render(); }
      if (target.dataset.rpMedia) { state.media = target.dataset.rpMedia; render(); }
      if (target.dataset.rpLibrary) { state.library = target.dataset.rpLibrary; state.query = ''; state.media = 'all'; state.favoritesOnly = false; state.preview = null; await refreshMaterials(); }
      if (target.dataset.rpSelectStyle) { state.selectedStyle = target.dataset.rpSelectStyle; render(); }
      if (target.dataset.rpFavoriteStyle) await busy(async () => {
        const id = target.dataset.rpFavoriteStyle, next = { ...stylePrefs, favorites: stylePrefs.favorites.includes(id) ? stylePrefs.favorites.filter(value => value !== id) : [...stylePrefs.favorites, id] };
        await persist({ styleLibrary: next }); stylePrefs = next;
      });
      if (target.dataset.rpFavoriteAsset) await busy(async () => {
        const id = target.dataset.rpFavoriteAsset, next = { ...assetPrefs, favorites: assetPrefs.favorites.includes(id) ? assetPrefs.favorites.filter(value => value !== id) : [...assetPrefs.favorites, id] };
        await persist({ assetLibrary: next }); assetPrefs = next;
      });
      if (target.dataset.rpToggleAsset) { const id = target.dataset.rpToggleAsset; if (state.assetSelection.has(id)) state.assetSelection.delete(id); else state.assetSelection.add(id); render(); }
      if (target.dataset.rpPreview) { state.preview = target.dataset.rpPreview; render(); }
      if (target.dataset.rpSelectModel) await busy(async () => {
        const agents = state.tab === 'agents', item = array(agents ? catalogs.agents : catalogs.models).find(value => String(value.id) === target.dataset.rpSelectModel);
        const callback = agents ? callbacks.onAgent : callbacks.onModel;
        if (!item || item.available !== true || !callback) return;
        if (await callback(clone(item)) === false) throw new Error('当前能力尚未选择'); close();
      });
      if (target.dataset.rpInstruction) await busy(async () => {
        const template = kind === 'templates', item = array(template ? catalogs.templates : catalogs.skills).find(value => String(value.id) === target.dataset.rpInstruction);
        const callback = template ? callbacks.onTemplate : callbacks.onSkill;
        if (item && callback) { if (await callback(clone(item)) === false) throw new Error('当前选择尚未应用'); close(); }
      });
    } catch (error) { toast(error.message || error); }
  });
  dialog.addEventListener('input', event => { if (event.target.matches('[data-rp-search]')) { state.query = event.target.value; render(); } });
  dialog.addEventListener('change', async event => {
    const target = event.target;
    if (target.hasAttribute('data-rp-era')) { state.era = target.value; render(); }
    if (target.hasAttribute('data-rp-region')) { state.region = target.value; render(); }
    if (target.dataset.rpSetting) await busy(async () => {
      const next = { ...settings, [target.dataset.rpSetting]: target.checked };
      if (callbacks.onSettings) { if (await callbacks.onSettings(clone(next)) === false) throw new Error('设置尚未保存'); }
      else await persist({ canvasSettings: next });
      settings = next;
    });
  });
  dialog.addEventListener('dragover', event => { if (kind === 'assets' && state.library !== 'voices' && callbacks.uploadMaterials) { event.preventDefault(); dialog.classList.add('is-dropping'); } });
  dialog.addEventListener('dragleave', event => { if (!dialog.contains(event.relatedTarget)) dialog.classList.remove('is-dropping'); });
  dialog.addEventListener('drop', event => { if (kind !== 'assets' || state.library === 'voices' || !callbacks.uploadMaterials) return; event.preventDefault(); dialog.classList.remove('is-dropping'); upload('assets', event.dataTransfer?.files); });
  dialog.addEventListener('close', () => { generation++; dialog.querySelectorAll('video,audio').forEach(media => media.pause?.()); if (returnFocus?.isConnected) returnFocus.focus(); });

  function close() { if (dialog.open) dialog.close(); }
  function open(name = 'style', nextOptions = {}) {
    if (destroyed) throw new Error('选择面板已卸载');
    const aliases = { model: 'models', agent: 'models', skill: 'skills', template: 'templates', 'canvas-settings': 'settings' };
    kind = aliases[name] || name;
    if (!['style', 'assets', 'models', 'skills', 'templates', 'settings', 'share'].includes(kind)) throw new Error(`未知选择面板 ${name}`);
    generation++; options = nextOptions; returnFocus = doc.activeElement;
    const saved = studio(); stylePrefs = { favorites: [], recent: [], custom: [], ...saved.styleLibrary }; assetPrefs = { favorites: [], tags: {}, ...saved.assetLibrary }; settings = { ...DEFAULT_SETTINGS, ...saved.canvasSettings };
    stylePrefs.favorites = array(stylePrefs.favorites); stylePrefs.recent = array(stylePrefs.recent); stylePrefs.custom = array(stylePrefs.custom); assetPrefs.favorites = array(assetPrefs.favorites);
    const assetSelection = array(options.selectedAssets || saved.selectedAssets);
    state = { tab: kind === 'models' ? name === 'agent' || options.tab === 'agents' ? 'agents' : 'models' : 'all', category: kind === 'models' ? options.category || 'image' : 'all', query: '', selectedStyle: selectedStyle(), library: options.library || 'assets', assetCategory: options.assetCategory || 'role', media: 'all', era: '默认', region: '默认', favoritesOnly: false, moreFilters: false, busy: false, loading: false, preview: null, materials: [], materialCache: new Map(), assetSelection: new Set(assetSelection.map(item => typeof item === 'string' ? item : String(item.id))) };
    for (const item of assetSelection) if (typeof item === 'object' && item) { const material = normalizePanelMaterial(item); state.materialCache.set(material.id, material); }
    dialog.classList.toggle('rp-anchored', Boolean(options.anchor)); dialog.style.removeProperty('left'); dialog.style.removeProperty('top'); dialog.style.removeProperty('margin');
    render(); if (!dialog.open) dialog.showModal();
    if (options.anchor?.getBoundingClientRect) {
      const anchor = options.anchor.getBoundingClientRect(), rect = dialog.getBoundingClientRect();
      dialog.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, innerHeight - rect.height - 12))}px`; dialog.style.margin = '0';
    }
    if (kind === 'assets') refreshMaterials();
    return api;
  }
  const api = {
    open, close, dialog, refresh: () => kind === 'assets' ? refreshMaterials() : render(),
    openStyle: value => open('style', value), openAssets: value => open('assets', value), openModels: value => open('models', value),
    openSkills: value => open('skills', value), openTemplates: value => open('templates', value), openSettings: value => open('settings', value), openShare: value => open('share', value),
    setCatalogs: next => { catalogs = { ...catalogs, ...next }; if (dialog.open) kind === 'assets' ? refreshMaterials() : render(); },
    destroy: () => { close(); destroyed = true; generation++; dialog.remove(); },
  };
  return api;
}
