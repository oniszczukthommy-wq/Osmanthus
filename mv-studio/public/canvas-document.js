/**
 * Serializable, immutable material canvas stored in project.studio.canvas.
 * Coordinates are absolute canvas coordinates, including grouped children.
 * Moving a group moves its descendants once; resizing changes only its frame.
 * Selection, viewport state and audio/MV pipeline state belong to the caller.
 */
export const CANVAS_SCHEMA = 'osmanthus-canvas-v1';
export const CLIPBOARD_SCHEMA = 'osmanthus-canvas-clipboard-v1';
export const NODE_TYPES = Object.freeze(['image', 'video', 'audio', 'text', 'group']);

const DEFAULT_SIZE = {
  image: [320, 220], video: [360, 240], audio: [340, 150],
  text: [300, 180], group: [400, 300],
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`画布数据无效：${message}`); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const finite = (value, label) => { if (!Number.isFinite(value)) fail(`${label}必须是有限数字`); };
const allowedKeys = (value, keys, label) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}不支持字段 ${key}`);
};

function validateAsset(asset) {
  if (asset === null || asset === undefined) return;
  if (!object(asset)) fail('素材引用必须是对象');
  allowedKeys(asset, ['id', 'url', 'name', 'mimeType', 'duration', 'thumbnailUrl'], '素材引用');
  if (!nonempty(asset.id) && !nonempty(asset.url)) fail('素材引用需要 id 或 url');
  for (const key of ['id', 'url', 'name', 'mimeType', 'thumbnailUrl']) {
    if (asset[key] !== undefined && typeof asset[key] !== 'string') fail(`素材 ${key} 必须是文字`);
  }
  if (own(asset, 'duration')) {
    finite(asset.duration, '素材时长');
    if (asset.duration < 0) fail('素材时长不能为负数');
  }
}

/** Throws on invalid data; successful validation returns true without mutation. */
export function validateCanvasDocument(doc) {
  if (!object(doc) || doc.schema !== CANVAS_SCHEMA || doc.version !== 1) fail('版本不受支持');
  allowedKeys(doc, ['schema', 'version', 'nodes', 'edges'], '文档');
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) fail('nodes 和 edges 必须是数组');
  const ids = new Set(), nodes = new Map(), pairs = new Set();
  for (const node of doc.nodes) {
    if (!object(node)) fail('节点必须是对象');
    allowedKeys(node, ['id', 'type', 'x', 'y', 'width', 'height', 'title', 'content', 'asset', 'parentId'], '节点');
    if (!nonempty(node.id) || ids.has(node.id)) fail('节点 ID 为空或重复');
    if (!NODE_TYPES.includes(node.type)) fail(`不支持的节点类型 ${node.type}`);
    for (const key of ['x', 'y', 'width', 'height']) finite(node[key], `节点 ${key}`);
    if (node.width <= 0 || node.height <= 0) fail('节点尺寸必须大于零');
    for (const key of ['title', 'content']) {
      if (node[key] !== undefined && typeof node[key] !== 'string') fail(`节点 ${key} 必须是文字`);
    }
    if (node.parentId != null && !nonempty(node.parentId)) fail('分组 ID 必须是非空文字');
    validateAsset(node.asset);
    ids.add(node.id); nodes.set(node.id, node);
  }
  for (const node of doc.nodes) {
    const visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent != null) {
      if (visited.has(parent)) fail('分组不能形成循环');
      visited.add(parent);
      const container = nodes.get(parent);
      if (!container || container.type !== 'group') fail('父节点必须是现有分组');
      parent = container.parentId;
    }
  }
  for (const edge of doc.edges) {
    if (!object(edge)) fail('连线必须是对象');
    allowedKeys(edge, ['id', 'source', 'target', 'label'], '连线');
    if (!nonempty(edge.id) || ids.has(edge.id)) fail('连线 ID 为空或重复');
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) fail('连线端点不存在');
    if (edge.source === edge.target) fail('不能连接节点自身');
    if (edge.label !== undefined && typeof edge.label !== 'string') fail('连线标签必须是文字');
    const pair = JSON.stringify([edge.source, edge.target]);
    if (pairs.has(pair)) fail('相同方向的连线重复');
    ids.add(edge.id); pairs.add(pair);
  }
  return true;
}

/** Empty document, or a defensive validated copy of a saved document. */
export function createCanvasDocument(seed = {}) {
  if (!object(seed)) fail('文档必须是对象');
  allowedKeys(seed, ['schema', 'version', 'nodes', 'edges'], '文档');
  const doc = { schema: CANVAS_SCHEMA, version: 1, nodes: [], edges: [], ...seed };
  validateCanvasDocument(doc);
  return clone(doc);
}

function mutate(doc, operation) {
  validateCanvasDocument(doc);
  const next = clone(doc);
  operation(next);
  validateCanvasDocument(next);
  return next;
}

function getNode(doc, id) {
  const node = doc.nodes.find(item => item.id === id);
  if (!node) fail(`找不到节点 ${id}`);
  return node;
}

function selection(doc, ids) {
  if (!Array.isArray(ids) || ids.some(id => !nonempty(id))) fail('选择项必须是节点 ID 数组');
  const selected = new Set(ids);
  for (const id of selected) getNode(doc, id);
  return selected;
}

function withDescendants(doc, ids) {
  const included = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of doc.nodes) if (node.parentId != null && included.has(node.parentId) && !included.has(node.id)) {
      included.add(node.id); changed = true;
    }
  }
  return included;
}

function freshId(doc, options = {}, kind = 'node') {
  const id = options.idFactory
    ? options.idFactory(kind)
    : globalThis.crypto?.randomUUID?.() || `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  if (!nonempty(id) || doc.nodes.some(node => node.id === id) || doc.edges.some(edge => edge.id === id)) fail('新 ID 为空或已存在');
  return id;
}

