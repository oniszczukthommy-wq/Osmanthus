import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createCanvasAssistant, CANVAS_ASSISTANT_LIMITS} from '../canvas-assistant.mjs';
import {createCanvasDocument} from '../public/canvas-document.js';

function canvas() {
  return createCanvasDocument({nodes: [
    {id: 'image-a', type: 'image', x: 0, y: 10, width: 320, height: 220, title: '参考图', asset: {id: 'original-material', url: '/files/materials/keep.png'}},
    {id: 'text-b', type: 'text', x: 400, y: 10, width: 300, height: 180, title: '故事卡', content: '保留原内容'},
    {id: 'audio-c', type: 'audio', x: 750, y: 10, width: 340, height: 150, asset: {id: 'original-audio', url: '/files/materials/keep.wav'}},
  ], edges: [{id: 'edge-1', source: 'image-a', target: 'text-b'}]});
}
function request(patch = {}) { return {request_id: crypto.randomUUID(), mode: 'canvas', instruction: '新增一张文字卡', canvas: canvas(), selected_ids: [], ...patch}; }
function response(plan, patch = {}) {
  return new Response(JSON.stringify({id: 'mock-response-id', model: 'deepseek-mock', usage: {prompt_tokens: 30, completion_tokens: 20, total_tokens: 50}, choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(plan)}}], ...patch}), {status: 200, headers: {'Content-Type': 'application/json'}});
}
function sandbox(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-canvas-assistant-test-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const config = {data, key: 'test-secret-never-store', model: 'deepseek-mock', fetchImpl: async () => { throw Error('Every request must use its explicit mock'); }, ...options};
  return {data, folder: path.join(data, 'canvas-assistant'), config, assistant: createCanvasAssistant(config)};
}

test('prompt只返回改写文字；真实API请求结构、持久幂等及内容冲突', async t => {
  let calls = 0, observed;
  const {assistant, folder, config} = sandbox(t, {fetchImpl: async (url, init) => {
    calls++; observed = {url, init, body: JSON.parse(init.body)};
    return response({text: '雨夜站台，一位撑伞的人等候末班车。', message: '已整理构图与氛围。'});
  }});
  const input = request({mode: 'prompt', instruction: '帮我整理雨夜站台提示词', canvas: undefined});
  const first = await assistant.assist(input);
  assert.equal(first.mode, 'prompt'); assert.equal(first.replayed, false);
  assert.equal(first.nextCanvas, undefined); assert.equal(first.operations, undefined);
  assert.match(first.text, /雨夜站台/);
  assert.equal(observed.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(observed.init.headers.Authorization, 'Bearer test-secret-never-store');
  assert(observed.init.signal instanceof AbortSignal);
  assert.equal(observed.body.model, 'deepseek-mock');
  assert.equal(observed.body.response_format.type, 'json_object');
  assert.deepEqual(JSON.parse(observed.body.messages[1].content), {mode: 'prompt', instruction: input.instruction});
  const replayed = await assistant.assist(input);
  assert.equal(replayed.replayed, true); assert.equal(replayed.text, first.text);
  const restarted = createCanvasAssistant(config);
  assert.equal((await restarted.assist(input)).text, first.text);
  assert.equal(calls, 1);
  await assert.rejects(assistant.assist({...input, instruction: '不同内容'}), error => error.status === 409 && error.code === 'ASSISTANT_REQUEST_CONFLICT');
  assert.equal(calls, 1);
  const recordText = fs.readFileSync(path.join(folder, input.request_id + '.json'), 'utf8'), record = JSON.parse(recordText);
  assert(!recordText.includes('test-secret-never-store'));
  assert.equal(record.status, 'complete'); assert.equal(record.provider.id, 'mock-response-id'); assert.equal(record.provider.usage.total_tokens, 50);
  assert.deepEqual(fs.readdirSync(folder), [input.request_id + '.json']);
});

test('画布规划只在副本应用白名单操作，新增媒体无asset；重启复用相同新节点ID', async t => {
  let calls = 0;
  const plan = {message: '新增视频空框和文字卡，调整选中卡片。', operations: [
    {op: 'add', node: {type: 'video', x: 20, y: 280, title: '待上传视频'}},
    {op: 'update', id: 'text-b', patch: {title: '情绪转折', content: '人物向车灯走去'}},
    {op: 'move', id: 'image-a', x: 20, y: 30},
    {op: 'add', node: {type: 'text', x: 400, y: 280, content: '新增说明'}},
  ]};
  const {assistant, config} = sandbox(t, {fetchImpl: async () => { calls++; return response(plan); }});
  const input = request({instruction: '给选中卡片改标题并移动，新增空视频框和文字卡', selected_ids: ['image-a', 'text-b']}), original = JSON.stringify(input);
  const result = await assistant.assist(input);
  assert.equal(JSON.stringify(input), original);
  assert.equal(result.operations.length, 4); assert.equal(result.nextCanvas.nodes.length, 5);
  const added = result.nextCanvas.nodes.filter(node => !input.canvas.nodes.some(old => old.id === node.id));
  assert.equal(added[0].type, 'video'); assert.equal(added[0].asset, null);
  assert.equal(result.nextCanvas.nodes.find(node => node.id === 'text-b').content, '人物向车灯走去');
  assert.deepEqual(result.nextCanvas.nodes.find(node => node.id === 'image-a').asset, input.canvas.nodes[0].asset);
  assert.deepEqual(result.nextCanvas.nodes.find(node => node.id === 'audio-c'), input.canvas.nodes[2]);
  assert.deepEqual(result.nextCanvas.edges, input.canvas.edges);
  assert.match(result.baseCanvasHash, /^[a-f0-9]{64}$/);
  const replayed = await createCanvasAssistant(config).assist({...input, selected_ids: ['text-b', 'image-a']});
  assert.deepEqual(replayed.nextCanvas, result.nextCanvas); assert.equal(calls, 1);
});

test('并发同ID合并；另一实例或换ID不能对pending内容重复计费', async t => {
  let release, calls = 0;
  const {assistant, folder, config} = sandbox(t, {fetchImpl: async () => { calls++; return await new Promise(resolve => { release = resolve; }); }});
  const input = request(), one = assistant.assist(input), two = assistant.assist(input);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, input.request_id + '.json'))).status, 'pending');
  await assert.rejects(assistant.assist({...input, instruction: '不同内容'}), error => error.status === 409);
  await assert.rejects(createCanvasAssistant(config).assist(input), error => error.uncertain && error.retryBlocked);
  await assert.rejects(assistant.assist({...input, request_id: crypto.randomUUID()}), error => error.uncertain && error.status === 409);
  release(response({message: '新增文字卡', operations: [{op: 'add', node: {type: 'text', content: '新卡'}}]}));
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a.nextCanvas, b.nextCanvas);
  assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(calls, 1);
});

