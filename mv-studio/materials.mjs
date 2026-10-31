import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MATERIAL_LIMITS = Object.freeze({image: 20_000_000, video: 80_000_000, audio: 80_000_000});
const TYPES = Object.freeze({
  '.png': {kind: 'image', mime: 'image/png', codec: ['png', 'apng']},
  '.jpg': {kind: 'image', mime: 'image/jpeg', codec: ['mjpeg']},
  '.jpeg': {kind: 'image', mime: 'image/jpeg', codec: ['mjpeg']},
  '.webp': {kind: 'image', mime: 'image/webp', codec: ['webp']},
  '.gif': {kind: 'image', mime: 'image/gif', codec: ['gif']},
  '.mp4': {kind: 'video', mime: 'video/mp4', format: ['mov', 'mp4']},
  '.mov': {kind: 'video', mime: 'video/quicktime', format: ['mov', 'mp4']},
  '.webm': {kind: 'video', mime: 'video/webm', format: ['webm', 'matroska']},
  '.mp3': {kind: 'audio', mime: 'audio/mpeg', format: ['mp3'], codec: ['mp3', 'mp3float']},
  '.wav': {kind: 'audio', mime: 'audio/wav', format: ['wav']},
  '.m4a': {kind: 'audio', mime: 'audio/mp4', format: ['mov', 'mp4']},
  '.aac': {kind: 'audio', mime: 'audio/aac', format: ['aac'], codec: ['aac']},
  '.flac': {kind: 'audio', mime: 'audio/flac', format: ['flac'], codec: ['flac']},
  '.ogg': {kind: 'audio', mime: 'audio/ogg', format: ['ogg']},
  '.opus': {kind: 'audio', mime: 'audio/ogg', format: ['ogg'], codec: ['opus']},
});
export const MATERIAL_EXTENSIONS = Object.freeze(Object.keys(TYPES));
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const dimension = value => Number.isSafeInteger(value) && value > 0;

function extension(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw fail('素材文件名无效');
  }
  const ext = path.extname(name).toLowerCase();
  if (!Object.hasOwn(TYPES, ext)) throw fail('请上传 PNG、JPG、WebP、GIF、MP4、MOV、WebM 或受支持的音频文件');
  return ext;
}

// Read the EBML header's DocType, so an MKV renamed to .webm is not accepted.
function webmHeader(bytes) {
  const vint = (offset, id = false) => {
    if (offset >= bytes.length || !bytes[offset]) throw Error('Invalid EBML');
    let count = 1, marker = 0x80;
    while (!(bytes[offset] & marker)) { count++; marker >>= 1; }
    if (count > (id ? 4 : 8) || offset + count > bytes.length) throw Error('Invalid EBML');
    let value = id ? bytes[offset] : bytes[offset] & (marker - 1);
    for (let i = 1; i < count; i++) value = value * 256 + bytes[offset + i];
    if (!Number.isSafeInteger(value)) throw Error('Invalid EBML');
    return {value, count};
  };
  try {
    if (bytes.length < 5 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
    const size = vint(4), end = 4 + size.count + size.value;
    if (end > Math.min(bytes.length, 65536)) return false;
    for (let at = 4 + size.count; at < end;) {
      const id = vint(at, true); at += id.count;
      const length = vint(at); at += length.count;
      if (at + length.value > end) return false;
      if (id.value === 0x4282) return bytes.toString('ascii', at, at + length.value) === 'webm';
      at += length.value;
    }
  } catch {}
  return false;
}

// ISO BMFF allows padding boxes before ftyp. Read top-level box lengths instead
// of assuming the brand is at byte 8; this also handles extended-size boxes.
function bmffHeader(bytes) {
  for (let at = 0, count = 0; at + 8 <= bytes.length && count < 256; count++) {
    let size = bytes.readUInt32BE(at), header = 8;
    const type = bytes.toString('ascii', at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > bytes.length) return null;
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(bytes.length - at)) return null;
      size = Number(large); header = 16;
    } else if (size === 0) size = bytes.length - at;
    if (size < header || at + size > bytes.length) return null;
    if (type === 'ftyp') return size >= header + 8 ? bytes.toString('ascii', at + header, at + header + 4) : null;
    at += size;
  }
  return null;
}

