import { createMidiDocument, parseMidi, exportMidi, validateMidiDocument } from './midi-document.js';
import { mountMidiWorkbench } from './midi-workbench.js';

const host = document.getElementById('midi-workbench');
const saveStatus = document.getElementById('midi-save-status');
const notice = document.getElementById('midi-import-notice');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
let db = null, pending = null, saving = false, timer = null, hasUnstoredChanges = false;
let expectedRevision = 0, conflicted = false;

function openStore() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('浏览器不支持本地草稿'));
    const request = indexedDB.open('osmanthus-midi-workbench-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地草稿'));
    request.onblocked = () => reject(new Error('本地草稿暂时被占用'));
  });
}
function readDraft() {
  return new Promise((resolve, reject) => {
    const request = db.transaction('drafts', 'readonly').objectStore('drafts').get('current');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('无法读取草稿'));
  });
}
function writeDraft(value, expected) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    let conflict = false;
    const current = store.get('current');
    current.onsuccess = () => {
      const record = current.result;
      const revision = Number.isSafeInteger(record?.revision) ? record.revision : 0;
      if (revision !== expected) { conflict = true; tx.abort(); return; }
      store.put({ revision: revision + 1, document: value }, 'current');
    };
    tx.oncomplete = () => resolve(expected + 1);
    tx.onerror = () => reject(tx.error || new Error('草稿未能保存'));
    tx.onabort = () => reject(conflict ? new Error('draft-conflict') : (tx.error || new Error('草稿保存已中止')));
  });
}
function updateStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle('is-error', isError);
}
function warn(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  notice.hidden = !list.length;
  notice.textContent = list.join(' ');
}
async function flush() {
  clearTimeout(timer); timer = null;
  if (saving || !pending || !db || conflicted) return;
  saving = true;
  let snapshot = null;
  try {
    while (pending) {
      snapshot = pending; pending = null;
      expectedRevision = await writeDraft(snapshot, expectedRevision);
    }
    hasUnstoredChanges = false;
    updateStatus('草稿已保存在本机浏览器；换电脑请先导出 MIDI。');
  } catch (error) {
    if (!pending) pending = snapshot;
    hasUnstoredChanges = true;
    conflicted = error?.message === 'draft-conflict';
    updateStatus(conflicted ? '另一个页面修改了草稿；为防止覆盖，请先导出本页，再刷新。' : '本地草稿保存失败，请先导出 MIDI；再次编辑可重试保存。', true);
  } finally { saving = false; }
}
function queueSave(doc) {
  try { pending = structuredClone(validateMidiDocument(doc)); }
  catch { hasUnstoredChanges = true; updateStatus('工程数据暂时无法保存，请检查编辑内容。', true); return; }
  warn(doc.warnings);
  hasUnstoredChanges = true;
  if (!db) { updateStatus('浏览器草稿不可用，请导出 MIDI 文件保存。', true); return; }
  if (conflicted) { updateStatus('另一个页面修改了草稿；为防止覆盖，请先导出本页，再刷新。', true); return; }
  updateStatus('正在保存本机草稿…');
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), 250);
}
function saveMidi(doc) {
  const bytes = exportMidi(validateMidiDocument(doc));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'Osmanthus-MIDI.mid';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let initial = createMidiDocument();
try {
  db = await openStore();
  const saved = await readDraft();
  if (saved) {
    expectedRevision = Number.isSafeInteger(saved.revision) ? saved.revision : 0;
    initial = validateMidiDocument(saved.document || saved);
  }
  updateStatus('草稿保存在本机浏览器；换电脑请先导出 MIDI。');
} catch {
  db?.close(); db = null;
  updateStatus('本地草稿无法读取或保存，请及时导出 MIDI 文件。', true);
}
try {
  mountMidiWorkbench(host, {
    document: initial,
    onChange: queueSave,
    onNew() { warn([]); return createMidiDocument(); },
    async onImport(file) {
      if (!file || file.size > MAX_FILE_BYTES) throw new Error('文件过大，请选择 10 MB 以内的 MIDI 文件。');
      const result = parseMidi(await file.arrayBuffer());
      return result;
    },
    onExport: saveMidi,
  });
  warn(initial.warnings);
} catch (error) {
  host.textContent = '无法打开 MIDI 工作台：' + (error?.message || '请刷新重试');
  updateStatus('你的原有歌曲没有被修改。', true);
}
window.addEventListener('beforeunload', event => {
  if (hasUnstoredChanges) { event.preventDefault(); event.returnValue = ''; }
});