test('缺key、输入过大、非法选择与所有音乐字段在发请求前拒绝', async t => {
  let calls = 0;
  const {assistant, folder} = sandbox(t, {fetchImpl: async () => { calls++; throw Error('must not fetch'); }}), input = request();
  const invalid = [
    {...input, request_id: '../unsafe'}, {...input, mode: 'music'}, {...input, instruction: ''},
    {...input, instruction: 'x'.repeat(CANVAS_ASSISTANT_LIMITS.instructionChars + 1)},
    {...input, selected_ids: ['missing']}, {...input, selected_ids: ['image-a', 'image-a']},
    {...input, source: {id: 'sample'}}, {...input, plan: {}}, {...input, musicHandoff: {}}, {...input, project: {}},
    {...input, canvas: {...input.canvas, source: {id: 'sample'}}},
  ];
  const huge = structuredClone(input); huge.canvas.nodes[1].content = 'x'.repeat(CANVAS_ASSISTANT_LIMITS.inputBytes); invalid.push(huge);
  const many = structuredClone(input); many.canvas.nodes = Array.from({length: CANVAS_ASSISTANT_LIMITS.nodes + 1}, (_, i) => ({id: 'node-' + i, type: 'text', x: 0, y: 0, width: 10, height: 10})); many.canvas.edges = []; invalid.push(many);
  for (const value of invalid) await assert.rejects(assistant.assist(value), error => [400, 413].includes(error.status));
  const missingKey = sandbox(t, {key: '', fetchImpl: async () => { calls++; throw Error('must not fetch'); }});
  await assert.rejects(missingKey.assistant.assist(input), error => error.status === 503);
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(folder), []); assert.deepEqual(fs.readdirSync(missingKey.folder), []);
});

