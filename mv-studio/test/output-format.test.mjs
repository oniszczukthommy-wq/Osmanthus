import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OUTPUT_RATIO, OUTPUT_SHORT_EDGE, OUTPUT_RATIOS, SOURCE_FRAME,
  getOutputFormat, validateOutputDimensions, getFrameGeometry, createOutputFrameDrawer,
} from '../public/output-format.js';

const expected = [
  ['16:9', 1280, 720], ['4:3', 960, 720], ['3:2', 1080, 720],
  ['1:1', 720, 720], ['3:4', 720, 960], ['2:3', 720, 1080], ['9:16', 720, 1280],
];
const close = (actual, wanted) => assert.ok(Math.abs(actual - wanted) < 1e-9,
  `${actual} should equal ${wanted}`);

test('seven menu ratios yield exact even output sizes with a 720-pixel short edge', () => {
  assert.deepEqual(OUTPUT_RATIOS, expected.map(([ratio]) => ratio));
  for (const [ratio, width, height] of expected) {
    const actual = getOutputFormat(ratio);
    assert.deepEqual(actual, {ratio, width, height});
    assert.equal(Math.min(width, height), OUTPUT_SHORT_EDGE);
    assert.equal(width % 2, 0);
    assert.equal(height % 2, 0);
    const [rw, rh] = ratio.split(':').map(Number);
    assert.equal(width * rh, height * rw);
    assert.equal(validateOutputDimensions(ratio, width, height), actual);
  }
  assert.deepEqual(getOutputFormat(), {ratio: DEFAULT_OUTPUT_RATIO, ...SOURCE_FRAME});
});

test('ratio selection rejects arbitrary sizes, malformed strings and coercible objects', () => {
  for (const invalid of ['', 'auto', '16:10', ' 16:9', '16:9 ', '16/9', '__proto__',
    'constructor', '999999:1', null, 16 / 9, [], {}, {toString: () => '16:9'}]) {
    assert.throws(() => getOutputFormat(invalid), RangeError);
  }
});

test('output checks reject a different, odd, transposed or string-encoded size', () => {
  for (const [ratio, width, height] of expected) {
    assert.throws(() => validateOutputDimensions(ratio, width + 1, height), RangeError);
    assert.throws(() => validateOutputDimensions(ratio, width, height - 2), RangeError);
    assert.throws(() => validateOutputDimensions(ratio, String(width), height), RangeError);
    if (width !== height) {
      assert.throws(() => validateOutputDimensions(ratio, height, width), RangeError);
    }
  }
  assert.throws(() => validateOutputDimensions('9:16', 1280, 720), RangeError);
});

test('16:9 geometry exactly preserves the existing full frame', () => {
  for (const fit of ['contain', 'crop']) {
    assert.deepEqual(getFrameGeometry(1280, 720, 1280, 720, fit), {
      fit, scale: 1,
      source: {x: 0, y: 0, width: 1280, height: 720},
      destination: {x: 0, y: 0, width: 1280, height: 720},
    });
  }
});

test('portrait contain preserves the complete source and centers horizontal content', () => {
  assert.deepEqual(getFrameGeometry(1280, 720, 720, 1280), {
    fit: 'contain', scale: 0.5625,
    source: {x: 0, y: 0, width: 1280, height: 720},
    destination: {x: 0, y: 437.5, width: 720, height: 405},
  });
});

test('portrait crop fills the frame with an explicitly centered source crop', () => {
  const geometry = getFrameGeometry(1280, 720, 720, 1280, 'crop');
  assert.deepEqual(geometry.source, {x: 437.5, y: 0, width: 405, height: 720});
  assert.deepEqual(geometry.destination, {x: 0, y: 0, width: 720, height: 1280});
  close(geometry.scale, 16 / 9);
});

test('4:3 and square policies have predictable borders or source cropping', () => {
  assert.deepEqual(getFrameGeometry(1280, 720, 960, 720).destination,
    {x: 0, y: 90, width: 960, height: 540});
  assert.deepEqual(getFrameGeometry(1280, 720, 960, 720, 'crop').source,
    {x: 160, y: 0, width: 960, height: 720});
  assert.deepEqual(getFrameGeometry(1280, 720, 720, 720).destination,
    {x: 0, y: 157.5, width: 720, height: 405});
  assert.deepEqual(getFrameGeometry(1280, 720, 720, 720, 'crop').source,
    {x: 280, y: 0, width: 720, height: 720});
});

test('all seven formats preserve uniform scale and centered containment/cropping', () => {
  for (const [, width, height] of expected) for (const fit of ['contain', 'crop']) {
    const {source: s, destination: d, scale} = getFrameGeometry(1280, 720, width, height, fit);
    close(d.width / s.width, scale);
    close(d.height / s.height, scale);
    close(d.x * 2 + d.width, width);
    close(d.y * 2 + d.height, height);
    close(s.x * 2 + s.width, 1280);
    close(s.y * 2 + s.height, 720);
    assert.ok(s.x >= -1e-9 && s.y >= -1e-9);
    assert.ok(s.x + s.width <= 1280 + 1e-9 && s.y + s.height <= 720 + 1e-9);
    assert.ok(d.x >= -1e-9 && d.y >= -1e-9);
    assert.ok(d.x + d.width <= width + 1e-9 && d.y + d.height <= height + 1e-9);
    if (fit === 'contain') assert.deepEqual(s, {x: 0, y: 0, width: 1280, height: 720});
    else assert.deepEqual(d, {x: 0, y: 0, width, height});
  }
});