/** input: {type,x?,y?,width?,height?,title?,content?,asset?,parentId?,id?}. */
export function addNode(doc, input, options = {}) {
  if (!object(input) || !NODE_TYPES.includes(input.type)) fail('不支持的节点类型');
  allowedKeys(input, ['id', 'type', 'x', 'y', 'width', 'height', 'title', 'content', 'asset', 'parentId'], '节点');
  for (const key of ['x', 'y', 'width', 'height']) if (input[key] !== undefined) finite(input[key], `节点 ${key}`);
  for (const key of ['title', 'content']) if (input[key] !== undefined && typeof input[key] !== 'string') fail(`节点 ${key} 必须是文字`);
  if (input.parentId != null && !nonempty(input.parentId)) fail('分组 ID 必须是非空文字');
  validateAsset(input.asset);
  return mutate(doc, next => {
    const [width, height] = DEFAULT_SIZE[input.type];
    next.nodes.push({
      id: freshId(next, input.id === undefined ? options : { idFactory: () => input.id }),
      type: input.type, x: 0, y: 0, width, height,
      title: '', content: '', asset: null, parentId: null,
      ...clone(input),
    });
  });
}

/** Node ID/type stay stable. Updating a group's x/y translates its descendants. */
export function updateNode(doc, id, patch) {
  if (!object(patch)) fail('节点修改必须是对象');
  allowedKeys(patch, ['x', 'y', 'width', 'height', 'title', 'content', 'asset', 'parentId'], '节点修改');
  // Validate before cloning: JSON cloning must not silently turn NaN into null.
  for (const key of ['x', 'y', 'width', 'height']) if (own(patch, key)) finite(patch[key], `节点 ${key}`);
  for (const key of ['title', 'content']) if (patch[key] !== undefined && typeof patch[key] !== 'string') fail(`节点 ${key} 必须是文字`);
  if (patch.parentId != null && !nonempty(patch.parentId)) fail('分组 ID 必须是非空文字');
  if (own(patch, 'asset')) validateAsset(patch.asset);
  return mutate(doc, next => {
    const node = getNode(next, id), oldX = node.x, oldY = node.y;
    Object.assign(node, clone(patch));
    if (node.type === 'group') {
      const moved = withDescendants(next, [id]);
      for (const child of next.nodes) if (child.id !== id && moved.has(child.id)) {
        child.x += node.x - oldX; child.y += node.y - oldY;
      }
    }
  });
}

export function moveNode(doc, id, x, y) { return updateNode(doc, id, { x, y }); }
export function resizeNode(doc, id, width, height) { return updateNode(doc, id, { width, height }); }

/** Relative movement. Selecting a group and its child never moves the child twice. */
export function moveNodes(doc, ids, dx, dy) {
  finite(dx, '横向位移'); finite(dy, '纵向位移');
  return mutate(doc, next => {
    const moved = withDescendants(next, selection(next, ids));
    for (const node of next.nodes) if (moved.has(node.id)) { node.x += dx; node.y += dy; }
  });
}

/** Deleting a group deletes its descendants; use ungroupNodes to retain them. */
export function removeNodes(doc, ids) {
  return mutate(doc, next => {
    const removed = withDescendants(next, selection(next, ids));
    next.nodes = next.nodes.filter(node => !removed.has(node.id));
    next.edges = next.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  });
}

export function connectNodes(doc, source, target, options = {}) {
  return mutate(doc, next => {
    next.edges.push({
      id: freshId(next, options.id === undefined ? options : { idFactory: () => options.id }, 'edge'),
      source, target, label: options.label ?? '',
    });
  });
}

