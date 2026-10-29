import fs from 'node:fs';
import path from 'node:path';

// Resolve once to absolute paths so capabilities and child processes agree.
export function findExecutable(name, override, environment = process.env) {
  const requested = override || name;
  const direct = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const extensions = process.platform === 'win32' ? (environment.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const candidates = direct ? [path.resolve(requested)] : (environment.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => [path.join(directory, requested), ...extensions.filter(Boolean).map(extension => path.join(directory, requested + extension.toLowerCase()))]);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return path.resolve(candidate); } } catch {}
  }
  // A missing tool is reported unavailable; the canvas still opens for uploads.
  return direct ? path.resolve(requested) : requested;
}

export function mediaTools(environment = process.env) {
  const ffmpeg = findExecutable('ffmpeg', environment.FFMPEG_BIN, environment);
  let ffprobe = findExecutable('ffprobe', environment.FFPROBE_BIN, environment);
  if (!environment.FFPROBE_BIN && !path.isAbsolute(ffprobe) && path.isAbsolute(ffmpeg)) {
    const sibling = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) ffprobe = sibling;
  }
  return {ffmpeg, ffprobe};
}

// No implicit access to a developer's other projects or credentials.
export function readOptionalEnv(filename, baseDirectory) {
  if (!filename) return {};
  const values = {};
  for (const line of fs.readFileSync(path.resolve(baseDirectory, filename), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
