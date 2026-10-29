import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_SCHEMA, NODE_TYPES, createCanvasDocument, validateCanvasDocument,
  addNode, updateNode, moveNode, moveNodes, resizeNode, removeNodes,
  connectNodes, disconnectEdges, disconnectNodes, copySelection, pasteSelection,
  duplicateNodes, groupNodes, ungroupNodes,
} from '../public/canvas-document.js';

const factory = (prefix = 'new') => { let count = 0; return () => `${prefix}-${++count}`; };
const node = (doc, id) => doc.nodes.find(item => item.id === id);
const pair = () => {
  let doc = createCanvasDocument();
  doc = addNode(doc, { id: 'a', type: 'text', x: 10, y: 20, width: 100, height: 80, content: '手写分镜，不要变成预设' });
  doc = addNode(doc, { id: 'b', type: 'image', x: 210, y: 120, width: 200, height: 100, asset: { id: 'asset-1', url: '/mv/files/image.png', name: '角色图', mimeType: 'image/png' } });
  return connectNodes(doc, 'a', 'b', { id: 'ab', label: '参考' });
};
const deepFreeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child); return value; };

test('five material types serialize; input and restored document are defensively copied', () => {
  let doc = createCanvasDocument();
  assert.equal(doc.schema, CANVAS_SCHEMA);
  assert.deepEqual(doc.nodes, []);
  const idFactory = factory();
  for (const type of NODE_TYPES) doc = addNode(doc, { type, content: type === 'text' ? '一个镜头想法' : '' }, { idFactory });
  assert.equal(doc.nodes.length, 5);
  assert.equal(doc.edges.length, 0);
  assert.equal(validateCanvasDocument(doc), true);
  assert.deepEqual(createCanvasDocument(JSON.parse(JSON.stringify(doc))), doc);
  const restored = createCanvasDocument(doc);
  restored.nodes[0].title = '只修改副本';
  assert.equal(doc.nodes[0].title, '');
  const asset = { id: 'upload-1', duration: 0 };
  const added = addNode(doc, { id: 'media', type: 'audio', asset });
  asset.id = 'outside';
  assert.equal(node(added, 'media').asset.id, 'upload-1');
});

test('immutable node content, movement and resize never modify source/plan or the original state', () => {
  const doc = deepFreeze(pair());
  let edited = updateNode(doc, 'a', { title: '幕一', content: '窗边的桂花' });
  edited = moveNode(edited, 'a', -30, 40);
  edited = resizeNode(edited, 'a', 400, 220);
  assert.equal(node(doc, 'a').content, '手写分镜，不要变成预设');
  assert.deepEqual([node(edited, 'a').x, node(edited, 'a').y, node(edited, 'a').width, node(edited, 'a').height], [-30, 40, 400, 220]);
  assert.equal(node(edited, 'a').title, '幕一');
  assert.deepEqual(node(edited, 'b'), node(doc, 'b'));
  assert.equal(edited.nodes.length, 2);
  assert.equal('source' in edited || 'plan' in edited || 'musicHandoff' in edited, false);
});

test('validation rejects unknown types, invalid coordinates/sizes, IDs and material references', () => {
  const doc = pair(), original = JSON.stringify(doc);
  for (const patch of [{ x: NaN }, { y: Infinity }, { x: '10' }, { width: 0 }, { height: -1 }, { content: {} }, { asset: {} }, { asset: { url: '/a', duration: Infinity } }]) {
    assert.throws(() => updateNode(doc, 'a', patch), /画布数据无效/);
  }
  assert.throws(() => addNode(doc, { type: 'pipeline' }), /类型/);
  assert.throws(() => addNode(doc, { id: 'a', type: 'text' }), /ID/);
  assert.throws(() => addNode(doc, { type: 'text' }, { idFactory: () => 'ab' }), /ID/);
  assert.throws(() => addNode(doc, { type: 'text', content: () => 'not serializable' }), /必须是文字/);
  assert.throws(() => addNode(doc, { type: 'image', asset: { id: 'asset', url: () => '/image.png' } }), /必须是文字/);
  assert.throws(() => updateNode(doc, 'a', { title: () => 'not serializable' }), /必须是文字/);
  assert.throws(() => updateNode(doc, 'a', { id: 'different' }), /字段/);
  assert.throws(() => moveNodes(doc, ['missing'], 1, 1), /找不到/);
  assert.throws(() => createCanvasDocument({ schema: 'future' }), /版本/);
  assert.equal(JSON.stringify(doc), original);
});

