import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateProject} from './public/domain.js';
import {validateCanvasDocument} from './public/canvas-document.js';

export const CANVAS_PROJECT_SCHEMA = 'osmanthus-canvas-project-v1';
export const MAX_CANVAS_RECORD_BYTES = 16_000_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validId = value => typeof value === 'string' && UUID.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const cleanTitle = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw fail('画布名称需为1至120字的单行文字');
  return value.trim();
};
const fileExists = file => {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const previewUrl = value => typeof value === 'string' && ((value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) || /^https?:\/\//i.test(value)) ? value : null;

/**
 * A local catalogue of complete MV projects; never changes the active project,
 * handoff cache, material files, source audio, or rendered outputs.
 *
 * save(project), rename(id,title), duplicate(id,{title?}), archive(id), restore(id)
 * return {id,project,createdAt,updatedAt,archivedAt}. get(id) returns this record
 * or null; pass {includeArchived:true} to read an archived record. list() returns
 * active summaries; list({archived:true}) returns archived summaries only.
 * Optional validate/write/idFactory callbacks must be synchronous. write receives
 * a private staging filename; the store verifies it and performs the final rename.
 */
export function createCanvasProjects({data, validate = validateProject, write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), {mode: 0o600}), idFactory = () => crypto.randomUUID()} = {}) {
  if (typeof data !== 'string' || !data || typeof validate !== 'function' || typeof write !== 'function' || typeof idFactory !== 'function') throw new TypeError('画布目录存储参数无效');
  const requestedRoot = path.resolve(data, 'canvas-projects');
  fs.mkdirSync(requestedRoot, {recursive: true});
  if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw fail('画布项目目录不能是符号链接', 500);
  const root = fs.realpathSync(requestedRoot), identity = fs.statSync(root);
  function assertRoot() {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw fail('画布项目目录已改变，请重启服务', 500);
  }
  function requireId(id) { if (!validId(id)) throw fail('画布项目标识无效'); return id; }
  const target = id => path.join(root, requireId(id) + '.json');
  function readRegular(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANVAS_RECORD_BYTES) throw fail('画布项目文件无效');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_CANVAS_RECORD_BYTES) throw fail('画布项目文件已改变');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  }
  function checkedProject(input) {
    if (!object(input) || !validId(input.id)) throw fail('请为画布提供合法UUID项目标识');
    let serialized;
    try {
      serialized = JSON.stringify(input, (_key, value) => {
        if ((typeof value === 'number' && !Number.isFinite(value)) || ['bigint', 'symbol', 'function'].includes(typeof value)) throw Error('non-JSON value');
        return value;
      });
    } catch { throw fail('画布项目必须是可保存的JSON数据'); }
    if (Buffer.byteLength(serialized) > MAX_CANVAS_RECORD_BYTES - 1024) throw fail('画布项目数据超过16MB', 413);
    const project = JSON.parse(serialized);
    project.title = cleanTitle(project.title);
    if (!object(project.source) || !object(project.plan) || (project.studio != null && !object(project.studio)) || (project.musicHandoff != null && !object(project.musicHandoff))) throw fail('画布项目内容不完整');
    try {
      const result = validate(project);
      if (result === false || result?.then) throw Error('validation failed');
      if (project.studio?.canvas != null) validateCanvasDocument(project.studio.canvas);
    } catch (error) { throw fail(error.message || '画布项目校验失败'); }
    // Validators are assertions. Store a detached JSON value even if a caller's
    // validator retained a reference, and keep the path identity immutable.
    if (project.id !== input.id) throw fail('校验过程不能更改画布项目标识');
    return clone(project);
  }
  function checkedRecord(saved, id) {
    if (!object(saved) || saved.schema !== CANVAS_PROJECT_SCHEMA || saved.id !== id || !object(saved.project) || saved.project.id !== id || !isDate(saved.createdAt) || !isDate(saved.updatedAt) || saved.updatedAt < saved.createdAt || (saved.archivedAt !== null && (!isDate(saved.archivedAt) || saved.archivedAt < saved.createdAt || saved.archivedAt > saved.updatedAt)) || !/^[a-f0-9]{64}$/.test(saved.sha256 || '') || digest(saved.project) !== saved.sha256) throw fail('画布项目记录校验失败');
    const project = checkedProject(saved.project);
    if (digest(project) !== saved.sha256) throw fail('画布项目记录校验失败');
    return {id, project, createdAt: saved.createdAt, updatedAt: saved.updatedAt, archivedAt: saved.archivedAt};
  }
  function readRecord(id) {
    if (!validId(id)) return null;
    assertRoot();
    try { return checkedRecord(JSON.parse(readRegular(target(id))), id); } catch { return null; }
  }
  function required(id, includeArchived = false) {
    requireId(id);
    const record = readRecord(id);
    if (!record) throw fail('找不到可用的画布项目', 404);
    if (!includeArchived && record.archivedAt) throw fail('画布已归档，请先恢复', 409);
    return record;
  }
  function commit(record) {
    assertRoot();
    const file = target(record.id), temp = path.join(root, '.' + record.id + '.' + crypto.randomUUID() + '.tmp');
    const saved = {schema: CANVAS_PROJECT_SCHEMA, ...record, sha256: digest(record.project)};
    const expected = JSON.stringify(saved);
    if (Buffer.byteLength(expected) > MAX_CANVAS_RECORD_BYTES) throw fail('画布项目数据超过16MB', 413);
    let owned = false;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600); fs.closeSync(fd); owned = true;
      const result = write(temp, saved);
      if (result?.then) throw fail('画布存储写入器必须同步完成', 500);
      const written = JSON.parse(readRegular(temp));
      checkedRecord(written, record.id);
      if (JSON.stringify(written) !== expected) throw fail('画布写入内容与保存内容不一致', 500);
      assertRoot();
      // Never follow or replace a symlink at a registered project filename.
      if (fileExists(file) && !fs.lstatSync(file).isFile()) throw fail('画布项目目标文件无效', 409);
      fs.renameSync(temp, file);
      return clone(record);
    } finally {
      if (owned) { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
  }
  const timestamp = previous => new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
  function save(input) {
    const project = checkedProject(input);
    assertRoot();
    const existing = readRecord(project.id);
    if (!existing && fileExists(target(project.id))) throw fail('已有画布记录无法校验，未覆盖原文件', 409);
    if (existing?.archivedAt) throw fail('画布已归档，请先恢复再保存', 409);
    const updatedAt = timestamp(existing);
    return commit({id: project.id, project, createdAt: existing?.createdAt || updatedAt, updatedAt, archivedAt: null});
  }
  function get(id, {includeArchived = false} = {}) {
    const record = readRecord(id);
    return record && (includeArchived || !record.archivedAt) ? record : null;
  }
  function summary(record) {
    const {project, ...meta} = record, nodes = project.studio?.canvas?.nodes || [];
    const image = nodes.find(node => node.type === 'image' && previewUrl(node.asset?.thumbnailUrl || node.asset?.url));
    const cover = previewUrl(project.studio?.cover) || previewUrl(project.source?.cover) || previewUrl(image?.asset?.thumbnailUrl || image?.asset?.url);
    const output = previewUrl(project.generated?.url) ? {url: project.generated.url, ...(typeof project.generated.sha256 === 'string' ? {sha256: project.generated.sha256} : {}), ...(Number.isFinite(project.generated.duration) ? {duration: project.generated.duration} : {})} : null;
    return {...meta, title: project.title, cover, output, nodeCount: nodes.length, type: project.studio?.type || 'canvas', musicTitle: typeof project.source.name === 'string' ? project.source.name : ''};
  }
  function list({archived = false} = {}) {
    assertRoot();
    return fs.readdirSync(root).filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => readRecord(name.slice(0, -5))).filter(record => record && Boolean(record.archivedAt) === Boolean(archived)).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  function rename(id, title) {
    const record = required(id);
    record.project.title = cleanTitle(title);
    return save(record.project);
  }
  function duplicate(id, options = {}) {
    const original = required(id), project = clone(original.project);
    const newId = idFactory();
    requireId(newId);
    if (newId === id || fileExists(target(newId))) throw fail('新画布项目标识已存在，请重试', 409);
    project.id = newId;
    const title = typeof options === 'string' ? options : options?.title;
    project.title = title === undefined ? original.project.title.slice(0, 117) + ' 副本' : cleanTitle(title);
    if (project.musicHandoff) {
      project.studio ||= {};
      project.studio.originMusicSnapshot = {...clone(project.musicHandoff), mv_project_id: original.id};
    }
    delete project.musicHandoff;
    // source/generated remain immutable file references. No media is copied,
    // deleted, or written into the original handoff's project cache.
    return save(project);
  }
  function archive(id) {
    const record = required(id, true);
    if (record.archivedAt) return record;
    record.updatedAt = timestamp(record); record.archivedAt = record.updatedAt;
    return commit(record);
  }
  function restore(id) {
    const record = required(id, true);
    if (!record.archivedAt) return record;
    record.updatedAt = timestamp(record); record.archivedAt = null;
    return commit(record);
  }
  return Object.freeze({list, get, save, rename, duplicate, archive, restore});
}