test('模型越权、悬空、媒体URL、音乐字段与过量输出全部拒绝并缓存失败', async t => {
  let calls = 0, selectedPlan;
  const {assistant} = sandbox(t, {fetchImpl: async () => { calls++; return response(selectedPlan); }});
  const input = request({selected_ids: ['image-a']});
  const plans = [
    {operations: [{op: 'generate_image', prompt: '猫'}]},
    {operations: [{op: 'add', node: {type: 'image', asset: {url: 'https://example.test/generated.png'}}}]},
    {operations: [{op: 'add', node: {type: 'image', id: 'model-chosen-id'}}]},
    {operations: [{op: 'add', node: {type: 'group'}}]},
    {operations: [{op: 'update', id: 'missing', patch: {title: '悬空'}}]},
    {operations: [{op: 'update', id: 'text-b', patch: {title: '未选中'}}]},
    {operations: [{op: 'update', id: 'image-a', patch: {asset: null}}]},
    {operations: [{op: 'update', id: 'image-a', patch: {x: 42}}]},
    {operations: [{op: 'update', id: 'image-a', patch: {source: {id: 'changed'}}}]},
    {operations: [{op: 'move', id: 'text-b', x: 30, y: 30}]},
    {operations: [{op: 'move', id: 'image-a', x: 100001, y: 30}]},
    {operations: [{op: 'remove', id: 'image-a'}]},
    {operations: [{op: 'add', node: {type: 'text', content: 'x'.repeat(2001)}}]},
    {operations: Array.from({length: 17}, () => ({op: 'add', node: {type: 'text'}}))},
    {operations: [], source: {}}, {operations: [], plan: {}}, {operations: [], musicHandoff: {}},
    {operations: [], nextCanvas: input.canvas},
  ];
  for (const invalid of plans) {
    selectedPlan = {message: '错误规划', ...invalid};
    const attempt = {...input, request_id: crypto.randomUUID()}, before = JSON.stringify(attempt), count = calls;
    await assert.rejects(assistant.assist(attempt), error => error.status === 502 && error.code === 'INVALID_MODEL_RESPONSE' && error.retryBlocked);
    assert.equal(JSON.stringify(attempt), before);
    await assert.rejects(assistant.assist(attempt), error => error.status === 502 && error.replayed);
    assert.equal(calls, count + 1);
  }
});

test('明确删除仅selected；否定/解释请求与隐含分组后代均不授权删除', async t => {
  let plan = {message: '删除所选卡片', operations: [{op: 'remove', id: 'image-a'}]};
  const {assistant} = sandbox(t, {fetchImpl: async () => response(plan)});
  const good = request({instruction: '请删除选中的卡片', selected_ids: ['image-a']}), result = await assistant.assist(good);
  assert.deepEqual(result.nextCanvas.nodes.map(node => node.id), ['text-b', 'audio-c']);
  assert.deepEqual(result.nextCanvas.edges, []); assert.equal(good.canvas.nodes.length, 3);
  for (const instruction of ['不要删除选中的卡片', '请解释如何删除卡片', '给选中卡片改标题', '把这张标题改成删除选中卡片', '删除未选中的卡片']) {
    await assert.rejects(assistant.assist(request({instruction, selected_ids: ['image-a']})), error => error.status === 502);
  }
  await assert.rejects(assistant.assist(request({instruction: '删除选中卡片', selected_ids: ['text-b']})), error => error.status === 502);
  const grouped = canvas(); grouped.nodes.push({id: 'group', type: 'group', x: -10, y: -10, width: 800, height: 300}); grouped.nodes[0].parentId = 'group';
  plan = {message: '删除分组', operations: [{op: 'remove', id: 'group'}]};
  await assert.rejects(assistant.assist(request({instruction: '删除选中分组', canvas: grouped, selected_ids: ['group']})), error => error.status === 502);
  const removed = await assistant.assist(request({instruction: '删除选中分组', canvas: grouped, selected_ids: ['group', 'image-a']}));
  assert.deepEqual(removed.nextCanvas.nodes.map(node => node.id), ['text-b', 'audio-c']);
  plan = {message: '移动分组', operations: [{op: 'move', id: 'group', x: 10, y: 10}]};
  await assert.rejects(assistant.assist(request({instruction: '移动选中分组', canvas: grouped, selected_ids: ['group']})), error => error.status === 502);
});