export function disconnectEdges(doc, ids) {
  if (!Array.isArray(ids) || ids.some(id => !nonempty(id))) fail('连线选择必须是 ID 数组');
  return mutate(doc, next => {
    const removed = new Set(ids);
    for (const id of removed) if (!next.edges.some(edge => edge.id === id)) fail(`找不到连线 ${id}`);
    next.edges = next.edges.filter(edge => !removed.has(edge.id));
  });
}

export function disconnectNodes(doc, source, target) {
  return mutate(doc, next => {
    getNode(next, source); getNode(next, target);
    next.edges = next.edges.filter(edge => edge.source !== source || edge.target !== target);
  });
}

/** Clipboard includes group descendants and only edges internal to the selection. */
export function copySelection(doc, ids) {
  validateCanvasDocument(doc);
  const included = withDescendants(doc, selection(doc, ids));
  return {
    schema: CLIPBOARD_SCHEMA, version: 1,
    nodes: doc.nodes.filter(node => included.has(node.id)).map(node => ({ ...clone(node), parentId: included.has(node.parentId) ? node.parentId : null })),
    edges: doc.edges.filter(edge => included.has(edge.source) && included.has(edge.target)).map(clone),
  };
}

/** Repeated pastes always make new IDs. Absolute coordinates are offset once. */
export function pasteSelection(doc, clipboard, options = {}) {
  if (!object(clipboard) || clipboard.schema !== CLIPBOARD_SCHEMA || clipboard.version !== 1) fail('剪贴板格式不受支持');
  allowedKeys(clipboard, ['schema', 'version', 'nodes', 'edges'], '剪贴板');
  validateCanvasDocument({ ...clipboard, schema: CANVAS_SCHEMA });
  const offsetX = options.offsetX ?? 32, offsetY = options.offsetY ?? 32;
  finite(offsetX, '粘贴横向偏移'); finite(offsetY, '粘贴纵向偏移');
  return mutate(doc, next => {
    const mapping = new Map(), pasted = [];
    for (const node of clipboard.nodes) {
      const id = freshId(next, options);
      mapping.set(node.id, id);
      const copied = { ...clone(node), id, x: node.x + offsetX, y: node.y + offsetY, parentId: null };
      pasted.push([copied, node.parentId]); next.nodes.push(copied);
    }
    for (const [node, parent] of pasted) node.parentId = parent == null ? null : mapping.get(parent);
    for (const edge of clipboard.edges) next.edges.push({
      ...clone(edge), id: freshId(next, options, 'edge'),
      source: mapping.get(edge.source), target: mapping.get(edge.target),
    });
  });
}

export function duplicateNodes(doc, ids, options = {}) {
  return pasteSelection(doc, copySelection(doc, ids), options);
}

/** Wraps selection roots; a shared existing parent is retained. */
export function groupNodes(doc, ids, options = {}) {
  const padding = options.padding ?? 24;
  finite(padding, '分组边距');
  if (padding < 0) fail('分组边距不能为负数');
  if (options.title !== undefined && typeof options.title !== 'string') fail('分组名称必须是文字');
  return mutate(doc, next => {
    const selected = selection(next, ids);
    if (!selected.size) fail('请先选择需要分组的节点');
    const roots = next.nodes.filter(node => {
      if (!selected.has(node.id)) return false;
      let parent = node.parentId;
      while (parent != null) {
        if (selected.has(parent)) return false;
        parent = getNode(next, parent).parentId;
      }
      return true;
    });
    const included = withDescendants(next, roots.map(node => node.id));
    const members = next.nodes.filter(node => included.has(node.id));
    const x = Math.min(...members.map(node => node.x)) - padding;
    const y = Math.min(...members.map(node => node.y)) - padding;
    const width = Math.max(...members.map(node => node.x + node.width)) - x + padding;
    const height = Math.max(...members.map(node => node.y + node.height)) - y + padding;
    const parentId = roots.every(node => (node.parentId ?? null) === (roots[0].parentId ?? null)) ? roots[0].parentId ?? null : null;
    const group = { id: freshId(next, options), type: 'group', x, y, width, height, title: options.title ?? '分组', content: '', asset: null, parentId };
    for (const node of roots) node.parentId = group.id;
    next.nodes.push(group);
  });
}

/** Removes frames, reparenting children to the nearest retained ancestor. */
export function ungroupNodes(doc, ids) {
  return mutate(doc, next => {
    const removed = selection(next, ids);
    for (const id of removed) if (getNode(next, id).type !== 'group') fail('只能解散分组节点');
    for (const node of next.nodes) if (!removed.has(node.id)) {
      let parent = node.parentId;
      while (removed.has(parent)) parent = getNode(next, parent).parentId;
      node.parentId = parent ?? null;
    }
    next.nodes = next.nodes.filter(node => !removed.has(node.id));
    next.edges = next.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  });
}
