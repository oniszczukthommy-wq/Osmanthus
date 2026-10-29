import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createCanvasProjects} from '../canvas-projects.mjs';
import {makeProject, validateProject} from '../public/domain.js';
import {createCanvasDocument} from '../public/canvas-document.js';

function project(title = '我的画布') {
  const value = makeProject();
  value.id = crypto.randomUUID(); value.title = title;
  value.source.cover = '/assets/song-cover.png';
  value.studio = {type: 'story', prompt: '保留完整创作要求', canvas: createCanvasDocument({nodes: [
    {id: 'image-1', type: 'image', title: '角色参考', x: 80, y: 120, width: 320, height: 220, asset: {id: crypto.randomUUID(), url: '/files/materials/reference.png', name: '参考图.png'}},
    {id: 'text-1', type: 'text', x: 440, y: 120, width: 300, height: 180, content: '人物在站台等候'},
  ], edges: [{id: 'edge-1', source: 'image-1', target: 'text-1'}]})};
  value.generated = {url: '/files/jobs/' + crypto.randomUUID() + '/mv.mp4', sha256: 'a'.repeat(64), duration: 30};
  return value;
}
function sandbox(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-canvas-projects-test-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  return {data, folder: path.join(data, 'canvas-projects'), store: createCanvasProjects({data, ...options})};
}

test('保存完整项目、轻量目录摘要、独立读取和重启查找', t => {
  const {store, data, folder} = sandbox(t), input = project();
  const before = JSON.stringify(input), record = store.save(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(record.project, input);
  assert.equal(record.id, input.id);
  assert.equal(record.archivedAt, null);
  assert.equal(record.createdAt, record.updatedAt);
  assert.equal(store.list({archived: true}).length, 0);
  const summary = store.list()[0];
  assert.equal(summary.title, input.title);
  assert.equal(summary.cover, input.source.cover);
  assert.deepEqual(summary.output, input.generated);
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.project, undefined);
  assert.equal(summary.musicTitle, input.source.name);
  record.project.studio.canvas.nodes[0].x = 999;
  assert.equal(store.get(input.id).project.studio.canvas.nodes[0].x, 80);
  assert.deepEqual(createCanvasProjects({data}).get(input.id).project, input);
  assert.deepEqual(fs.readdirSync(folder), [input.id + '.json']);
  input.studio.prompt = '修改后的创作要求';
  const updated = store.save(input);
  assert.equal(updated.createdAt, record.createdAt);
  assert(updated.updatedAt > record.updatedAt);
  assert.equal(updated.project.studio.prompt, input.studio.prompt);
  const renamed = store.rename(input.id, '  新名称  ');
  assert.equal(renamed.project.title, '新名称');
  assert.equal(renamed.project.studio.prompt, input.studio.prompt);
  assert(renamed.updatedAt > updated.updatedAt);
  assert.equal(store.list()[0].title, '新名称');
});

test('副本新ID且解除handoff，保留来源快照、画布、原音频与已生成文件引用', t => {
  const nextId = crypto.randomUUID(), {store, data} = sandbox(t, {idFactory: () => nextId});
  const input = project('关联歌曲画布');
  input.musicHandoff = {id: crypto.randomUUID(), project_id: crypto.randomUUID(), revision: 7, fingerprint: 'b'.repeat(64), audio_sha256: 'c'.repeat(64), source_kind: 'current_mix'};
  for (const dir of ['uploads', 'materials', 'jobs', 'music-projects']) fs.mkdirSync(path.join(data, dir));
  const media = path.join(data, 'uploads', 'original.mp3'), image = path.join(data, 'materials', 'user-image.png'), originalCache = path.join(data, 'music-projects', input.musicHandoff.id + '.json');
  fs.writeFileSync(media, 'original audio'); fs.writeFileSync(image, 'original image'); fs.writeFileSync(originalCache, JSON.stringify(input));
  const original = store.save(input), copy = store.duplicate(input.id);
  assert.equal(copy.id, nextId);
  assert.equal(copy.project.id, nextId);
  assert.equal(copy.project.title, '关联歌曲画布 副本');
  assert.equal(copy.project.musicHandoff, undefined);
  assert.deepEqual(copy.project.studio.originMusicSnapshot, {...input.musicHandoff, mv_project_id: input.id});
  assert.deepEqual(copy.project.source, input.source);
  assert.deepEqual(copy.project.generated, input.generated);
  assert.deepEqual(copy.project.studio.canvas, input.studio.canvas);
  copy.project.source.name = '副本改名'; copy.project.studio.canvas.nodes[0].x = 800;
  store.save(copy.project);
  assert.deepEqual(store.get(input.id), original);
  assert.equal(JSON.parse(fs.readFileSync(originalCache)).musicHandoff.id, input.musicHandoff.id);
  assert.equal(fs.readFileSync(media, 'utf8'), 'original audio');
  assert.equal(fs.readFileSync(image, 'utf8'), 'original image');
  assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), ['original.mp3']);
  assert.deepEqual(fs.readdirSync(path.join(data, 'materials')), ['user-image.png']);
  assert.deepEqual(fs.readdirSync(path.join(data, 'jobs')), []);
});