function signatureMatches(ext, bytes) {
  const ascii = (start, end) => bytes.toString('ascii', start, end);
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (ext === '.webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (ext === '.wav') return ['RIFF', 'RF64', 'BW64'].includes(ascii(0, 4)) && ascii(8, 12) === 'WAVE';
  if (ext === '.flac') return ascii(0, 4) === 'fLaC' || ascii(0, 3) === 'ID3';
  if (ext === '.ogg' || ext === '.opus') return ascii(0, 4) === 'OggS';
  if (ext === '.webm') return webmHeader(bytes);
  if (['.mp4', '.mov', '.m4a'].includes(ext)) {
    const brand = bmffHeader(bytes);
    if (ext === '.mov') return brand === 'qt  ' || (!brand && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 8)));
    return !!brand && brand !== 'qt  ' && !/^(3gp|3g2|mjp2|mj2)/.test(brand);
  }
  return true; // MP3/ADTS are distinguished by both demuxer and audio codec below.
}

function inspect(ext, bytes, info) {
  const type = TYPES[ext], streams = info?.streams;
  if (!Array.isArray(streams) || !streams.length || !signatureMatches(ext, bytes)) throw fail('文件内容与扩展名不符，或素材无法识别');
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  const video = streams.filter(stream => stream.codec_type === 'video' && !Number(stream.disposition?.attached_pic));
  const formats = String(info.format?.format_name || '').split(',');
  if (type.format && !type.format.some(format => formats.includes(format))) throw fail('文件内容与扩展名不符');
  let selected;
  if (type.kind === 'image') {
    selected = video[0];
    if (video.length !== 1 || audio.length || !type.codec.includes(selected?.codec_name)) throw fail('文件无法识别为对应格式的图片');
  } else if (type.kind === 'video') {
    selected = video[0];
    if (!selected) throw fail('视频文件缺少可用画面');
  } else {
    selected = audio[0];
    if (!selected || video.length || (type.codec && audio.some(stream => !type.codec.includes(stream.codec_name)))) throw fail('文件无法识别为对应格式的音频');
  }
  if (type.kind !== 'audio' && (!dimension(selected.width) || !dimension(selected.height))) throw fail('无法读取素材画面尺寸');
  const durations = [info.format?.duration, selected.duration].filter(positive).map(Number);
  const duration = durations.length ? Math.max(...durations) : 0;
  if (type.kind !== 'image' && !duration) throw fail('无法读取素材时长');
  return {kind: type.kind, width: type.kind === 'audio' ? 0 : selected.width, height: type.kind === 'audio' ? 0 : selected.height, duration};
}

function atomicJson(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), {flag: 'wx', mode: 0o600});
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * Local copies for the free canvas. Does not read or change the project/song.
 * upload follows the injected probe: asynchronous in the web server,
 * synchronous for lightweight callers. Read-only methods stay synchronous.
 * upload(name, Buffer) -> public material; list()/get(id) -> verified material(s).
 * asset(id or stored filename) -> {file, mime, material}, or null.
 * remove(id) -> boolean; only a registered, hash-verified copy can be removed.
 */
