export const CANVAS_DRAWING_LIMITS = Object.freeze({strokes: 200, pointsPerStroke: 20000, totalPoints: 100000, coordinate: 1000000, minWidth: 1, maxWidth: 20});

const fail = message => { throw new Error(`画布绘画数据无效：${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Assertion only: never changes input and rejects values unsafe for SVG paths. */
export function validateCanvasDrawings(input) {
  if (!Array.isArray(input) || input.length > CANVAS_DRAWING_LIMITS.strokes) fail('笔画必须是最多200项的数组');
  let total = 0;
  for (const stroke of input) {
    if (!object(stroke) || Reflect.ownKeys(stroke).some(key => !['color', 'width', 'points'].includes(key))) fail('笔画只允许color、width和points字段');
    if (typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color)) fail('颜色必须是六位十六进制颜色');
    if (!Number.isFinite(stroke.width) || stroke.width < CANVAS_DRAWING_LIMITS.minWidth || stroke.width > CANVAS_DRAWING_LIMITS.maxWidth) fail('笔画宽度需为1至20的有限数字');
    if (!Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > CANVAS_DRAWING_LIMITS.pointsPerStroke) fail('每笔需有1至20000个坐标点');
    total += stroke.points.length;
    if (total > CANVAS_DRAWING_LIMITS.totalPoints) fail('坐标点总数不能超过100000');
    for (const point of stroke.points) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > CANVAS_DRAWING_LIMITS.coordinate || Math.abs(point[1]) > CANVAS_DRAWING_LIMITS.coordinate) fail('坐标点需为范围±1000000内的两个有限数字');
    }
  }
  return true;
}

/** A detached canonical value. The assertion runs before any data is copied. */
export function normalizeCanvasDrawings(input) {
  validateCanvasDrawings(input);
  return input.map(stroke => ({color: stroke.color, width: stroke.width, points: stroke.points.map(([x, y]) => [x, y])}));
}