test('geometry also handles portrait sources and small preview resolutions', () => {
  assert.deepEqual(getFrameGeometry(720, 1280, 1280, 720).destination,
    {x: 437.5, y: 0, width: 405, height: 720});
  assert.deepEqual(getFrameGeometry(1280, 720, 180, 320).destination,
    {x: 0, y: 109.375, width: 180, height: 101.25});
  assert.deepEqual(getFrameGeometry(1280, 720, 320, 180).destination,
    {x: 0, y: 0, width: 320, height: 180});
});

test('geometry rejects invalid dimensions and unsupported stretching policies', () => {
  for (const invalid of [0, -1, NaN, Infinity, 8193, 720.5, '720', null, undefined]) {
    for (let index = 0; index < 4; index++) {
      const args = [1280, 720, 720, 1280];
      args[index] = invalid;
      assert.throws(() => getFrameGeometry(...args), RangeError);
    }
  }
  for (const fit of ['stretch', 'cover', '', null, 1]) {
    assert.throws(() => getFrameGeometry(1280, 720, 720, 1280, fit), RangeError);
  }
});

// Adapter protocol checks use plain objects; no browser, canvas package or pixel
// renderer is started. They guard the geometry passed to drawImage and the
// original drawFrame return contract used by app.js.
function fakeCanvas(width, height) {
  const calls = [], context = Object.fromEntries(
    ['save', 'restore', 'setTransform', 'fillRect', 'drawImage']
      .map(name => [name, (...args) => calls.push([name, ...args])]),
  );
  return {width, height, calls, context, getContext: () => context};
}

test('default 16:9 adapter delegates unchanged and does not allocate a source canvas', () => {
  const canvas = fakeCanvas(320, 180), project = {plan: {style: 'pixel'}};
  const result = {shot: 2, action: 'wait', u: 0.5};
  const drawer = createOutputFrameDrawer((...args) => {
    assert.deepEqual(args, [canvas, project, 1.5, {subtitles: false, shot: 2}]);
    return result;
  }, {createCanvas: () => assert.fail('default output must use the original path')});
  assert.equal(drawer(canvas, project, 1.5, {subtitles: false, shot: 2}), result);
  assert.deepEqual(canvas.calls, []);
});

test('adapter resolves project ratio, composites contain and reuses its source canvas', () => {
  const source = fakeCanvas(1280, 720), target = fakeCanvas(720, 1280);
  const project = {studio: {ratio: '9:16'}, plan: {style: 'pixel'}};
  let allocations = 0, frames = 0;
  const drawer = createOutputFrameDrawer((canvas, p, t, options) => {
    assert.equal(canvas, source);
    assert.equal(p, project);
    assert.equal(t, frames++);
    assert.deepEqual(options, {subtitles: true});
    return {shot: frames};
  }, {createCanvas: (w, h) => {
    allocations++;
    assert.deepEqual([w, h], [1280, 720]);
    return source;
  }});
  assert.deepEqual(drawer(target, project, 0, {subtitles: true}), {shot: 1});
  assert.equal(target.context.imageSmoothingEnabled, false);
  assert.equal(target.context.fillStyle, '#000000');
  assert.deepEqual(target.calls.find(([name]) => name === 'drawImage'),
    ['drawImage', source, 0, 0, 1280, 720, 0, 437.5, 720, 405]);
  drawer(target, project, 1, {subtitles: true});
  assert.equal(allocations, 1);
  assert.equal(target.calls.filter(([name]) => name === 'save').length, 2);
  assert.equal(target.calls.filter(([name]) => name === 'restore').length, 2);
});

test('explicit ratio wins over project ratio and crop remains an explicit policy', () => {
  const source = fakeCanvas(1280, 720), target = fakeCanvas(720, 720);
  const drawer = createOutputFrameDrawer(() => ({shot: 1}), {createCanvas: () => source});
  drawer(target, {studio: {ratio: '9:16'}}, 0, {ratio: '1:1', fit: 'crop'});
  assert.deepEqual(target.calls.find(([name]) => name === 'drawImage'),
    ['drawImage', source, 280, 0, 720, 720, 0, 0, 720, 720]);
});

test('adapter rejects stale destination ratios and invalid input before drawing', () => {
  const drawer = createOutputFrameDrawer(() => assert.fail('invalid input must not render'),
    {createCanvas: () => assert.fail('invalid input must not allocate')});
  assert.throws(() => drawer(fakeCanvas(1280, 720), {studio: {ratio: '9:16'}}), RangeError);
  assert.throws(() => drawer(fakeCanvas(720, 720), {}, 0, {ratio: 'free'}), RangeError);
  assert.throws(() => drawer(fakeCanvas(1280, 720), {}, 0, {fit: 'stretch'}), RangeError);
  assert.throws(() => drawer(null, {}), TypeError);
  assert.throws(() => createOutputFrameDrawer(null), TypeError);
});
