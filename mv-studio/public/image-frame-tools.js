import {localUrl} from './integration.js';

export const IMAGE_CROP_RATIOS = Object.freeze(['free', '1:1', '16:9', '9:16', '4:3']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const copyRect = rect => ({x: rect.x, y: rect.y, width: rect.width, height: rect.height});
function bounds(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) throw Error('图片尺寸无效或超出本地编辑范围');
}
function ratioValue(ratio) {
  if (!IMAGE_CROP_RATIOS.includes(ratio)) throw Error('裁剪比例无效');
  return ratio === 'free' ? null : Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]);
}
function validRect(rect) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => finite(rect[key])) || rect.width <= 0 || rect.height <= 0) throw Error('裁剪区域必须是有效的像素数值');
}

export function transformedImageSize(width, height, rotation = 0) {
  bounds(width, height);
  if (!Number.isSafeInteger(rotation) || rotation % 90) throw Error('旋转角度必须是90度的倍数');
  return Math.abs(rotation / 90) % 2 ? {width: height, height: width} : {width, height};
}

/** Clockwise turns rotate the visible image, including its current mirrors. */
export function rotateImageTransform({rotation = 0, flipX = false, flipY = false}, quarterTurns = 1) {
  if (!Number.isSafeInteger(rotation) || rotation % 90 || !Number.isSafeInteger(quarterTurns) || typeof flipX !== 'boolean' || typeof flipY !== 'boolean') throw Error('图片变换参数无效');
  const odd = Math.abs(quarterTurns) % 2;
  return {rotation: ((rotation % 360 + (quarterTurns % 4) * 90) % 360 + 360) % 360, flipX: odd ? flipY : flipX, flipY: odd ? flipX : flipY};
}

export function fitImageCrop(width, height, ratio = 'free') {
  bounds(width, height); const value = ratioValue(ratio);
  const w = value ? Math.min(width, height * value) : width, h = value ? w / value : height;
  return {x: (width - w) / 2, y: (height - h) / 2, width: w, height: h};
}

/** Clamp a numeric edit to the image; axis identifies the dimension just edited. */
export function clampImageCrop(rect, width, height, ratio = 'free', axis = 'width') {
  bounds(width, height); validRect(rect); const value = ratioValue(ratio);
  if (!['width', 'height'].includes(axis)) throw Error('裁剪轴无效');
  let w = clamp(rect.width, 1, width), h = clamp(rect.height, 1, height);
  if (value) { if (axis === 'height') { h = Math.min(h, width / value); w = h * value; } else { w = Math.min(w, height * value); h = w / value; } }
  return {x: clamp(rect.x, 0, width - w), y: clamp(rect.y, 0, height - h), width: w, height: h};
}

export function moveImageCrop(rect, dx, dy, width, height, ratio = 'free') {
  if (!finite(dx) || !finite(dy)) throw Error('裁剪位移无效');
  return clampImageCrop({...rect, x: rect.x + dx, y: rect.y + dy}, width, height, ratio);
}

