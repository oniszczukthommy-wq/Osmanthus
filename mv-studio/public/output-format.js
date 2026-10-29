// Shared by browser previews and server output checks. This module has no DOM
// dependency until a non-16:9 frame actually needs its temporary canvas.
export const DEFAULT_OUTPUT_RATIO = '16:9';
export const OUTPUT_SHORT_EDGE = 720;
export const SOURCE_FRAME = Object.freeze({width: 1280, height: 720});

const formats = Object.freeze(Object.fromEntries([
  ['16:9', 1280, 720],
  ['4:3', 960, 720],
  ['3:2', 1080, 720],
  ['1:1', 720, 720],
  ['3:4', 720, 960],
  ['2:3', 720, 1080],
  ['9:16', 720, 1280],
].map(([ratio, width, height]) => [ratio, Object.freeze({ratio, width, height})])));

export const OUTPUT_RATIOS = Object.freeze(Object.keys(formats));

/** Only the seven supported ratios can determine an encoded frame size. */
export function getOutputFormat(ratio = DEFAULT_OUTPUT_RATIO) {
  if (typeof ratio !== 'string' || !Object.hasOwn(formats, ratio)) {
    throw new RangeError('画面比例无效，请选择 16:9、4:3、3:2、1:1、3:4、2:3 或 9:16');
  }
  return formats[ratio];
}

/** Check an encoder/probe result without trusting submitted dimensions. */
export function validateOutputDimensions(ratio, width, height) {
  const format = getOutputFormat(ratio);
  if (width !== format.width || height !== format.height) {
    throw new RangeError(`成片尺寸应为 ${format.width}×${format.height}`);
  }
  return format;
}

function validateSize(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)) {
    throw new RangeError('画面尺寸必须为 1 至 8192 的整数');
  }
}

function validateFit(fit) {
  if (fit !== 'contain' && fit !== 'crop') {
    throw new RangeError('画面适配方式只能是 contain 或 crop');
  }
}

/**
 * Pure, centered geometry for drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh).
 * contain preserves the complete source with letterboxing; crop fills the target
 * by cutting the source edges. Neither policy rearranges characters or lyrics.
 */
export function getFrameGeometry(sourceWidth, sourceHeight, width, height, fit = 'contain') {
  validateSize(sourceWidth, sourceHeight);
  validateSize(width, height);
  validateFit(fit);

  const scale = fit === 'contain'
    ? Math.min(width / sourceWidth, height / sourceHeight)
    : Math.max(width / sourceWidth, height / sourceHeight);

  if (fit === 'contain') {
    const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
    return {
      fit,
      scale,
      source: {x: 0, y: 0, width: sourceWidth, height: sourceHeight},
      destination: {
        x: (width - drawnWidth) / 2,
        y: (height - drawnHeight) / 2,
        width: drawnWidth,
        height: drawnHeight,
      },
    };
  }

  const croppedWidth = width / scale, croppedHeight = height / scale;
  return {
    fit,
    scale,
    source: {
      x: (sourceWidth - croppedWidth) / 2,
      y: (sourceHeight - croppedHeight) / 2,
      width: croppedWidth,
      height: croppedHeight,
    },
    destination: {x: 0, y: 0, width, height},
  };
}

function createBrowserCanvas(width, height) {
  let canvas;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    canvas = document.createElement('canvas');
  } else if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    throw new Error('当前环境没有画布，请提供 createCanvas');
  }
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function validateCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('需要可绘制的 canvas');
  }
  validateSize(canvas.width, canvas.height);
}

/**
 * Adapt the existing drawFrame(canvas, project, t, options) without changing it.
 *
 * const drawFrame = createOutputFrameDrawer(drawSourceFrame);
 * const format = getOutputFormat(project.studio?.ratio);
 * frameCanvas.width = format.width; frameCanvas.height = format.height;
 * drawFrame(frameCanvas, project, t, {subtitles: true});
 *
 * The caller owns destination sizing, including smaller previews/thumbnails.
 * Its aspect must match the selected ratio (within one rounding pixel). The
 * default 16:9 path calls the original drawer directly, preserving its pixel,
 * print, subtitle and camera behavior. Other ratios composite a reusable 1280×720
 * source frame; contain is the default so its lyrics and people remain visible.
 */
export function createOutputFrameDrawer(drawSourceFrame, {createCanvas = createBrowserCanvas} = {}) {
  if (typeof drawSourceFrame !== 'function' || typeof createCanvas !== 'function') {
    throw new TypeError('drawSourceFrame 和 createCanvas 必须是函数');
  }
  let sourceCanvas;

  return function drawFormattedFrame(canvas, project, t = 0, options = {}) {
    const {ratio: overrideRatio, fit = 'contain', ...frameOptions} = options;
    const ratio = overrideRatio === undefined ? project?.studio?.ratio : overrideRatio;
    const format = getOutputFormat(ratio);
    validateFit(fit);
    validateCanvas(canvas);
    // Permit the at-most-one-pixel rounding error of a small preview, but never
    // silently stretch a destination left at the previous output ratio.
    if (Math.abs(canvas.width * format.height - canvas.height * format.width)
      > Math.max(format.width, format.height)) {
      throw new RangeError('画布尺寸与所选比例不符，请先按 getOutputFormat 调整尺寸');
    }
    if (format.ratio === DEFAULT_OUTPUT_RATIO) {
      return drawSourceFrame(canvas, project, t, frameOptions);
    }

    if (!sourceCanvas) sourceCanvas = createCanvas(SOURCE_FRAME.width, SOURCE_FRAME.height);
    validateCanvas(sourceCanvas);
    if (sourceCanvas === canvas) throw new TypeError('临时画布必须与输出画布不同');
    if (sourceCanvas.width !== SOURCE_FRAME.width) sourceCanvas.width = SOURCE_FRAME.width;
    if (sourceCanvas.height !== SOURCE_FRAME.height) sourceCanvas.height = SOURCE_FRAME.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法取得 2D 画布');

    const result = drawSourceFrame(sourceCanvas, project, t, frameOptions);
    const geometry = getFrameGeometry(SOURCE_FRAME.width, SOURCE_FRAME.height,
      canvas.width, canvas.height, fit);
    const s = geometry.source, d = geometry.destination;
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#000000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = project?.plan?.style !== 'pixel';
      context.drawImage(sourceCanvas, s.x, s.y, s.width, s.height,
        d.x, d.y, d.width, d.height);
    } finally {
      context.restore();
    }
    return result;
  };
}