test('错误模型JSON、截断、过大响应、provider拒绝均不覆盖输入且同ID不再请求', async t => {
  let reply, calls = 0;
  const {assistant} = sandbox(t, {fetchImpl: async () => { calls++; return reply(); }});
  const responses = [
    () => new Response('{broken', {status: 200}),
    () => response({}, {choices: [{finish_reason: 'stop', message: {content: '```json\n{}\n```'}}]}),
    () => response({message: '截断', operations: []}, {choices: [{finish_reason: 'length', message: {content: '{}'}}]}),
    () => response({message: '错误', operations: []}, {choices: []}),
    () => new Response('x'.repeat(CANVAS_ASSISTANT_LIMITS.responseBytes + 1), {status: 200}),
    () => new Response('{}', {status: 429}),
    () => new Response('{}', {status: 500}),
  ];
  for (const make of responses) {
    reply = make; const input = request(), count = calls, original = JSON.stringify(input);
    await assert.rejects(assistant.assist(input), error => [429, 502].includes(error.status) && error.retryBlocked);
    await assert.rejects(assistant.assist(input), error => error.replayed);
    assert.equal(calls, count + 1); assert.equal(JSON.stringify(input), original);
  }
});

test('超时/断线结果持久为uncertain，重启或换ID不能盲目重复付费', async t => {
  let calls = 0;
  const {assistant, config, folder} = sandbox(t, {fetchImpl: async () => { calls++; throw new DOMException('mock timeout', 'TimeoutError'); }}), input = request();
  await assert.rejects(assistant.assist(input), error => error.status === 504 && error.uncertain && error.retryBlocked);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, input.request_id + '.json'))).status, 'uncertain');
  await assert.rejects(createCanvasAssistant(config).assist(input), error => error.status === 504 && error.replayed && error.uncertain);
  await assert.rejects(assistant.assist({...input, request_id: crypto.randomUUID()}), error => error.status === 409 && error.uncertain);
  assert.equal(calls, 1);
  const disconnected = sandbox(t, {fetchImpl: async () => new Response(new ReadableStream({start(controller) { controller.error(Error('mock connection interrupted')); }}))});
  const second = request();
  await assert.rejects(disconnected.assistant.assist(second), error => error.uncertain && error.status === 502);
  await assert.rejects(disconnected.assistant.assist({...second, request_id: crypto.randomUUID()}), error => error.uncertain && error.status === 409);
});

test('付费结果无法原子落盘时保留pending阻止重试，不返回未持久结果', async t => {
  let calls = 0;
  const {assistant, folder} = sandbox(t, {fetchImpl: async () => { calls++; return response({message: '空操作', operations: []}); }}), input = request();
  t.mock.method(fs, 'renameSync', () => { throw Error('mock disk rename failed'); });
  await assert.rejects(assistant.assist(input), error => error.uncertain && error.retryBlocked && error.status === 409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, input.request_id + '.json'))).status, 'pending');
  await assert.rejects(assistant.assist({...input, request_id: crypto.randomUUID()}), error => error.uncertain && error.status === 409);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(folder), [input.request_id + '.json']);
});

test('缓存结果重新执行约束校验；篡改、符号链接与路径不能引起重复请求或越权写入', async t => {
  let calls = 0;
  const {assistant, folder, data, config} = sandbox(t, {fetchImpl: async () => { calls++; return response({message: '新增卡片', operations: [{op: 'add', node: {type: 'text', content: '有效结果'}}]}); }}), input = request();
  await assistant.assist(input);
  const file = path.join(folder, input.request_id + '.json'), bytes = fs.readFileSync(file), saved = JSON.parse(bytes);
  saved.plan = {message: '越权缓存', operations: [{op: 'update', id: 'audio-c', patch: {title: '不应改动'}}]};
  fs.writeFileSync(file, JSON.stringify(saved));
  await assert.rejects(createCanvasAssistant(config).assist(input), error => error.uncertain && error.retryBlocked);
  assert.equal(calls, 1);
  fs.writeFileSync(file, bytes);
  const external = path.join(data, 'external.json'); fs.renameSync(file, external); fs.symlinkSync(external, file);
  await assert.rejects(assistant.assist(input), error => error.uncertain && error.retryBlocked);
  assert(fs.readFileSync(external).equals(bytes)); assert(fs.lstatSync(file).isSymbolicLink()); assert.equal(calls, 1);
  const linked = path.join(data, 'linked'); fs.mkdirSync(linked); fs.symlinkSync(folder, path.join(linked, 'canvas-assistant'));
  assert.throws(() => createCanvasAssistant({...config, data: linked}), /符号链接/);
});
