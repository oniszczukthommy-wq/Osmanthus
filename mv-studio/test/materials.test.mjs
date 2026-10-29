import {RED_WEBP} from './synthetic-media.mjs';
import {mediaTools} from '../runtime-config.mjs';
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMaterialStore, MATERIAL_LIMITS} from '../materials.mjs';

const ff = mediaTools().ffmpeg;
const fp = mediaTools().ffprobe;
const probe = file => JSON.parse(execFileSync(fp, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {encoding: 'utf8', timeout: 20000, maxBuffer: 1e6, stdio: ['ignore', 'pipe', 'pipe']}));
let temp, sources;
const source = ext => fs.readFileSync(path.join(sources, 'sample' + ext));
const encode = args => execFileSync(ff, ['-y', '-v', 'error', ...args], {timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']});
function sandbox(t, options = {}) {
  const data = fs.mkdtempSync(path.join(temp, 'store-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  return {data, folder: path.join(data, 'materials'), store: createMaterialStore({data, probe, ...options})};
}

before(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-materials-test-'));
  sources = path.join(temp, 'originals');
  fs.mkdirSync(sources);
  for (const ext of ['.png', '.jpg', '.gif']) {
    encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=64x48', '-frames:v', '1', path.join(sources, 'sample' + ext)]);
  }
  fs.copyFileSync(path.join(sources, 'sample.jpg'), path.join(sources, 'sample.jpeg'));
  fs.writeFileSync(path.join(sources, 'sample.webp'), RED_WEBP);
  for (const [ext, codec] of [['.mp4', 'libx264'], ['.mov', 'libx264'], ['.webm', 'libvpx'], ['.mkv', 'libvpx']]) {
    encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=64x48:r=10', '-t', '0.3', '-c:v', codec, '-pix_fmt', 'yuv420p', path.join(sources, 'sample' + ext)]);
  }
  for (const [ext, codec] of [['.mp3', 'libmp3lame'], ['.wav', 'pcm_s16le'], ['.m4a', 'aac'], ['.aac', 'aac'], ['.flac', 'flac'], ['.ogg', 'libvorbis'], ['.opus', 'libopus']]) {
    encode(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.3', '-c:a', codec, path.join(sources, 'sample' + ext)]);
  }
  for (const ext of ['.mp4', '.m4a']) {
    const file = path.join(sources, 'padded' + ext);
    const input = ext === '.mp4' ? ['-i', 'color=s=64x48:r=10', '-c:v', 'libx264'] : ['-i', 'sine=frequency=440:sample_rate=16000', '-c:a', 'aac'];
    encode(['-f', 'lavfi', ...input, '-t', '0.3', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', file]);
    const free = Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]);
    fs.writeFileSync(file, Buffer.concat([free, fs.readFileSync(file)]));
    encode(['-i', file, '-f', 'null', '-']);
  }
});
after(() => { if (temp) fs.rmSync(temp, {recursive: true, force: true}); });

test('FFprobe实测所有受支持图片/视频/音频，保留原名且复制到唯一素材ID', t => {
  const {data, store, folder} = sandbox(t);
  const formats = [['image', ['.png', '.jpg', '.jpeg', '.webp', '.gif']], ['video', ['.mp4', '.mov', '.webm']], ['audio', ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']]];
  const ids = new Set();
  for (const [kind, extensions] of formats) {
    for (const ext of extensions) {
      const bytes = source(ext), name = '画布素材 ' + ext.toUpperCase();
      const material = store.upload(name, bytes);
      assert.equal(material.kind, kind);
      assert.equal(material.name, name);
      assert.equal(material.bytes, bytes.length);
      assert.equal(material.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
      assert.match(material.id, /^[a-f0-9-]{36}$/);
      assert(!ids.has(material.id)); ids.add(material.id);
      assert.equal(material.url, `/files/materials/${material.id}${ext}`);
      if (kind === 'audio') { assert.equal(material.width, 0); assert.equal(material.height, 0); }
      else { assert(material.width > 0); assert(material.height > 0); }
      if (kind !== 'image') assert(material.duration > 0);
      assert.deepEqual(store.get(material.id), material);
      const asset = store.asset(material.id + ext);
      assert.equal(asset.file, fs.realpathSync(path.join(folder, material.id + ext)));
      assert.match(asset.mime, new RegExp('^' + kind + '/'));
      assert(fs.readFileSync(asset.file).equals(bytes));
      assert.deepEqual(store.asset(material.id), asset);
    }
  }
  assert.equal(store.list().length, 15);
  assert.equal(createMaterialStore({data, probe}).list().length, 15);
  assert.equal(fs.readdirSync(folder).length, 30);
  const repeated = store.upload('再次上传.png', source('.png'));
  assert(!ids.has(repeated.id));
  assert(fs.existsSync(path.join(sources, 'sample.png')));
});

test('扩展名、真实容器、视频/音频类型和伪造内容均须一致；拒绝后无残留', t => {
  const {store, folder} = sandbox(t);
  const invalid = [
    ['../sample.png', source('.png')], ['a\\b.png', source('.png')], ['a\0.png', source('.png')],
    ['画布.svg', Buffer.from('<svg/>')], ['sample.exe', source('.png')], ['no-extension', source('.png')],
    ['sample.png', source('.jpg')], ['sample.jpg', source('.png')], ['sample.webp', source('.gif')],
    ['sample.png', source('.mp4')], ['sample.mp3', source('.wav')], ['sample.wav', source('.mp3')],
    ['sample.mp4', source('.m4a')], ['sample.m4a', source('.mp4')],
    ['sample.mov', source('.mp4')], ['sample.mp4', source('.mov')],
    ['sample.webm', source('.mkv')], ['sample.opus', source('.ogg')],
    ['sample.png', Buffer.from('not an image')], ['sample.png', Buffer.alloc(0)], ['sample.png', new Uint8Array([1])],
  ];
  for (const [name, bytes] of invalid) {
    assert.throws(() => store.upload(name, bytes), error => error.status === 400, name);
    assert.deepEqual(fs.readdirSync(folder), [], name);
  }
});

test('有效MP4/M4A允许ftyp前存在顶层padding box', t => {
  const {store} = sandbox(t);
  for (const ext of ['.mp4', '.m4a']) {
    const material = store.upload('带padding' + ext, fs.readFileSync(path.join(sources, 'padded' + ext)));
    assert.equal(material.kind, ext === '.mp4' ? 'video' : 'audio');
    assert(material.duration > 0);
    assert(store.asset(material.id));
  }
});

test('图片20MB、音视频80MB在写盘和探测前拒绝', t => {
  let calls = 0;
  const {store, folder} = sandbox(t, {probe() { calls++; throw Error('must not probe'); }});
  for (const [name, size] of [['large.png', MATERIAL_LIMITS.image + 1], ['large.mp4', MATERIAL_LIMITS.video + 1], ['large.wav', MATERIAL_LIMITS.audio + 1]]) {
    assert.throws(() => store.upload(name, Buffer.alloc(size)), error => error.status === 413);
  }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('未登记文件和越界路径不可见、不可删；删除已登记副本保留用户原件', t => {
  const {store, folder} = sandbox(t);
  const original = source('.png'), uploaded = store.upload('原图.png', original);
  const orphan = path.join(folder, 'user-original.png');
  fs.writeFileSync(orphan, original);
  for (const candidate of ['../originals/sample.png', uploaded.id + '.png/../../sample.png', uploaded.id + '.jpg', uploaded.url, 'user-original.png', '%2e%2e%2fsample.png']) {
    assert.equal(store.asset(candidate), null);
    assert.equal(store.get(candidate), null);
    assert.equal(store.remove(candidate), false);
  }
  assert.equal(store.list().length, 1);
  assert.equal(store.remove(uploaded.id), true);
  assert.equal(store.remove(uploaded.id), false);
  assert.equal(store.get(uploaded.id), null);
  assert.equal(store.asset(uploaded.id + '.png'), null);
  assert.equal(store.list().length, 0);
  assert(fs.readFileSync(orphan).equals(original));
  assert(source('.png').equals(original));
  assert.deepEqual(fs.readdirSync(folder), ['user-original.png']);
});

test('列表和素材读取校验hash；篡改副本不自动删除', t => {
  const {store, folder} = sandbox(t);
  const material = store.upload('校验.png', source('.png'));
  const file = path.join(folder, material.id + '.png'), bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  assert.equal(store.get(material.id), null);
  assert.equal(store.asset(material.id + '.png'), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.remove(material.id), false);
  assert(fs.existsSync(file));
  assert(fs.existsSync(path.join(folder, material.id + '.json')));
});

test('注册记录无法指定越界路径或冒充其它类型', t => {
  const {store, folder} = sandbox(t);
  const material = store.upload('校验.png', source('.png'));
  const record = path.join(folder, material.id + '.json'), good = JSON.parse(fs.readFileSync(record));
  for (const patch of [{name: '../originals/sample.png'}, {url: '/files/materials/../sample.png'}, {id: crypto.randomUUID()}, {kind: 'video'}, {bytes: 1}, {width: 0}, {sha256: '0'.repeat(64)}]) {
    fs.writeFileSync(record, JSON.stringify({version: 1, material: {...good.material, ...patch}}));
    assert.equal(store.get(material.id), null);
    assert.equal(store.asset(material.id), null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.remove(material.id), false);
  }
  fs.writeFileSync(record, JSON.stringify(good));
  assert.equal(store.remove(material.id), true);
});

test('符号链接不可充当素材文件、注册文件或素材目录', t => {
  const {data, store, folder} = sandbox(t);
  const original = path.join(sources, 'sample.png'), bytes = source('.png');
  const material = store.upload('链接.png', bytes), file = path.join(folder, material.id + '.png');
  fs.unlinkSync(file); fs.symlinkSync(original, file);
  assert.equal(store.get(material.id), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.remove(material.id), false);
  assert(fs.lstatSync(file).isSymbolicLink());
  assert(fs.readFileSync(original).equals(bytes));
  fs.unlinkSync(file); fs.writeFileSync(file, bytes);
  const record = path.join(folder, material.id + '.json'), externalRecord = path.join(data, 'metadata.json');
  fs.renameSync(record, externalRecord); fs.symlinkSync(externalRecord, record);
  assert.equal(store.get(material.id), null);
  assert.equal(store.remove(material.id), false);
  assert(fs.existsSync(externalRecord));
  const linkedData = path.join(data, 'linked'); fs.mkdirSync(linkedData);
  fs.symlinkSync(sources, path.join(linkedData, 'materials'));
  assert.throws(() => createMaterialStore({data: linkedData, probe}), /符号链接/);
});

test('探测/写注册记录失败后仅清理本次上传副本', t => {
  const brokenProbe = sandbox(t, {probe() { throw Error('ffprobe unavailable'); }});
  assert.throws(() => brokenProbe.store.upload('失败.png', source('.png')), error => error.status === 400);
  assert.deepEqual(fs.readdirSync(brokenProbe.folder), []);
  const brokenWrite = sandbox(t, {write(file) { fs.writeFileSync(file, '{'); throw Error('disk unavailable'); }});
  assert.throws(() => brokenWrite.store.upload('失败.png', source('.png')), /disk unavailable/);
  assert.deepEqual(fs.readdirSync(brokenWrite.folder), []);
  const silentlyBrokenWrite = sandbox(t, {write() {}});
  assert.throws(() => silentlyBrokenWrite.store.upload('失败.png', source('.png')), error => error.status === 500);
  assert.deepEqual(fs.readdirSync(silentlyBrokenWrite.folder), []);
});

test('注册文件名冲突时保留先前存在的记录', t => {
  const {store, folder} = sandbox(t), id = crypto.randomUUID();
  const record = path.join(folder, id + '.json'), originalRecord = Buffer.from('{"existing":"keep"}');
  fs.writeFileSync(record, originalRecord);
  t.mock.method(crypto, 'randomUUID', () => id);
  assert.throws(() => store.upload('冲突.png', source('.png')), error => error.status === 500);
  assert(fs.readFileSync(record).equals(originalRecord));
  assert.deepEqual(fs.readdirSync(folder), [id + '.json']);
});