/** Resize from an edge/corner while preserving its opposite anchor. */
export function resizeImageCrop(rect, handle, dx, dy, width, height, ratio = 'free') {
  bounds(width, height); validRect(rect);
  if (!['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(handle) || !finite(dx) || !finite(dy)) throw Error('裁剪拉伸参数无效');
  rect = clampImageCrop(rect, width, height, ratio);
  const value = ratioValue(ratio), sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const ax = sx < 0 ? rect.x + rect.width : sx > 0 ? rect.x : rect.x + rect.width / 2, ay = sy < 0 ? rect.y + rect.height : sy > 0 ? rect.y : rect.y + rect.height / 2;
  const maxW = sx < 0 ? ax : sx > 0 ? width - ax : 2 * Math.min(ax, width - ax), maxH = sy < 0 ? ay : sy > 0 ? height - ay : 2 * Math.min(ay, height - ay);
  let w = Math.min(maxW, Math.max(1, rect.width + dx * sx)), h = Math.min(maxH, Math.max(1, rect.height + dy * sy));
  if (value) {
    if (!sx || (sy && Math.abs(dy / rect.height) > Math.abs(dx / rect.width))) w = h * value; else h = w / value;
    const scale = Math.min(1, maxW / w, maxH / h); w *= scale; h *= scale;
  } else { w = Math.min(w, maxW); h = Math.min(h, maxH); }
  return {x: sx < 0 ? ax - w : sx > 0 ? ax : ax - w / 2, y: sy < 0 ? ay - h : sy > 0 ? ay : ay - h / 2, width: w, height: h};
}

export function imageEditFilename(name, mode = 'crop') {
  const stem = String(name || '图片').replace(/\.[^.]+$/, '').replace(/[\\/\x00-\x1f\x7f]/g, '').trim().slice(0, 60) || '图片';
  return `${stem}-${mode === 'transform' ? '变换' : '裁剪'}副本.png`;
}

/** Real local pixels only. The original file and canvas node are never overwritten. */
export function mountImageFrameTools({read, toast = () => {}, uploadMaterials, onSave} = {}) {
  if (typeof read !== 'function' || typeof uploadMaterials !== 'function' || typeof onSave !== 'function') throw new TypeError('图片编辑器回调不完整');
  if (!document.getElementById('osmanthus-image-frame-tools-css')) {
    const link = document.createElement('link'); link.id = 'osmanthus-image-frame-tools-css'; link.rel = 'stylesheet'; link.href = new URL('./image-frame-tools.css', import.meta.url).href; document.head.append(link);
  }
  const dialog = document.createElement('dialog'); dialog.className = 'ift-dialog'; dialog.setAttribute('aria-label', '本地图片编辑');
  dialog.innerHTML = `<header class="ift-heading"><div><strong data-ift-title>裁剪图片</strong><span data-ift-source></span></div><button type="button" data-ift-close aria-label="关闭图片编辑器">×</button></header><div class="ift-body"><div class="ift-stage"><div class="ift-image-wrap"><canvas class="ift-preview" aria-label="图片编辑预览"></canvas><div class="ift-crop-box" hidden>${['n','ne','e','se','s','sw','w','nw'].map(handle=>`<button type="button" class="ift-handle ift-${handle}" data-ift-handle="${handle}" aria-label="调整裁剪区域 ${handle}"></button>`).join('')}</div></div><p class="ift-loading">正在读取原图…</p></div><aside class="ift-controls"><section data-ift-crop-controls><label>裁剪比例<select data-ift-ratio>${IMAGE_CROP_RATIOS.map(ratio=>`<option value="${ratio}">${ratio === 'free' ? '自由' : ratio}</option>`).join('')}</select></label><div class="ift-number-grid">${[['x','X'],['y','Y'],['width','宽度'],['height','高度']].map(([key,label])=>`<label>${label}<input data-ift-field="${key}" type="number" step="1" min="${key==='x'||key==='y'?0:1}" aria-label="裁剪${label}像素"></label>`).join('')}</div><p class="ift-help">拖动选框可移动裁剪区域，拖动边角可调整大小。</p></section><section data-ift-transform-controls hidden><div class="ift-transform-buttons"><button type="button" data-ift-transform="rotateLeft" aria-label="向左旋转 90°">↶ 向左 90°</button><button type="button" data-ift-transform="rotate" aria-label="向右旋转 90°">↻ 向右 90°</button><button type="button" data-ift-transform="flipX" aria-pressed="false">↔ 水平镜像</button><button type="button" data-ift-transform="flipY" aria-pressed="false">↕ 垂直镜像</button></div><p class="ift-help">旋转与镜像按预览画面的方向应用。</p></section><div class="ift-output" data-ift-output></div><p class="ift-help">保存为新的 PNG 素材，原图保留。</p><p class="ift-error" role="status" aria-live="polite"></p></aside></div><footer><button type="button" data-ift-reset>重置</button><span></span><button type="button" data-ift-close>取消</button><button type="button" class="ift-save" data-ift-save disabled>保存为副本</button></footer>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), preview = $('.ift-preview'), wrap = $('.ift-image-wrap'), box = $('.ift-crop-box'), stage = $('.ift-stage');
  let current = null, image = null, session = 0, saving = false, destroyed = false, drag = null, scale = 1;
  const report = error => { const message = error?.message || String(error); $('.ift-error').textContent = message; toast(message); };
  function busyControls(value) {
    for (const control of dialog.querySelectorAll('[data-ift-transform],[data-ift-reset],[data-ift-field],[data-ift-ratio]')) control.disabled = value;
    $('[data-ift-save]').disabled = value || !image;
  }
  function currentNode(snapshot = current) {
    const project = read();
    if (!snapshot || project?.id !== snapshot.projectId) throw Error('工程已切换，未写入其他工程');
    const node = project.studio?.canvas?.nodes?.find(item => item.id === snapshot.nodeId);
    if (!node || node.type !== 'image' || node.asset?.url !== snapshot.sourceUrl) throw Error('原图片已更换或移除，未覆盖当前节点');
    return node;
  }
  const size = () => transformedImageSize(image.naturalWidth, image.naturalHeight, current.rotation);
  function drawInto(context, factor = 1, crop = {x: 0, y: 0}) {
    const full = size();
    context.scale(factor, factor); context.translate(-crop.x, -crop.y); context.translate(full.width / 2, full.height / 2); context.scale(current.flipX ? -1 : 1, current.flipY ? -1 : 1); context.rotate(current.rotation * Math.PI / 180); context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  }
  function render(redraw = true) {
    if (!current || !image || !dialog.open) return;
    const full = size(), rect = current.crop;
    if (redraw) {
      const availableW = Math.max(80, stage.clientWidth - 32), availableH = Math.max(100, Math.min(620, innerHeight * .66) - 32);
      scale = Math.min(1, availableW / full.width, availableH / full.height);
      const width = Math.max(1, Math.round(full.width * scale)), height = Math.max(1, Math.round(full.height * scale)), dpr = Math.min(2, devicePixelRatio || 1);
      wrap.style.width = width + 'px'; wrap.style.height = height + 'px'; preview.style.width = width + 'px'; preview.style.height = height + 'px'; preview.width = Math.round(width * dpr); preview.height = Math.round(height * dpr);
      const context = preview.getContext('2d'); context.clearRect(0, 0, preview.width, preview.height); context.save(); drawInto(context, dpr * scale); context.restore();
    }
    box.hidden = current.mode !== 'crop'; box.style.left = rect.x * scale + 'px'; box.style.top = rect.y * scale + 'px'; box.style.width = rect.width * scale + 'px'; box.style.height = rect.height * scale + 'px';
    for (const field of dialog.querySelectorAll('[data-ift-field]')) field.value = Math.round(rect[field.dataset.iftField]);
    $('[data-ift-ratio]').value = current.ratio;
    $('[data-ift-output]').textContent = `输出 ${Math.max(1, Math.round(rect.width))} × ${Math.max(1, Math.round(rect.height))} 像素`;
    for (const axis of ['flipX', 'flipY']) $(`[data-ift-transform="${axis}"]`).setAttribute('aria-pressed', String(current[axis]));
  }
  function close() { session++; current = null; image = null; drag = null; saving = false; if (dialog.open) dialog.close(); }
  async function open({node, mode = 'crop'} = {}) {
    if (destroyed) throw Error('图片编辑器已关闭');
    if (!['crop', 'transform'].includes(mode) || !node || node.type !== 'image' || !/^\/(?:mv\/)?files\/materials\/[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif)$/i.test(node.asset?.url || '')) { toast('请选择真实上传的本地图片素材'); return false; }
    close(); const token = session, snapshot = {projectId: read()?.id, nodeId: node.id, sourceUrl: node.asset.url, mode, ratio: 'free', rotation: 0, flipX: false, flipY: false}; current = snapshot;
    try { currentNode(snapshot); } catch (error) { report(error); close(); return false; }
    $('.ift-error').textContent = ''; $('.ift-loading').hidden = false; wrap.hidden = true; busyControls(false); $('[data-ift-save]').textContent = '保存为副本';
    $('[data-ift-title]').textContent = mode === 'crop' ? '裁剪图片' : '旋转与镜像'; $('[data-ift-crop-controls]').hidden = mode !== 'crop'; $('[data-ift-transform-controls]').hidden = mode !== 'transform';
    dialog.showModal();
    try {
      const loaded = await new Promise((resolve, reject) => { const item = new Image(); item.decoding = 'async'; item.onload = () => resolve(item); item.onerror = () => reject(Error('原图片读取失败，请确认素材仍在本地')); item.src = localUrl(snapshot.sourceUrl); });
      if (token !== session || !dialog.open) return false;
      currentNode(snapshot); bounds(loaded.naturalWidth, loaded.naturalHeight); image = loaded; current.crop = fitImageCrop(image.naturalWidth, image.naturalHeight); $('[data-ift-source]').textContent = `${loaded.naturalWidth} × ${loaded.naturalHeight} 像素`; $('.ift-loading').hidden = true; wrap.hidden = false; $('[data-ift-save]').disabled = false; render(); return true;
    } catch (error) { if (token === session) report(error); return false; }
  }
  async function save() {
    if (!current || !image || saving) return;
    const token = session, snapshot = {...current}, rect = copyRect(current.crop), width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    saving = true; busyControls(true); $('[data-ift-save]').textContent = '正在保存…';
    try {
      const node = currentNode(snapshot);
      if (width > 16384 || height > 16384 || width * height > 40000000) throw Error('输出图片过大，请缩小裁剪区域后保存');
      const output = document.createElement('canvas'); output.width = width; output.height = height; const context = output.getContext('2d'); if (!context) throw Error('当前浏览器无法编辑图片');
      context.save(); drawInto(context, 1, rect); context.restore();
      const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(Error('PNG编码失败，请缩小图片后重试')), 'image/png'));
      if (token !== session) return;
      currentNode(snapshot);
      const file = new File([blob], imageEditFilename(node.asset?.name || node.title, snapshot.mode), {type: 'image/png'});
      const uploaded = await uploadMaterials([file], {purpose: 'image-edit'}), material = (Array.isArray(uploaded) ? uploaded : uploaded?.materials)?.[0];
      if (token !== session) return;
      currentNode(snapshot);
      if (!material || (material.kind || material.type) !== 'image') throw Error('PNG副本上传未完成');
      if (await onSave({originalNodeId: snapshot.nodeId, material, width, height}) === false) throw Error('PNG已保存在资产库，当前画布未更新');
      if (token === session) { toast('已保存 PNG 副本，原图保留'); close(); }
    } catch (error) { if (token === session) report(error); }
    finally { if (token === session) { saving = false; busyControls(false); $('[data-ift-save]').textContent = '保存为副本'; } }
  }
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.hasAttribute('data-ift-close')) { close(); return; }
    if (!current || !image || saving) return;
    if (target.hasAttribute('data-ift-save')) { save(); return; }
    if (target.hasAttribute('data-ift-reset')) { Object.assign(current, {rotation: 0, flipX: false, flipY: false, ratio: 'free', crop: fitImageCrop(image.naturalWidth, image.naturalHeight)}); render(); return; }
    const transform = target.dataset.iftTransform;
    if (transform) { if (transform === 'rotate' || transform === 'rotateLeft') Object.assign(current, rotateImageTransform(current, transform === 'rotateLeft' ? -1 : 1)); else current[transform] = !current[transform]; const full = size(); current.crop = fitImageCrop(full.width, full.height); render(); }
  });
  dialog.addEventListener('change', event => {
    if (!current || !image || saving) return;
    try {
      const full = size();
      if (event.target.hasAttribute('data-ift-ratio')) { current.ratio = event.target.value; current.crop = current.ratio === 'free' ? copyRect(current.crop) : fitImageCrop(full.width, full.height, current.ratio); }
      const field = event.target.dataset.iftField;
      if (field) current.crop = clampImageCrop({...current.crop, [field]: Number(event.target.value)}, full.width, full.height, current.ratio, field === 'height' ? 'height' : 'width');
      render(false);
    } catch (error) { report(error); render(false); }
  });
  wrap.addEventListener('pointerdown', event => {
    if (!current || !image || saving || current.mode !== 'crop' || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: copyRect(current.crop), handle: event.target.closest('[data-ift-handle]')?.dataset.iftHandle || null}; wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId || !current || saving) return;
    const full = size(), dx = (event.clientX - drag.x) / scale, dy = (event.clientY - drag.y) / scale;
    current.crop = drag.handle ? resizeImageCrop(drag.rect, drag.handle, dx, dy, full.width, full.height, current.ratio) : moveImageCrop(drag.rect, dx, dy, full.width, full.height, current.ratio); render(false);
  });
  const stopDrag = () => { drag = null; };
  wrap.addEventListener('pointerup', stopDrag); wrap.addEventListener('pointercancel', stopDrag); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const onResize = () => render(); window.addEventListener('resize', onResize);
  return Object.freeze({open, close, destroy() { destroyed = true; close(); window.removeEventListener('resize', onResize); dialog.remove(); }});
}
