import test from 'node:test';
import assert from 'node:assert/strict';
import {transformedImageSize, rotateImageTransform, fitImageCrop, clampImageCrop, moveImageCrop, resizeImageCrop, imageEditFilename} from '../public/image-frame-tools.js';

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function inside(rect, width, height) {
  for (const value of Object.values(rect)) assert(Number.isFinite(value));
  assert(rect.width > 0 && rect.height > 0);
  assert(rect.x >= -1e-8 && rect.y >= -1e-8 && rect.x + rect.width <= width + 1e-8 && rect.y + rect.height <= height + 1e-8);
}

test('横图按90度旋转换宽高；镜像后旋转按可见坐标轴组合且不修改原值', () => {
  assert.deepEqual(transformedImageSize(640, 480), {width: 640, height: 480});
  assert.deepEqual(transformedImageSize(640, 480, 90), {width: 480, height: 640});
  assert.deepEqual(transformedImageSize(640, 480, -90), {width: 480, height: 640});
  assert.deepEqual(transformedImageSize(640, 480, 450), {width: 480, height: 640});
  const original = Object.freeze({rotation: 0, flipX: true, flipY: false});
  assert.deepEqual(rotateImageTransform(original), {rotation: 90, flipX: false, flipY: true});
  let state = original;
  for (let i = 0; i < 4; i++) state = rotateImageTransform(state);
  assert.deepEqual(state, original);
  assert.deepEqual(rotateImageTransform(original, -1), {rotation: 270, flipX: false, flipY: true});
  assert.throws(() => transformedImageSize(640, 480, 45));
  assert.throws(() => transformedImageSize(0, 480));
  assert.throws(() => rotateImageTransform({...original, flipX: 'true'}));
});

test('自由、方形、横竖屏与4:3均以最大内接区域居中，不裁出画外', () => {
  assert.deepEqual(fitImageCrop(640, 480), {x: 0, y: 0, width: 640, height: 480});
  assert.deepEqual(fitImageCrop(640, 480, '1:1'), {x: 80, y: 0, width: 480, height: 480});
  assert.deepEqual(fitImageCrop(640, 480, '16:9'), {x: 0, y: 60, width: 640, height: 360});
  assert.deepEqual(fitImageCrop(640, 480, '9:16'), {x: 185, y: 0, width: 270, height: 480});
  assert.deepEqual(fitImageCrop(640, 480, '4:3'), {x: 0, y: 0, width: 640, height: 480});
  const tiny = fitImageCrop(1, 1, '16:9'); inside(tiny, 1, 1); near(tiny.width / tiny.height, 16 / 9);
  assert.throws(() => fitImageCrop(640, 480, '2:1'));
});

test('数值输入夹在图片内；极大有限输入不会溢出NaN，固定比例按所编辑轴调整', () => {
  assert.deepEqual(clampImageCrop({x: -50, y: 999, width: 1e308, height: 1e308}, 100, 80), {x: 0, y: 0, width: 100, height: 80});
  const wide = clampImageCrop({x: 99, y: 99, width: 1e308, height: 1e308}, 100, 100, '16:9');
  inside(wide, 100, 100); near(wide.width, 100); near(wide.height, 56.25);
  const height = clampImageCrop({x: 0, y: 0, width: 20, height: 90}, 200, 100, '16:9', 'height');
  near(height.width, 160); near(height.height, 90);
  for (const patch of [{x: NaN}, {width: 0}, {height: -1}, {y: Infinity}]) assert.throws(() => clampImageCrop({x: 0, y: 0, width: 20, height: 20, ...patch}, 100, 100));
});

test('拖动选框到图片边缘保持尺寸，并保留调用者原区域', () => {
  const rect = Object.freeze({x: 20, y: 30, width: 40, height: 20});
  assert.deepEqual(moveImageCrop(rect, 100, -100, 100, 80), {x: 60, y: 0, width: 40, height: 20});
  assert.deepEqual(moveImageCrop(rect, -100, 100, 100, 80), {x: 0, y: 60, width: 40, height: 20});
  assert.deepEqual(rect, {x: 20, y: 30, width: 40, height: 20});
  assert.throws(() => moveImageCrop(rect, Infinity, 0, 100, 80));
});

test('自由裁剪各角越界与穿越对角时钳制，固定比例拉伸维持对边锚点', () => {
  const rect = {x: 20, y: 30, width: 60, height: 40};
  assert.deepEqual(resizeImageCrop(rect, 'nw', -999, -999, 100, 100), {x: 0, y: 0, width: 80, height: 70});
  assert.deepEqual(resizeImageCrop(rect, 'se', 999, 999, 100, 100), {x: 20, y: 30, width: 80, height: 70});
  assert.deepEqual(resizeImageCrop(rect, 'nw', 999, 999, 100, 100), {x: 79, y: 69, width: 1, height: 1});
  const widescreen = {x: 10, y: 10, width: 80, height: 45};
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const delta of [-1e308, 1e308]) {
      const resized = resizeImageCrop(widescreen, handle, delta, delta, 200, 120, '16:9');
      inside(resized, 200, 120); near(resized.width / resized.height, 16 / 9);
    }
  }
  const resized = resizeImageCrop(widescreen, 'se', 1000, 1000, 200, 120, '16:9');
  near(resized.x, 10); near(resized.y, 10);
  const vertical = resizeImageCrop(widescreen, 'n', 0, -20, 200, 120, '16:9');
  near(vertical.y + vertical.height, 55); near(vertical.x + vertical.width / 2, 50);
  assert.throws(() => resizeImageCrop(rect, 'other', 0, 0, 100, 100));
});

test('副本PNG文件名不沿用原文件扩展或路径，长中文名仍符合上传限制', () => {
  assert.equal(imageEditFilename('original.jpg'), 'original-裁剪副本.png');
  assert.equal(imageEditFilename('photo.webp', 'transform'), 'photo-变换副本.png');
  const sanitized = imageEditFilename('../folder\\photo\0.png');
  assert(!/[\\/\x00-\x1f]/.test(sanitized)); assert(sanitized.endsWith('-裁剪副本.png'));
  assert(Buffer.byteLength(imageEditFilename('图'.repeat(300) + '.jpg')) <= 255);
});
