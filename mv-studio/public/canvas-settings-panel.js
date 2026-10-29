export const DEFAULT_CANVAS_SETTINGS = Object.freeze({
  grid: true, snap: true, showConnections: true, minimap: false, autosave: true,
  focusSelection: false, focusNew: false, agentExpanded: false,
  showDimensions: false, clickOpenInspector: true, promptHighlight: true,
  inputFontSize: 'medium', groupColor: '#ffffff', shortcuts: Object.freeze({}),
});

const sections = [
  ['preferences', '偏好设置'], ['editing', '编辑操作'], ['tools', '工具'],
  ['navigation', '视图与导航'], ['mouse', '鼠标'], ['input', '输入框'],
  ['groups', '分组'], ['images', '图片'], ['videos', '视频'], ['audio', '音频'],
];
const booleanKeys = Object.keys(DEFAULT_CANVAS_SETTINGS).filter(key => typeof DEFAULT_CANVAS_SETTINGS[key] === 'boolean');
const esc = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const copy = value => JSON.parse(JSON.stringify(value));

export const CANVAS_GROUP_COLORS = Object.freeze([
  ['white','白色','#ffffff'],['pink','粉色','#ec4899'],['yellow','黄色','#facc15'],['purple','紫色','#a855f7'],
  ['red','红色','#ef4444'],['blue','蓝色','#3b82f6'],['green','绿色','#22c55e'],['cyan','青色','#06b6d4'],
].map(([id,name,color])=>Object.freeze({id,name,color})));
export const CANVAS_SETTINGS_ACTIONS = Object.freeze([
 'select-all','copy','paste','duplicate','delete','undo','redo','group','ungroup','add-image','add-video','add-audio',
 'select-tool','hand-tool','projects','minimap','fit','zoom-in','zoom-out','zoom-100','zoom-200','group-expand','group-collapse',
 'group-color','group-color-picker','group-color-next',...CANVAS_GROUP_COLORS.map(item=>'group-color-'+item.id),
 'image-edit','image-reverse-prompt','image-character-views','image-face-views','image-prop-views','image-scene-grid','image-lighting',
 'image-upscale-2x','image-upscale-4x','crop-image','transform-image','annotation','image-keep-object','image-keep-person','image-outpaint',
 'image-remove-object','camera','image-depth','draw','video-remix','video-upscale','video-reshoot','video-crop',
 'video-remove-subtitles','video-reverse-prompt','video-depth','video-extract-audio','use-audio',
]);
const supportedCode=/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Enter|Delete|Backspace|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/;
const defaultBindings=Object.freeze({'Mod+KeyA':'select-all','Mod+KeyC':'copy','Mod+KeyV':'paste','Mod+KeyD':'duplicate','Mod+KeyG':'group','Mod+Shift+KeyG':'ungroup','Mod+KeyZ':'undo','Mod+Shift+KeyZ':'redo',Delete:'delete',Backspace:'delete',Digit0:'fit',Equal:'zoom-in','Shift+Equal':'zoom-in',Minus:'zoom-out',Space:'temporary-pan'});
export function normalizeCanvasShortcut(binding){
 if(typeof binding!=='string')throw Error('快捷键需为文字');const parts=binding.trim().split('+'),code=parts.pop();
 if(!supportedCode.test(code)||parts.some(p=>!['Mod','Alt','Shift'].includes(p))||new Set(parts).size!==parts.length)throw Error('快捷键格式无效');
 if(parts.includes('Mod')&&['KeyW','KeyR','KeyQ','KeyL','KeyT','KeyN'].includes(code)||code==='F5')throw Error('此快捷键由浏览器或系统使用');
 return [...['Mod','Alt','Shift'].filter(p=>parts.includes(p)),code].join('+');
}
export function normalizeCanvasShortcuts(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('快捷键设置需为对象');const result={},used=new Map();
 for(const[action,value]of Object.entries(input)){if(!CANVAS_SETTINGS_ACTIONS.includes(action))throw Error('不支持的快捷键操作');if(value===null||value===''){result[action]=null;continue;}const binding=normalizeCanvasShortcut(value);if(defaultBindings[binding]&&defaultBindings[binding]!==action)throw Error(`快捷键已用于默认操作 ${defaultBindings[binding]}`);if(used.has(binding))throw Error(`快捷键已用于 ${used.get(binding)}`);used.set(binding,action);result[action]=binding;}
 return result;
}
/** Returns only custom bindings; caller retains its existing default handlers. */
export function matchCanvasShortcut(event,settings={}){
 if(event?.defaultPrevented||event?.isComposing||event?.keyCode===229||!supportedCode.test(event?.code||'')||(event.ctrlKey&&event.metaKey)||event?.target?.isContentEditable||event?.target?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]'))return null;
 let binding;try{binding=normalizeCanvasShortcut([...(event.ctrlKey||event.metaKey?['Mod']:[]),...(event.altKey?['Alt']:[]),...(event.shiftKey?['Shift']:[]),event.code].join('+'));}catch{return null;}
 let shortcuts;try{shortcuts=normalizeCanvasShortcuts(Object.hasOwn(settings,'shortcuts')?settings.shortcuts:settings);}catch{return null;}
 return Object.entries(shortcuts).find(([,value])=>value===binding)?.[0]||null;
}
export function resolveCanvasSettingsAction(action){
 if(!CANVAS_SETTINGS_ACTIONS.includes(action))throw Error('未知画布操作');const preset=CANVAS_GROUP_COLORS.find(item=>action==='group-color-'+item.id);
 return preset?{action:'group-color',payload:{color:preset.color}}:{action,payload:{}};
}
export function canvasSettingsActionAvailable(action,{onAction,availableActions=[],onGroupColor}={}){
 if(!CANVAS_SETTINGS_ACTIONS.includes(action))return false;const resolved=resolveCanvasSettingsAction(action);
 return resolved.action==='group-color'&&typeof onGroupColor==='function'||typeof onAction==='function'&&Array.isArray(availableActions)&&(availableActions.includes(action)||availableActions.includes(resolved.action));
}

