import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCanvasDrawings, normalizeCanvasDrawings, CANVAS_DRAWING_LIMITS} from '../public/canvas-preferences.js';

const stroke = (patch = {}) => ({color: '#E7a0D2', width: 3, points: [[0, 1], [12.5, -24]], ...patch});

test('绘画数据校验不变异；canonical副本没有共享笔画和点引用', () => {
  const input = [stroke()];
  for (const point of input[0].points) Object.freeze(point);
  Object.freeze(input[0].points); Object.freeze(input[0]); Object.freeze(input);
  assert.equal(validateCanvasDrawings(input), true);
  const normalized = normalizeCanvasDrawings(input);
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input); assert.notEqual(normalized[0], input[0]); assert.notEqual(normalized[0].points, input[0].points); assert.notEqual(normalized[0].points[0], input[0].points[0]);
  normalized[0].points[0][0] = 99; normalized[0].color = '#000000';
  assert.equal(input[0].points[0][0], 0); assert.equal(input[0].color, '#E7a0D2');
  assert.deepEqual(normalizeCanvasDrawings([]), []);
});

test('拒绝导致renderInk崩溃的null、字符串、缺失点和非数值点', () => {
  const invalid = [null, undefined, {}, '[]', [null], ['stroke'], [stroke({points: null})], [stroke({points: '0,0'})], [stroke({points: []})], [stroke({points: [null]})], [stroke({points: ['0,0']})], [stroke({points: [[0]]})], [stroke({points: [[0, 1, 2]]})], [stroke({points: [Array(2)]})], [stroke({points: [['0', 1]]})], [stroke({points: [[NaN, 1]]})], [stroke({points: [[0, Infinity]]})], [stroke({points: [[0, -Infinity]]})]];
  for (const value of invalid) {
    assert.throws(() => validateCanvasDrawings(value), /画布绘画数据无效/);
    assert.throws(() => normalizeCanvasDrawings(value), /画布绘画数据无效/);
  }
});

test('SVG注入、额外字段、非法颜色和宽度均拒绝', () => {
  const invalid = [
    stroke({points: [['0"/><image href="x" onerror="alert(1)"/>', 1]]}),
    stroke({color: '#fff" onload="alert(1)'}), stroke({color: '#fff'}), stroke({color: 'red'}),
    stroke({width: '3'}), stroke({width: NaN}), stroke({width: Infinity}), stroke({width: 0.99}), stroke({width: 20.01}),
    stroke({d: '<foreignObject/>'}), stroke({onload: 'alert(1)'}), stroke({asset: {url: 'https://example.test/'}}),
    JSON.parse('{"color":"#123456","width":3,"points":[[0,0]],"__proto__":{"polluted":true}}'),
  ];
  for (const value of invalid) assert.throws(() => validateCanvasDrawings([value]), /画布绘画数据无效/);
  assert.equal({}.polluted, undefined);
});

test('严格接受坐标与宽度边界，拒绝笔画/每笔/总点数超限', () => {
  assert.equal(validateCanvasDrawings([stroke({width: 1, points: [[-1000000, 1000000]]}), stroke({width: 20, points: [[0, 0]]})]), true);
  assert.throws(() => validateCanvasDrawings([stroke({points: [[1000000.01, 0]]})]));
  assert.throws(() => validateCanvasDrawings([stroke({points: [[0, -1000000.01]]})]));
  assert.equal(validateCanvasDrawings(Array.from({length: 200}, () => stroke({points: [[0, 0]]}))), true);
  assert.throws(() => validateCanvasDrawings(Array.from({length: 201}, () => stroke({points: [[0, 0]]}))));
  const full = () => stroke({points: Array(CANVAS_DRAWING_LIMITS.pointsPerStroke).fill([0, 0])});
  assert.equal(validateCanvasDrawings(Array.from({length: 5}, full)), true);
  assert.throws(() => validateCanvasDrawings([stroke({points: Array(20001).fill([0, 0])})]));
  assert.throws(() => validateCanvasDrawings([...Array.from({length: 5}, full), stroke({points: [[0, 0]]})]));
});