test('归档/恢复分开展示；归档拒绝旧页面保存，且不会删除项目或媒体', t => {
  const {store, data, folder} = sandbox(t), input = project();
  fs.mkdirSync(path.join(data, 'uploads')); fs.writeFileSync(path.join(data, 'uploads', 'keep.wav'), 'keep');
  const saved = store.save(input), archived = store.archive(input.id);
  assert(archived.archivedAt);
  assert(archived.updatedAt > saved.updatedAt);
  assert.deepEqual(store.list(), []);
  assert.equal(store.list({archived: true})[0].id, input.id);
  assert.equal(store.get(input.id), null);
  assert.deepEqual(store.get(input.id, {includeArchived: true}), archived);
  assert.deepEqual(store.archive(input.id), archived);
  for (const operation of [() => store.save(input), () => store.rename(input.id, '旧页面修改'), () => store.duplicate(input.id)]) {
    assert.throws(operation, error => error.status === 409);
  }
  assert.deepEqual(fs.readdirSync(folder), [input.id + '.json']);
  const restored = store.restore(input.id);
  assert.equal(restored.archivedAt, null);
  assert(restored.updatedAt > archived.updatedAt);
  assert.deepEqual(restored.project, input);
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.list({archived: true}), []);
  assert.deepEqual(store.restore(input.id), restored);
  assert.equal(fs.readFileSync(path.join(data, 'uploads', 'keep.wav'), 'utf8'), 'keep');
});

test('合法UUID、完整项目与画布验证；无效路径不能读写改名或归档', t => {
  const {store, folder} = sandbox(t), input = project();
  for (const id of ['draft', '', '../project', input.id + '/..', input.id + '.json', '%2e%2e%2fproject', input.id.toUpperCase()]) {
    assert.equal(store.get(id), null);
    for (const operation of [() => store.save({...input, id}), () => store.rename(id, '改名'), () => store.archive(id), () => store.restore(id), () => store.duplicate(id)]) assert.throws(operation, error => error.status === 400);
  }
  assert.throws(() => store.save({...input, title: ''}));
  assert.throws(() => store.save({...input, title: 'x'.repeat(121)}));
  assert.throws(() => store.save({...input, source: null}));
  assert.throws(() => store.save({...input, duration: 0}));
  const badCanvas = structuredClone(input); badCanvas.studio.canvas.nodes[0].width = -1;
  assert.throws(() => store.save(badCanvas));
  const nonJSON = structuredClone(input); nonJSON.studio.custom = Infinity;
  assert.throws(() => store.save(nonJSON));
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.throws(() => store.rename(input.id, '不存在'), error => error.status === 404);
  const custom = sandbox(t, {validate: () => false});
  assert.throws(() => custom.store.save(input));
  assert.deepEqual(fs.readdirSync(custom.folder), []);
});

test('复制时ID冲突或无效ID不覆盖已有项目；独立副本可保留已有来源快照', t => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const {store} = sandbox(t, {idFactory: () => ids.shift()});
  const input = project(); input.studio.originMusicSnapshot = {project_id: crypto.randomUUID(), revision: 3};
  const saved = store.save(input), copy = store.duplicate(input.id, {title: '独立副本'});
  assert.equal(copy.project.title, '独立副本');
  assert.deepEqual(copy.project.studio.originMusicSnapshot, input.studio.originMusicSnapshot);
  const third = store.duplicate(copy.id, '副本的副本');
  assert.equal(third.project.title, '副本的副本');
  assert.deepEqual(third.project.studio.originMusicSnapshot, input.studio.originMusicSnapshot);
  assert.deepEqual(store.get(input.id), saved);
  const collision = sandbox(t, {idFactory: () => input.id}); collision.store.save(input);
  assert.throws(() => collision.store.duplicate(input.id), error => error.status === 409);
  assert.equal(collision.store.list().length, 1);
  const invalid = sandbox(t, {idFactory: () => '../bad'}); invalid.store.save(input);
  assert.throws(() => invalid.store.duplicate(input.id), error => error.status === 400);
});

