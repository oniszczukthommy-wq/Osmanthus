import {mediaTools} from '../runtime-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {makeProject, resizePlan} from '../public/domain.js';
import {createCanvasDocument, addNode} from '../public/canvas-document.js';
import {OUTPUT_RATIOS, getOutputFormat} from '../public/output-format.js';

const ff = mediaTools().ffmpeg;
const encode = args => execFileSync(ff, ['-y', '-v', 'error', ...args],
  {timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = server => new Promise(resolve => server.close(resolve));

test('材料、画布目录、音乐关联和输出尺寸使用独立临时DATA完成真实API集成', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-server-canvas-'));
  const fixture = path.join(temp, 'fixtures'); fs.mkdirSync(fixture);
  const png = path.join(fixture, 'image.png'), wav = path.join(fixture, 'audio.wav');
  const mp3 = path.join(fixture, 'song.mp3'), video = path.join(fixture, 'video.mp4');
  encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=64x48', '-frames:v', '1', png]);
  encode(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4', wav]);
  encode(['-i', wav, '-c:a', 'libmp3lame', mp3]);
  encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=64x48:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const song = fs.readFileSync(mp3), handoffId = crypto.randomUUID(), songProjectId = crypto.randomUUID();
  let musicCalls = 0;
  const music = http.createServer((req, res) => {
    musicCalls++;
    if (req.url === `/api/mv/handoffs/${handoffId}/audio.mp3`) {
      res.writeHead(200, {'Content-Type': 'audio/mpeg', 'Content-Length': song.length});
      return res.end(song);
    }
    if (req.url !== `/api/mv/handoffs/${handoffId}`) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({id: handoffId, project_id: songProjectId, title: '歌曲交接测试',
      revision: 7, fingerprint: 'a'.repeat(64), source_kind: 'current_mix',
      audio_sha256: sha(song), audio_bytes: song.length,
      audio_url: `/api/mv/handoffs/${handoffId}/audio.mp3`, lyrics: '原歌曲歌词',
      timed_lyrics: [{start: 0, end: 2, text: '原歌曲歌词'}]}));
  });
  await listen(music);
  const savedEnv = Object.fromEntries(['MV_DATA_DIR', 'MV_DISABLE_MODELS', 'MUSIC_BASE_URL']
    .map(key => [key, process.env[key]]));
  process.env.MV_DATA_DIR = path.join(temp, 'data');
  process.env.MV_DISABLE_MODELS = '1';
  process.env.MUSIC_BASE_URL = `http://127.0.0.1:${music.address().port}`;
  const data = process.env.MV_DATA_DIR, nativeFetch = globalThis.fetch;
  // A test failure is preferable to an accidental request to any model service.
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'only local test endpoints may be contacted');
    return nativeFetch(input, options);
  };
  const {createServer} = await import('../server.mjs');
  const server = createServer(); await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, payload, method = 'POST') => {
    const response = await fetch(base + route, {method, headers: {'Content-Type': 'application/json'},
      body: payload === undefined ? undefined : JSON.stringify(payload)});
    return {status: response.status, data: await response.json()};
  };
  const upload = async (name, file) => {
    const response = await fetch(base + '/api/materials', {method: 'POST',
      headers: {'x-filename': encodeURIComponent(name)}, body: fs.readFileSync(file)});
    assert.equal(response.status, 201);
    return (await response.json()).material;
  };
  const readProject = id => request(`/api/canvas-projects/${id}`, undefined, 'GET');
  let image, audio, clip, project, selectedMusic;
  try {
    await t.test('模型关闭；上传验证、材料列表和GET/HEAD/Range文件流保持源校验', async () => {
      const cap = await request('/api/capabilities', undefined, 'GET');
      assert.equal(cap.data.deepseek, false);
      assert.equal((await request('/api/canvas-assist', {mode: 'prompt', instruction: 'test'})).status, 503);
      image = await upload('角色参考.png', png);
      audio = await upload('配乐.wav', wav);
      clip = await upload('动作参考.mp4', video);
      assert.deepEqual([image.kind, audio.kind, clip.kind], ['image', 'audio', 'video']);
      assert.equal((await request('/api/materials', undefined, 'GET')).data.materials.length, 3);
      assert.deepEqual((await request(`/api/materials/${image.id}`, undefined, 'GET')).data.material, image);
      const head = await fetch(base + image.url, {method: 'HEAD'});
      assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/png');
      assert.equal(Number(head.headers.get('content-length')), image.bytes);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const range = await fetch(base + clip.url, {headers: {Range: 'bytes=0-31'}});
      assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4');
      assert.equal(range.headers.get('content-range'), `bytes 0-31/${clip.bytes}`);
      assert.equal((await range.arrayBuffer()).byteLength, 32);
      assert.equal((await fetch(base + image.url, {headers: {Range: `bytes=${image.bytes}-`}})).status, 416);
      assert.equal((await fetch(base + image.url.replace('.png', '.jpg'))).status, 404);
      const bad = await fetch(base + '/api/materials', {method: 'POST', headers: {'x-filename': 'fake.png'}, body: fs.readFileSync(wav)});
      assert.equal(bad.status, 400);
      const blocked = await fetch(base + '/api/materials', {method: 'POST', headers: {'x-filename': 'image.png', Origin: 'https://example.invalid'}, body: fs.readFileSync(png)});
      assert.equal(blocked.status, 403);
      const orphan = crypto.randomUUID() + '.png';
      fs.copyFileSync(png, path.join(data, 'materials', orphan));
      assert.equal((await fetch(base + '/files/materials/' + orphan)).status, 404);
      assert.equal((await request('/api/materials', undefined, 'GET')).data.materials.length, 3);
    });

    await t.test('旧draft保存仍可用；创建、保存、重命名、打开、复制和归档恢复目录', async () => {
      const legacy = await request('/api/project', makeProject(), 'PUT');
      assert.equal(legacy.status, 200); assert.equal(legacy.data.saved, true);
      assert.notEqual(legacy.data.project.id, 'draft');
      const again = await request('/api/project', makeProject(), 'PUT');
      assert.equal(again.data.project.id, legacy.data.project.id);
      project = resizePlan(makeProject(), 3, 0);
      project.id = crypto.randomUUID(); project.title = '完整材料画布';
      project.studio = {ratio: '4:3', freeCanvas: true, canvas: addNode(createCanvasDocument(),
        {id: 'reference', type: 'image', asset: {id: image.id, url: image.url, name: image.name}})};
      let response = await request('/api/canvas-projects', {project});
      assert.equal(response.status, 201); assert.equal(response.data.project.id, project.id);
      assert.equal((await request('/api/project', project)).status, 200, 'pagehide beacon uses validated POST save');
      assert.equal(response.data.record.project.studio.canvas.nodes.length, 1);
      assert.equal((await request('/api/canvas-projects', undefined, 'GET')).data.projects.length, 2);
      response = await request(`/api/canvas-projects/${project.id}/rename`, {title: '  改名画布  '});
      assert.equal(response.status, 200); project = response.data.project;
      assert.equal(project.title, '改名画布');
      assert.equal((await request('/api/project', undefined, 'GET')).data.project.title, project.title);
      const copy = await request(`/api/canvas-projects/${project.id}/duplicate`, {title: '独立副本'});
      assert.equal(copy.status, 201); assert.notEqual(copy.data.project.id, project.id);
      assert.deepEqual(copy.data.project.studio.canvas, project.studio.canvas);
      assert.equal((await request('/api/project', undefined, 'GET')).data.project.id, project.id);
      assert.equal((await request(`/api/canvas-projects/${copy.data.project.id}/open`, {})).data.project.title, '独立副本');
      assert.equal((await request(`/api/canvas-projects/${project.id}/open`, {})).status, 200);
      assert.equal((await request(`/api/canvas-projects/${copy.data.project.id}/archive`, {})).status, 200);
      assert.equal((await request('/api/canvas-projects?archived=1', undefined, 'GET')).data.projects[0].id, copy.data.project.id);
      assert.equal((await readProject(copy.data.project.id)).status, 409);
      assert.equal((await request(`/api/canvas-projects/${copy.data.project.id}?archived=1`, undefined, 'GET')).status, 200);
      assert.equal((await request(`/api/canvas-projects/${copy.data.project.id}/open`, {})).status, 409);
      assert.equal((await request('/api/project', copy.data.project, 'PUT')).status, 409);
      assert.equal((await request(`/api/canvas-projects/${copy.data.project.id}/restore`, {})).status, 200);
      assert.equal((await readProject(copy.data.project.id)).status, 200);
      const bad = structuredClone(project); bad.studio.ratio = '99:1';
      assert.equal((await request('/api/project', bad, 'PUT')).status, 400);
      bad.studio.ratio = '4:3'; bad.studio.canvas.nodes[0].width = -1;
      assert.equal((await request('/api/project', bad, 'PUT')).status, 400);
      const badSource = structuredClone(project); badSource.source.url = 'https://example.invalid/audio.mp3';
      assert.equal((await request('/api/project', badSource, 'PUT')).status, 400);
      const badOutput = structuredClone(project); badOutput.generated = {url: 'https://example.invalid/other.mp4'};
      assert.equal((await request('/api/canvas-projects/import', {project: badOutput})).status, 400);
      const badDrawing = structuredClone(project); badDrawing.studio.canvasDrawings = [{points: [[null, 1]], color: '#ffffff', width: 2}];
      assert.equal((await request('/api/project', badDrawing, 'PUT')).status, 400);
      assert.equal((await readProject(project.id)).data.project.title, project.title);
      const imported = await request('/api/canvas-projects/import', {project});
      assert.equal(imported.status, 201); assert.notEqual(imported.data.project.id, project.id);
      assert.equal(imported.data.project.musicHandoff, undefined);
      assert.deepEqual(imported.data.project.studio.canvas, project.studio.canvas);
    });

    await t.test('工程、归档和版本引用阻止删除；未引用副本可删除；音频选择创建独立MV源', async () => {
      assert.equal((await request(`/api/materials/${image.id}`, undefined, 'DELETE')).status, 409);
      assert.equal((await request('/api/versions', {project, label: '保留材料引用'})).status, 201);
      assert.equal((await request(`/api/materials/${clip.id}`, undefined, 'DELETE')).status, 200);
      assert.equal((await fetch(base + clip.url)).status, 404);
      assert.equal((await request(`/api/materials/${clip.id}`, undefined, 'DELETE')).status, 404);
      assert.equal((await request(`/api/materials/${image.id}/use-audio`, {project})).status, 400);
      assert.equal((await request('/api/render', {project})).status, 400, 'free canvas must choose music first');
      const response = await request(`/api/materials/${audio.id}/use-audio`, {project});
      assert.equal(response.status, 200); selectedMusic = response.data.project;
      assert.notEqual(selectedMusic.id, project.id);
      assert.equal(selectedMusic.studio.freeCanvas, false);
      assert.deepEqual(selectedMusic.studio.canvas, project.studio.canvas);
      assert.equal(selectedMusic.duration, 3); assert.equal(selectedMusic.start, 0);
      assert.deepEqual(selectedMusic.lyrics, []); assert.equal(selectedMusic.manualLyrics, '');
      assert.equal(selectedMusic.generated, null); assert.equal(selectedMusic.musicHandoff, undefined);
      assert.equal((await fetch(base + selectedMusic.source.url)).status, 200);
      assert.equal((await request(`/api/materials/${audio.id}`, undefined, 'DELETE')).status, 200);
      assert.equal((await fetch(base + selectedMusic.source.url)).status, 200, 'selected audio is an independent verified upload copy');
      assert.equal((await request('/api/project', selectedMusic, 'PUT')).status, 200);
      assert.equal((await request(`/api/materials/${image.id}`, undefined, 'DELETE')).status, 409);
      // These references exist only in a historical version or archived project,
      // so an active-project-only deletion guard would fail these checks.
      const historical = await upload('历史独有.png', png);
      const snapshot = structuredClone(selectedMusic); snapshot.id = crypto.randomUUID();
      snapshot.studio.canvas = addNode(createCanvasDocument(), {type: 'image',
        asset: {url: `/files/materials/${historical.id}`}});
      assert.equal((await request('/api/versions', {project: snapshot, label: '仅历史引用'})).status, 201);
      assert.equal((await request(`/api/materials/${historical.id}`, undefined, 'DELETE')).status, 409);
      const archived = await upload('归档独有.png', png);
      const archivedProject = structuredClone(selectedMusic); archivedProject.id = crypto.randomUUID();
      archivedProject.studio.canvas = addNode(createCanvasDocument(), {type: 'image', asset: {id: archived.id, url: archived.url}});
      assert.equal((await request('/api/canvas-projects', {project: archivedProject})).status, 201);
      await request(`/api/canvas-projects/${archivedProject.id}/archive`, {});
      await request(`/api/canvas-projects/${selectedMusic.id}/open`, {});
      assert.equal((await request(`/api/materials/${archived.id}`, undefined, 'DELETE')).status, 409);
    });

    await t.test('七种比例任务存储真实尺寸；竖屏MP4通过ffprobe后才登记成片', async () => {
      for (const ratio of OUTPUT_RATIOS) {
        const value = structuredClone(selectedMusic); value.studio.ratio = ratio;
        const response = await request('/api/render', {project: value});
        assert.equal(response.status, 201);
        assert.deepEqual(response.data.dimensions, getOutputFormat(ratio));
        const job = json(path.join(data, 'jobs', response.data.id, 'job.json'));
        assert.deepEqual(job.dimensions, getOutputFormat(ratio));
        assert.equal((await request(`/api/jobs/${job.id}/cancel`, {})).status, 200);
      }
      selectedMusic.studio.ratio = '9:16';
      assert.equal((await request('/api/project', selectedMusic, 'PUT')).status, 200);
      const frame = path.join(fixture, 'portrait.jpg');
      encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=720x1280', '-frames:v', '1', frame]);
      const bytes = fs.readFileSync(frame), start = await request('/api/render', {project: selectedMusic});
      assert.equal(start.status, 201); const job = start.data;
      for (let index = 0; index < job.total; index++) {
        const response = await fetch(base + `/api/jobs/${job.id}/frame?index=${index}`, {method: 'POST', body: bytes});
        assert.equal(response.status, 200); await response.arrayBuffer();
      }
      assert.equal((await request(`/api/jobs/${job.id}/finish`, {})).status, 202);
      let finished;
      for (let attempt = 0; attempt < 100; attempt++) {
        finished = (await request(`/api/jobs/${job.id}`, undefined, 'GET')).data;
        if (['ready', 'failed'].includes(finished.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(finished.status, 'ready', finished.error);
      assert.deepEqual(finished.dimensions, getOutputFormat('9:16'));
      assert.deepEqual(finished.generated.dimensions, finished.dimensions);
      assert.match(finished.generated.sha256, /^[a-f0-9]{64}$/);
      const info = json(path.join(data, 'jobs', job.id, 'ffprobe.json'));
      const picture = info.streams.find(stream => stream.codec_type === 'video');
      assert.deepEqual([picture.width, picture.height], [720, 1280]);
      assert.equal(Number(picture.nb_frames), 72); assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
      assert.equal((await readProject(selectedMusic.id)).data.project.generated.url, finished.url);
      assert.equal(json(path.join(data, 'project.json')).generated.url, finished.url);
      assert.equal((await fetch(base + finished.url, {method: 'HEAD'})).status, 200);
      // Pixel data with the old 16:9 size must not be accepted as a 9:16 result.
      const wrongFrame = path.join(fixture, 'landscape.jpg');
      encode(['-f', 'lavfi', '-i', 'color=c=0x263e4f:s=1280x720', '-frames:v', '1', wrongFrame]);
      const wrongBytes = fs.readFileSync(wrongFrame), wrong = (await request('/api/render', {project: selectedMusic})).data;
      for (let index = 0; index < wrong.total; index++) {
        const response = await fetch(base + `/api/jobs/${wrong.id}/frame?index=${index}`, {method: 'POST', body: wrongBytes});
        assert.equal(response.status, 200); await response.arrayBuffer();
      }
      await request(`/api/jobs/${wrong.id}/finish`, {});
      let rejected;
      for (let attempt = 0; attempt < 100; attempt++) {
        rejected = (await request(`/api/jobs/${wrong.id}`, undefined, 'GET')).data;
        if (['ready', 'failed'].includes(rejected.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(rejected.status, 'failed'); assert.equal(rejected.url, undefined);
      assert.equal((await readProject(selectedMusic.id)).data.project.generated.url, finished.url);
    });

    await t.test('歌曲导入登记、恢复编辑、改名和复制保持handoff隔离与音频hash约束', async () => {
      let response = await request('/api/music-import', {handoff_id: handoffId});
      assert.equal(response.status, 200); assert.equal(response.data.reused, false);
      const imported = response.data.project;
      assert.equal(musicCalls, 2); assert.equal(imported.musicHandoff.project_id, songProjectId);
      assert.equal((await readProject(imported.id)).status, 200);
      imported.title = '歌曲画布编辑'; imported.studio.ratio = '1:1';
      assert.equal((await request('/api/project', imported, 'PUT')).status, 200);
      const cache = path.join(data, 'music-projects', handoffId + '.json');
      assert.equal(json(cache).title, imported.title);
      await request(`/api/canvas-projects/${selectedMusic.id}/open`, {});
      response = await request(`/api/canvas-projects/${imported.id}/rename`, {title: '保留的关联新名'});
      assert.equal(response.status, 200); assert.equal(json(cache).title, '保留的关联新名');
      assert.equal((await request('/api/project', undefined, 'GET')).data.project.id, selectedMusic.id);
      response = await request('/api/music-import', {handoff_id: handoffId});
      assert.equal(response.data.reused, true); assert.equal(musicCalls, 2);
      assert.equal(response.data.project.title, '保留的关联新名');
      const copy = await request(`/api/canvas-projects/${imported.id}/duplicate`, {});
      assert.equal(copy.status, 201); assert.equal(copy.data.project.musicHandoff, undefined);
      assert.equal(copy.data.project.studio.originMusicSnapshot.mv_project_id, imported.id);
      await request(`/api/canvas-projects/${copy.data.project.id}/open`, {});
      assert.equal(json(cache).id, imported.id);
      const forged = structuredClone(imported); forged.musicHandoff.audio_sha256 = '0'.repeat(64);
      assert.equal((await request('/api/project', forged, 'PUT')).status, 400);
      assert.equal(json(cache).musicHandoff.audio_sha256, sha(song));
      const detached = await request('/api/canvas-projects/import', {project: imported});
      assert.equal(detached.status, 201); assert.notEqual(detached.data.project.id, imported.id);
      assert.equal(detached.data.project.musicHandoff, undefined);
      assert.equal(json(cache).id, imported.id);
    });
  } finally {
    await stop(server); await stop(music); globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, {recursive: true, force: true});
  }
});