export function createMaterialStore({data, probe, write = atomicJson} = {}) {
  if (typeof data !== 'string' || !data || typeof probe !== 'function' || typeof write !== 'function') throw new TypeError('data、probe 和 write 参数无效');
  const requestedRoot = path.resolve(data, 'materials');
  fs.mkdirSync(requestedRoot, {recursive: true});
  if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw fail('素材目录不能是符号链接', 500);
  const root = fs.realpathSync(requestedRoot), rootStat = fs.statSync(root);
  const assertRoot = () => {
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw fail('素材目录已改变，请重启服务', 500);
  };
  const fileFor = name => {
    const file = path.resolve(root, name);
    if (path.dirname(file) !== root) throw fail('素材路径无效');
    return file;
  };
  const readRegular = (file, max) => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw fail('素材文件无效');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > max) throw fail('素材文件已改变');
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  };
  function registered(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    assertRoot();
    try {
      const saved = JSON.parse(readRegular(fileFor(id + '.json'), 16384));
      if (saved.version !== 1 || !saved.material || typeof saved.material !== 'object') return null;
      const m = saved.material, ext = extension(m.name), type = TYPES[ext];
      if (m.id !== id || m.kind !== type.kind || m.url !== `/files/materials/${id}${ext}` || !/^[a-f0-9]{64}$/.test(m.sha256 || '') || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MATERIAL_LIMITS[type.kind] || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) return null;
      if (!Number.isFinite(m.duration) || m.duration < 0 || (m.kind !== 'image' && !m.duration)) return null;
      if (m.kind === 'audio' ? m.width !== 0 || m.height !== 0 : !dimension(m.width) || !dimension(m.height)) return null;
      const filename = id + ext, file = fileFor(filename), bytes = readRegular(file, MATERIAL_LIMITS[type.kind]);
      if (bytes.length !== m.bytes || digest(bytes) !== m.sha256) return null;
      const material = {id, kind: m.kind, name: m.name, url: m.url, width: m.width, height: m.height, duration: m.duration, bytes: m.bytes, sha256: m.sha256, createdAt: m.createdAt};
      return {file, mime: type.mime, material};
    } catch { return null; }
  }
  function upload(name, bytes) {
    const ext = extension(name), type = TYPES[ext];
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail('素材文件为空或上传格式无效');
    if (bytes.length > MATERIAL_LIMITS[type.kind]) throw fail(type.kind === 'image' ? '图片不能超过20MB' : '视频或音频不能超过80MB', 413);
    assertRoot();
    const id = crypto.randomUUID(), file = fileFor(id + ext), record = fileFor(id + '.json');
    let created = false, metadataWriteAttempted = false;
    const cleanup = error => {
      if (created) { try { fs.unlinkSync(file); } catch {} }
      if (metadataWriteAttempted) { try { fs.unlinkSync(record); } catch {} }
      throw error;
    };
    const finish = info => {
      const dimensions = inspect(ext, bytes, info);
      const material = {id, ...dimensions, name, url: `/files/materials/${id}${ext}`, bytes: bytes.length, sha256: digest(bytes), createdAt: new Date().toISOString()};
      if (fs.existsSync(record)) throw fail('素材注册冲突，请重新上传', 500);
      metadataWriteAttempted = true;
      write(record, {version: 1, material});
      if (!registered(id)) throw fail('素材保存校验失败，请重新上传', 500);
      return material;
    };
    const probeFailure = error => { throw error.code === 'MEDIA_BUSY' ? error : fail('素材无法读取，请上传有效的图片、视频或音频'); };
    try {
      fs.writeFileSync(file, bytes, {flag: 'wx', mode: 0o600});
      created = true;
      let info;
      try { info = probe(file); } catch (error) { probeFailure(error); }
      return info && typeof info.then === 'function' ? info.then(finish, probeFailure).catch(cleanup) : finish(info);
    } catch (error) { return cleanup(error); }
  }

  function list() {
    assertRoot();
    return fs.readdirSync(root).filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5))).map(name => registered(name.slice(0, -5))?.material).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  function get(id) { return registered(id)?.material || null; }
  function asset(idOrFilename) {
    if (typeof idOrFilename !== 'string') return null;
    if (ID.test(idOrFilename)) return registered(idOrFilename);
    const ext = path.extname(idOrFilename), id = idOrFilename.slice(0, -ext.length);
    if (!Object.hasOwn(TYPES, ext) || !ID.test(id)) return null;
    const found = registered(id);
    return found && path.basename(found.file) === idOrFilename ? found : null;
  }
  function remove(id) {
    const found = registered(id);
    if (!found) return false;
    fs.unlinkSync(found.file);
    fs.unlinkSync(fileFor(id + '.json'));
    return true;
  }
  return Object.freeze({upload, list, get, asset, remove});
}