test('原子保存：写入器只接收临时文件；写入异常与错误内容保留旧版本', t => {
  let behavior = 'ok', observedOldTitle = null, final;
  const {store, folder} = sandbox(t, {write(file, value) {
    assert.notEqual(file, final);
    if (final && fs.existsSync(final)) observedOldTitle = JSON.parse(fs.readFileSync(final)).project.title;
    if (behavior === 'throw') { fs.writeFileSync(file, '{partial'); throw Error('模拟磁盘写入失败'); }
    if (behavior === 'wrong') { fs.writeFileSync(file, JSON.stringify({...value, project: {...value.project, title: '意外改变'}})); return; }
    fs.writeFileSync(file, JSON.stringify(value));
  }});
  const input = project('原始名称'); final = path.join(folder, input.id + '.json');
  const first = store.save(input), bytes = fs.readFileSync(final);
  for (const mode of ['throw', 'wrong']) {
    behavior = mode;
    assert.throws(() => store.save({...input, title: '尝试新名称'}));
    assert(fs.readFileSync(final).equals(bytes));
    assert.deepEqual(store.get(input.id), first);
    assert.deepEqual(fs.readdirSync(folder), [input.id + '.json']);
  }
  behavior = 'ok';
  const next = store.rename(input.id, '原子更新完成');
  assert.equal(observedOldTitle, '原始名称');
  assert.equal(next.project.title, '原子更新完成');
  assert.equal(store.get(input.id).project.title, '原子更新完成');
});

test('损坏、篡改与冒名记录不进列表；保存不覆盖不可校验的原文件', t => {
  const {store, folder} = sandbox(t), input = project(), saved = store.save(input);
  const file = path.join(folder, input.id + '.json'), original = fs.readFileSync(file), parsed = JSON.parse(original);
  const unknown = path.join(folder, 'user-notes.json'); fs.writeFileSync(unknown, 'keep');
  const patches = [Buffer.from('{'), Buffer.from(JSON.stringify({...parsed, schema: 'unknown'})), Buffer.from(JSON.stringify({...parsed, project: {...parsed.project, title: '被篡改'}})), Buffer.from(JSON.stringify({...parsed, id: crypto.randomUUID()}))];
  for (const bytes of patches) {
    fs.writeFileSync(file, bytes);
    assert.equal(store.get(input.id), null);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.save(input), error => error.status === 409);
    assert(fs.readFileSync(file).equals(bytes));
  }
  fs.writeFileSync(file, original);
  assert.deepEqual(store.get(input.id), saved);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep');
});

test('拒绝目录、记录和临时文件符号链接；外部用户文件保留', t => {
  const {store, data, folder} = sandbox(t), input = project(); store.save(input);
  const file = path.join(folder, input.id + '.json'), external = path.join(data, 'external.json');
  fs.renameSync(file, external); fs.symlinkSync(external, file);
  const bytes = fs.readFileSync(external);
  assert.equal(store.get(input.id), null);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.save(input), error => error.status === 409);
  assert.throws(() => store.archive(input.id), error => error.status === 404);
  assert(fs.lstatSync(file).isSymbolicLink());
  assert(fs.readFileSync(external).equals(bytes));
  const linked = path.join(data, 'linked'); fs.mkdirSync(linked);
  fs.symlinkSync(folder, path.join(linked, 'canvas-projects'));
  assert.throws(() => createCanvasProjects({data: linked}), /符号链接/);
  const stage = sandbox(t, {write(tempFile) { fs.unlinkSync(tempFile); fs.symlinkSync(external, tempFile); }});
  assert.throws(() => stage.store.save(project()));
  assert(fs.readFileSync(external).equals(bytes));
  assert.deepEqual(fs.readdirSync(stage.folder), []);
});