test('add rejects non-finite coordinates instead of JSON coercion; saved data also validates', () => {
  const doc = createCanvasDocument();
  for (const value of [NaN, Infinity, -Infinity, '4', null]) assert.throws(() => addNode(doc, { type: 'text', x: value }), /有限数字/);
  assert.throws(() => validateCanvasDocument({ ...pair(), nodes: [{ ...pair().nodes[0], parentId: 'missing' }] }), /父节点/);
  assert.throws(() => createCanvasDocument({ nodes: [], edges: [{ id: 'e', source: 'a', target: 'b' }] }), /端点/);
});

test('connect/disconnect checks endpoints, direction and duplicate edges; deleting nodes prunes edges', () => {
  const doc = pair();
  assert.throws(() => connectNodes(doc, 'a', 'missing'), /端点/);
  assert.throws(() => connectNodes(doc, 'a', 'a'), /自身/);
  assert.throws(() => connectNodes(doc, 'a', 'b'), /重复/);
  const reverse = connectNodes(doc, 'b', 'a', { id: 'ba' });
  assert.equal(reverse.edges.length, 2);
  assert.equal(disconnectEdges(reverse, ['ab']).edges[0].id, 'ba');
  assert.equal(disconnectNodes(reverse, 'b', 'a').edges[0].id, 'ab');
  const deleted = removeNodes(reverse, ['b']);
  assert.deepEqual(deleted.nodes.map(item => item.id), ['a']);
  assert.deepEqual(deleted.edges, []);
  assert.equal(doc.edges.length, 1);
});

test('copy/paste creates new IDs and remaps internal edges, excluding external endpoints', () => {
  let doc = addNode(pair(), { id: 'c', type: 'video', asset: { url: 'blob:local-video', duration: 5 } });
  doc = connectNodes(doc, 'b', 'c', { id: 'bc' });
  const clipboard = copySelection(doc, ['a', 'b']);
  assert.deepEqual(clipboard.edges.map(item => item.id), ['ab']);
  const idFactory = factory('paste');
  const pasted = pasteSelection(doc, clipboard, { idFactory, offsetX: 50, offsetY: -20 });
  assert.equal(pasted.nodes.length, 5);
  assert.deepEqual(pasted.edges.at(-1), { id: 'paste-3', source: 'paste-1', target: 'paste-2', label: '参考' });
  assert.deepEqual([node(pasted, 'paste-1').x, node(pasted, 'paste-1').y], [60, 0]);
  assert.deepEqual(node(pasted, 'paste-2').asset, node(doc, 'b').asset);
  const twice = pasteSelection(pasted, clipboard, { idFactory });
  assert.equal(new Set(twice.nodes.map(item => item.id)).size, twice.nodes.length);
  assert.equal(node(twice, 'paste-4').content, node(doc, 'a').content);
  assert.equal(doc.nodes.length, 3);
  assert.equal(clipboard.nodes[0].x, 10);
});

test('paste rejects broken clipboard graphs and ID collisions atomically', () => {
  const doc = pair(), clipboard = copySelection(doc, ['a', 'b']);
  assert.throws(() => pasteSelection(doc, clipboard, { idFactory: () => 'a' }), /ID/);
  const broken = structuredClone(clipboard);
  broken.edges[0].target = 'outside';
  assert.throws(() => pasteSelection(doc, broken), /端点/);
  assert.throws(() => pasteSelection(doc, clipboard, { offsetX: NaN }), /有限数字/);
  assert.deepEqual(doc, pair());
});