/** Keep other canvas preferences intact while normalizing the controls we own. */
export function normalizeCanvasSettings(value = {}) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = {...saved, ...DEFAULT_CANVAS_SETTINGS, shortcuts:{}};
  for (const key of booleanKeys) {
    if (typeof saved[key] === 'boolean') settings[key] = saved[key];
  }
  if (['small', 'medium', 'large'].includes(saved.inputFontSize)) settings.inputFontSize = saved.inputFontSize;
  if(Object.hasOwn(saved,'shortcuts')){try{settings.shortcuts=normalizeCanvasShortcuts(saved.shortcuts);}catch{settings.shortcuts={};}}
  if(Object.hasOwn(saved,'groupColor'))settings.groupColor=typeof saved.groupColor==='string'&&/^#[a-f0-9]{6}$/i.test(saved.groupColor)?saved.groupColor.toLowerCase():'#ffffff';
  return settings;
}

/**
 * read() -> current MV project; configure({canvasSettings}, false) -> success or
 * false/Promise. Only Save calls configure. onApply(settings) runs after success
 * so the owner can update its viewport, inspector and Agent presentation.
 * Optional onShortcutsChange enables custom binding capture. The viewport owner
 * calls matchCanvasShortcut before its default key handlers. onAction only
 * enables IDs explicitly listed in availableActions; group colors can instead
 * use onGroupColor(color,{projectId}). Store per-group color in canvasMeta.
 */