test('group frame bounds, absolute child positions, nested movement and non-scaling resize', () => {
  const original = pair();
  let doc = groupNodes(original, ['a', 'b'], { idFactory: () => 'g', title: '场景一', padding: 10 });
  assert.deepEqual([node(doc, 'g').x, node(doc, 'g').y, node(doc, 'g').width, node(doc, 'g').height], [0, 10, 420, 220]);
  assert.equal(node(doc, 'a').parentId, 'g');
  assert.equal(node(doc, 'a').x, 10);
  doc = groupNodes(doc, ['a'], { idFactory: () => 'inner', padding: 5 });
  assert.equal(node(doc, 'inner').parentId, 'g');
  doc = moveNodes(doc, ['g', 'a', 'inner'], 20, 30);
  assert.deepEqual([node(doc, 'a').x, node(doc, 'a').y], [30, 50]);
  assert.deepEqual([node(doc, 'inner').x, node(doc, 'inner').y], [25, 45]);
  const moved = moveNode(doc, 'g', 100, 100);
  assert.deepEqual([node(moved, 'a').x, node(moved, 'a').y], [110, 110]);
  const resized = resizeNode(moved, 'g', 900, 800);
  assert.deepEqual(node(resized, 'a'), node(moved, 'a'));
  assert.equal(node(original, 'a').parentId, null);
});

test('group clipboard includes descendants and remaps parent IDs, retaining only internal edges', () => {
  let doc = groupNodes(pair(), ['a', 'b'], { idFactory: () => 'g' });
  const clipboard = copySelection(doc, ['g', 'a']);
  assert.equal(clipboard.nodes.length, 3);
  const copied = duplicateNodes(doc, ['g'], { idFactory: factory('dup'), offsetX: 100, offsetY: 100 });
  assert.equal(node(copied, 'dup-1').parentId, 'dup-3');
  assert.equal(node(copied, 'dup-2').parentId, 'dup-3');
  assert.deepEqual(copied.edges.at(-1), { id: 'dup-4', source: 'dup-1', target: 'dup-2', label: '参考' });
  const childOnly = copySelection(doc, ['a']);
  assert.equal(childOnly.nodes[0].parentId, null);
  assert.equal(childOnly.edges.length, 0);
  assert.equal(validateCanvasDocument(copied), true);
});

test('ungroup preserves contents/world coordinates and child edges; deleting a group removes descendants', () => {
  let doc = groupNodes(pair(), ['a', 'b'], { idFactory: () => 'outer' });
  doc = groupNodes(doc, ['a'], { idFactory: () => 'inner' });
  doc = connectNodes(doc, 'outer', 'inner', { id: 'groups' });
  const one = ungroupNodes(doc, ['inner']);
  assert.equal(node(one, 'a').parentId, 'outer');
  assert.deepEqual(one.edges.map(item => item.id), ['ab']);
  const all = ungroupNodes(doc, ['outer', 'inner']);
  assert.equal(all.nodes.length, 2);
  assert(all.nodes.every(item => item.parentId === null));
  assert.equal(node(all, 'a').x, 10);
  assert.deepEqual(all.edges.map(item => item.id), ['ab']);
  const deleted = removeNodes(doc, ['outer']);
  assert.deepEqual(deleted.nodes, []);
  assert.deepEqual(deleted.edges, []);
  assert.throws(() => ungroupNodes(doc, ['a']), /只能解散/);
});

test('parent validation rejects dangling, non-group and cyclic parents without mutating state', () => {
  const doc = groupNodes(pair(), ['a'], { idFactory: () => 'g' });
  assert.throws(() => updateNode(doc, 'g', { parentId: 'g' }), /循环/);
  assert.throws(() => updateNode(doc, 'g', { parentId: 'b' }), /父节点/);
  assert.throws(() => updateNode(doc, 'a', { parentId: 'missing' }), /父节点/);
  const nested = groupNodes(doc, ['a'], { idFactory: () => 'inner' });
  assert.throws(() => updateNode(nested, 'g', { parentId: 'inner' }), /循环/);
  assert.equal(node(nested, 'g').parentId, null);
  assert.equal(validateCanvasDocument(nested), true);
});

test('empty selections are safe and text materials never produce pipeline cards', () => {
  const doc = addNode(createCanvasDocument(), { id: 'note', type: 'text', content: '只是一张文字卡' });
  assert.deepEqual(removeNodes(doc, []), doc);
  assert.deepEqual(moveNodes(doc, [], 2, 3), doc);
  assert.deepEqual(pasteSelection(doc, copySelection(doc, [])), doc);
  assert.throws(() => groupNodes(doc, []), /先选择/);
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].type, 'text');
  assert.equal(doc.edges.length, 0);
});