export function mountCanvasSettings({read, configure, onApply, toast, onAction, availableActions=[], hiddenActions=[], onShortcutsChange, onGroupColor} = {}) {
  if (typeof read !== 'function' || typeof configure !== 'function') throw new TypeError('画布设置需要 read 和 configure 回调');
  const doc = globalThis.document;
  if (!doc) throw new Error('画布设置需要浏览器文档');
  if (!doc.querySelector('link[data-canvas-settings-css]')) {
    const link = doc.createElement('link'); link.rel = 'stylesheet';
    link.href = new URL('./canvas-settings-panel.css', import.meta.url).href;
    link.dataset.canvasSettingsCss = ''; doc.head.append(link);
  }
  const uid = 'csp-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const dialog = doc.createElement('dialog'); dialog.className = 'canvas-settings-dialog';
  dialog.setAttribute('aria-labelledby', uid + '-title'); doc.body.append(dialog);
  let draft, original, savedExtras = {}, active = 'preferences', busy = false, returnFocus, projectId, capturing=null, session=0, disposed=false;
  const notify = message => toast?.(String(message));
  const status = message => { const node = dialog.querySelector('[data-csp-status]'); if (node) node.textContent = message; };
  const switchRow = (key, label, note = '') => `<label class="csp-row csp-switch-row"><span><span class="csp-row-title">${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</span><input type="checkbox" role="switch" data-csp-setting="${key}" aria-label="${esc(label)}" ${draft[key] ? 'checked' : ''}></label>`;
  const keyRow = (label, keys = [], note = '', unavailable = false) => `<div class="csp-row ${unavailable ? 'is-unavailable' : ''}"><span><span class="csp-row-title">${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</span><span class="csp-key-value">${unavailable ? '<button type="button" disabled data-csp-unavailable="true" class="csp-unavailable">未接入</button>' : keys.length ? keys.map(key => `<kbd>${esc(key)}</kbd>`).join('<span class="csp-or">/</span>') : '<span class="csp-unset">未设置</span>'}</span></div>`;
  const group = (id, title, content, note = '') => `<section id="${uid}-${id}" class="csp-section" data-csp-content="${id}" aria-labelledby="${uid}-${id}-heading"><h3 id="${uid}-${id}-heading">${esc(title)}</h3>${note ? `<p class="csp-section-note">${esc(note)}</p>` : ''}${content}</section>`;
  const canAction=action=>canvasSettingsActionAvailable(action,{onAction,availableActions,onGroupColor});
  const actionRow=(action,label)=>{if(hiddenActions.includes(action))return '';const enabled=canAction(action),binding=draft.shortcuts?.[action];return`<div class="csp-row ${enabled?'':'is-unavailable'}"><span class="csp-row-title">${esc(label)}</span><span class="csp-key-value">${typeof onShortcutsChange==='function'&&enabled?`<button type="button" data-csp-shortcut="${esc(action)}" class="csp-unavailable" style="opacity:1" aria-label="设置 ${esc(label)} 快捷键">${esc(binding||'设置快捷键')}</button>${binding?`<button type="button" data-csp-clear-shortcut="${esc(action)}" aria-label="清除 ${esc(label)} 快捷键">×</button>`:''}`:binding?`<kbd>${esc(binding)}</kbd>`:''}<button type="button" data-csp-invoke="${esc(action)}" ${enabled?'':'disabled data-csp-unavailable="true"'} class="csp-unavailable" ${enabled?'style="opacity:1"':''}>${enabled?'打开':'未接入'}</button></span></div>`;};

  function preferenceRows() {
    return [
      switchRow('focusSelection', '选中节点自动聚焦'),
      switchRow('focusNew', '新增空白节点聚焦'),
      actionRow('add-image','新增空白图片节点（快捷键）'),
      switchRow('agentExpanded', 'Agent 对话框默认展开'),
      switchRow('showDimensions', '显示尺寸信息'),
      switchRow('clickOpenInspector', '点击打开输入框'),
      switchRow('promptHighlight', '提示词高亮'),
      '<div class="csp-divider"></div>',
      switchRow('grid', '显示网格'), switchRow('snap', '吸附对齐'),
      switchRow('showConnections', '显示连线'), switchRow('minimap', '显示小地图'),
      switchRow('autosave', '自动保存'),
    ].join('');
  }

  function inputRows() {
    const options = [['small', '小'], ['medium', '中'], ['large', '大']];
    return keyRow('引用资源', [], '从资产选择器引用；@ 快捷引用尚未接入')
      + keyRow('换行', ['Enter', '⇧ + Enter', '⌥ + Enter'])
      + keyRow('发送', ['⌘ / Ctrl + Enter'])
      + `<label class="csp-row"><span class="csp-row-title">输入框字号</span><select aria-label="输入框字号" data-csp-font>${options.map(([value, label]) => `<option value="${value}" ${draft.inputFontSize === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`
      + `<div class="csp-input-preview" data-csp-preview="${draft.inputFontSize}"><div class="csp-preview-heading"><strong>提示词</strong><span>智能体</span><small>字号预览</small></div><p><span class="csp-preview-tag">[参数]</span><br>15 秒，16:9，保留完整画面。</p><p><span class="csp-preview-tag">[风格]</span><br>写实电影风格，35mm 胶片质感。黄昏的站台被暖色路灯照亮，人物站在画面中央，远处的城市逐渐安静。保留细腻的光影层次和自然的环境细节。</p></div>`;
  }

  function render() {
    const editing = [
      actionRow('select-all','全选（默认 ⌘ / Ctrl + A）'), keyRow('多选', ['⌘ / Ctrl + 单击', '⇧ + 单击']),
      actionRow('copy','复制（默认 ⌘ / Ctrl + C）'), actionRow('paste','粘贴（默认 ⌘ / Ctrl + V）'),
      actionRow('duplicate','创建副本（默认 ⌘ / Ctrl + D）'), actionRow('add-image','创建图片节点'), actionRow('add-video','创建视频节点'), actionRow('add-audio','创建音频节点'),
      actionRow('delete','删除（默认 Backspace / Delete）'), actionRow('undo','撤销（默认 ⌘ / Ctrl + Z）'),
      actionRow('redo','重做（默认 ⌘ / Ctrl + ⇧ + Z）'),
    ].join('');
    const tools = actionRow('select-tool','选择工具')
      + actionRow('hand-tool','手型工具（短按）')
      + keyRow('临时平移（长按）', ['Space']);
    const navigation = actionRow('projects','搜索画布列表')
      + actionRow('zoom-in','放大（默认 + / =）') + actionRow('zoom-out','缩小（默认 −）')
      + actionRow('minimap','打开小地图') + actionRow('fit','适应画布（默认 0）')
      + actionRow('zoom-100','100%') + actionRow('zoom-200','200%') + keyRow('添加比例', [], '自定义缩放快捷键尚未接入', true);
    const mouse = keyRow('平移画布', ['滚轮', 'Space + 拖拽'])
      + keyRow('缩放画布', ['⌘ / Ctrl + 滚轮']);
    const grouping = actionRow('group','打组（默认 ⌘ / Ctrl + G）') + actionRow('ungroup','解组（默认 ⌘ / Ctrl + ⇧ + G）')
      + actionRow('group-expand','展开分组') + actionRow('group-collapse','收起分组')
      + `<label class="csp-row"><span class="csp-row-title">默认分组颜色（保存后生效）</span><input type="color" data-csp-group-color value="${esc(draft.groupColor||'#ffffff')}"></label>`
      + actionRow('group-color-picker','打开颜色选择器') + actionRow('group-color-next','切换到下一种颜色')
      + CANVAS_GROUP_COLORS.map(item=>actionRow('group-color-'+item.id,'设为'+item.name)).join('');
    const images = [['image-edit','局部编辑'],['image-reverse-prompt','反推提示词'],['image-character-views','角色三视图'],['image-face-views','脸部三视图'],['image-prop-views','道具三视图'],['image-scene-grid','场景宫格图'],['image-lighting','打光'],['image-upscale-2x','高清 2x'],['image-upscale-4x','高清 4x'],['crop-image','裁剪'],['transform-image','旋转与镜像'],['annotation','画笔标记'],['image-keep-object','保留物品'],['image-keep-person','保留人物'],['image-outpaint','AI图像扩展'],['image-remove-object','移除物体'],['camera','多视角'],['image-depth','深度提取'],['draw','绘制']].map(([id,label])=>actionRow(id,label)).join('');
    const videos = [['video-remix','爆款复刻'],['video-upscale','视频高清'],['video-reshoot','片段重拍'],['video-crop','片段裁剪'],['video-remove-subtitles','字幕擦除'],['video-reverse-prompt','反推提示词'],['video-depth','深度提取'],['video-extract-audio','分离音频']].map(([id,label])=>actionRow(id,label)).join('');
    dialog.innerHTML = `<header class="csp-header"><h2 id="${uid}-title">画布设置</h2><button type="button" class="csp-close" data-csp-action="cancel" aria-label="关闭画布设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="csp-layout"><nav class="csp-nav" aria-label="画布设置分类">${sections.map(([id, label]) => `<button type="button" data-csp-section="${id}" aria-controls="${uid}-${id}" ${active === id ? 'aria-current="location"' : ''}>${label}</button>`).join('')}</nav><main class="csp-scroll" tabindex="0" aria-label="画布设置内容">${group('preferences', '偏好设置', preferenceRows())}${group('editing', '编辑操作', editing, '快捷键在画布中生效，仅供查看。')}${group('tools', '工具', tools)}${group('navigation', '视图与导航', navigation)}${group('mouse', '鼠标', mouse)}${group('input', '输入框', inputRows())}${group('groups', '分组', grouping)}${group('images', '图片', images, '图像编辑与 AI 能力尚未接入。')}${group('videos', '视频', videos, '视频编辑与 AI 能力尚未接入。')}${group('audio', '音频', keyRow('MV 制作', [], '从音频素材菜单选择 MV 配乐'))}</main></div><footer class="csp-footer"><button type="button" class="csp-reset" data-csp-action="reset">全部重置</button><span class="csp-status" role="status" data-csp-status>保存后应用到当前画布</span><div class="csp-footer-actions"><button type="button" class="csp-cancel" data-csp-action="cancel">取消</button><button type="button" class="csp-save" data-csp-action="save">保存</button></div></footer>`;
    dialog.innerHTML=dialog.innerHTML.replace('快捷键在画布中生效，仅供查看。','支持的操作可设置自定义快捷键；清除自定义绑定会保留默认快捷键。').replace('图像编辑与 AI 能力尚未接入。','仅启用已连接的操作；点击打开对应工具。').replace('视频编辑与 AI 能力尚未接入。','仅启用已连接的操作；真实处理由对应工具完成。');
    dialog.querySelector('.csp-scroll').addEventListener('scroll', updateActiveSection, {passive: true});
    setBusy(busy);
  }

  function setBusy(value) {
    busy = value; dialog.setAttribute('aria-busy', String(busy));
    for (const control of dialog.querySelectorAll('button,input,select')) {
      control.disabled = (busy&&control.dataset.cspAction!=='cancel') || control.dataset.cspUnavailable === 'true';
    }
    const save = dialog.querySelector('[data-csp-action="save"]');
    if (save) save.textContent = busy ? '保存中…' : '保存';
  }

  function setActive(id) {
    active = id;
    for (const button of dialog.querySelectorAll('[data-csp-section]')) {
      if (button.dataset.cspSection === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }

  function updateActiveSection() {
    const scroller = dialog.querySelector('.csp-scroll');
    const top = scroller.getBoundingClientRect().top + 40;
    let current = sections[0][0];
    for (const section of scroller.querySelectorAll('[data-csp-content]')) {
      if (section.getBoundingClientRect().top <= top) current = section.dataset.cspContent;
    }
    // The final section can be shorter than the remaining visible viewport.
    if (scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3) current = 'audio';
    setActive(current);
  }

  function scrollToSection(id, smooth = true) {
    const scroller = dialog.querySelector('.csp-scroll'), section = dialog.querySelector(`[data-csp-content="${id}"]`);
    if (!section) return;
    setActive(id);
    const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 20;
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({top: Math.max(0, top), behavior: smooth && !reduced ? 'smooth' : 'auto'});
  }

  function close() {
    session++;capturing=null;busy=false;
    if (dialog.open) dialog.close();
    draft = undefined; return true;
  }

  async function save() {
    if (busy || !draft) return;
    if (read()?.id !== projectId) { status('工程已切换，请关闭后重新打开设置'); return; }
    const next = copy(normalizeCanvasSettings(draft)),token=session,origin=projectId,previous=copy(original),live=()=>!disposed&&session===token&&read()?.id===origin&&dialog.open;
    setBusy(true); status('正在保存设置…');
    try {
      if (await configure({canvasSettings: next}, false) === false) throw new Error('当前设置未能保存，请稍后重试');
      if(!live())return;
      if(typeof onShortcutsChange==='function'&&JSON.stringify(previous.shortcuts)!==JSON.stringify(next.shortcuts)){
        if(await onShortcutsChange(copy(next.shortcuts),{project_id:origin})===false)throw Error('设置已保存，但快捷键回调未能完成');if(!live())return;
      }
      if(previous.groupColor!==next.groupColor&&canAction('group-color')){
        const result=typeof onGroupColor==='function'?await onGroupColor(next.groupColor,{project_id:origin}):await onAction('group-color',{color:next.groupColor});if(result===false)throw Error('设置已保存，但当前分组颜色未能更新');if(!live())return;
      }
    } catch (error) {
      if(live()){setBusy(false);status(error.message||'设置未能保存');notify(error.message||'设置未能保存');}return;
    }
    let applied = true;
    try { if(!live())return;await onApply?.(copy(next)); }
    catch (error) { applied = false;if(live())notify(error.message || '设置已保存，画布更新未完成'); }
    if(!live())return;setBusy(false);close();if(applied)notify('画布设置已更新');
  }

  function renderPreservingScroll(){const top=dialog.querySelector('.csp-scroll')?.scrollTop||0;render();dialog.querySelector('.csp-scroll').scrollTop=top;}
  async function invoke(action){
    if(!canAction(action)||busy||!draft)return;if(read()?.id!==projectId){status('工程已切换，请重新打开设置');return;}
    const token=session,origin=projectId,resolved=resolveCanvasSettingsAction(action);if(resolved.action==='group-color'&&!resolved.payload.color)resolved.payload.color=draft.groupColor;setBusy(true);status('正在打开操作…');
    try{const result=resolved.action==='group-color'&&typeof onGroupColor==='function'?await onGroupColor(resolved.payload.color,{project_id:origin}):await onAction(resolved.action,copy(resolved.payload));if(token!==session||disposed||read()?.id!==origin)return;if(result===false)throw Error('该操作未能完成');setBusy(false);close();}catch(error){if(token===session&&!disposed&&read()?.id===origin){setBusy(false);status(error.message||'操作未完成');notify(error.message||'操作未完成');}}
  }

  dialog.addEventListener('change', event => {
    if (busy || !draft || read()?.id!==projectId) return;
    const target = event.target;
    if (booleanKeys.includes(target.dataset.cspSetting)) draft[target.dataset.cspSetting] = target.checked;
    if (target.matches('[data-csp-font]') && ['small', 'medium', 'large'].includes(target.value)) {
      draft.inputFontSize = target.value;
      dialog.querySelector('[data-csp-preview]').dataset.cspPreview = target.value;
    }
    if(target.matches('[data-csp-group-color]')&&/^#[a-f0-9]{6}$/i.test(target.value))draft.groupColor=target.value.toLowerCase();
    status('更改尚未保存');
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      return;
    }
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if(button.dataset.cspAction==='cancel'){close();return;}
    if(busy||!draft)return;
    if(button.dataset.cspInvoke){void invoke(button.dataset.cspInvoke);return;}
    if(button.dataset.cspShortcut&&typeof onShortcutsChange==='function'&&canAction(button.dataset.cspShortcut)){capturing=button.dataset.cspShortcut;status('按下新的快捷键，Esc 取消；保留原有默认快捷键');button.focus();return;}
    if(button.dataset.cspClearShortcut&&typeof onShortcutsChange==='function'){draft.shortcuts={...draft.shortcuts,[button.dataset.cspClearShortcut]:null};capturing=null;renderPreservingScroll();status('自定义绑定已清除，保存后生效');return;}
    if (button.dataset.cspSection) scrollToSection(button.dataset.cspSection);
    if (button.dataset.cspAction === 'cancel') close();
    if (button.dataset.cspAction === 'save') void save();
    if (button.dataset.cspAction === 'reset') {
      const scrollTop = dialog.querySelector('.csp-scroll').scrollTop;
      draft = normalizeCanvasSettings({...savedExtras});capturing=null;render();
      dialog.querySelector('.csp-scroll').scrollTop = scrollTop;
      status('已恢复默认值，点击保存后应用');
    }
  });
  dialog.addEventListener('keydown',event=>{
    if(!capturing||busy||!draft)return;event.preventDefault();event.stopPropagation?.();
    if(event.key==='Escape'){capturing=null;status('已取消快捷键录入');return;}
    if(event.isComposing||event.keyCode===229||!supportedCode.test(event.code||'')||event.metaKey&&event.ctrlKey)return;
    try{if(read()?.id!==projectId)throw Error('工程已切换，请重新打开设置');const binding=normalizeCanvasShortcut([...(event.metaKey||event.ctrlKey?['Mod']:[]),...(event.altKey?['Alt']:[]),...(event.shiftKey?['Shift']:[]),event.code].join('+'));draft.shortcuts=normalizeCanvasShortcuts({...draft.shortcuts,[capturing]:binding});capturing=null;renderPreservingScroll();status('自定义快捷键已录入，保存后生效');}catch(error){status(error.message);notify(error.message);}
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {if(dialog.open)return;draft=undefined;capturing=null;if(returnFocus?.isConnected)returnFocus.focus();});

  function open(section = 'preferences') {
    if(disposed)throw Error('画布设置已卸载');if(busy&&read()?.id===projectId)return;session++;busy=false;capturing=null;
    const project = read(); projectId = project?.id;
    const stored = project?.studio?.canvasSettings;
    draft = copy(normalizeCanvasSettings(stored));original=copy(draft);
    savedExtras = Object.fromEntries(Object.entries(draft).filter(([key]) => !Object.hasOwn(DEFAULT_CANVAS_SETTINGS, key)));
    active = sections.some(([id]) => id === section) ? section : 'preferences';
    returnFocus = doc.activeElement; render();
    if (!dialog.open) dialog.showModal();
    scrollToSection(active, false);
    dialog.querySelector(`[data-csp-section="${active}"]`)?.focus();
  }
  return Object.freeze({open,close,destroy(){close();disposed=true;dialog.remove();},get dialog(){return dialog;},get settings(){return draft?copy(draft):null;}});
}
