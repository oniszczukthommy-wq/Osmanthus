// Authenticated, streaming gateway for a temporary friend-demo tunnel.
// The application's own local-only Origin checks remain unchanged.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const configFile = process.argv[2];
if (!configFile) throw Error('Pass a private sharing config file.');
const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const initial = config();
const cookieName = '__Host-osmanthus-demo';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hops = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cookie', 'authorization', 'origin']);

const server = http.createServer((req, res) => {
  const reply = (status, message) => {
    res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow'});
    res.end(message);
  };
  let cfg, url;
  try {
    cfg = config();
    const expected = new URL(cfg.origin);
    if (req.headers.host !== expected.host) return reply(403, '访问地址不匹配。');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(400, '无效路径。');
    url = new URL(req.url, cfg.origin);
    if (url.origin !== cfg.origin) return reply(400, '无效路径。');
  } catch { return reply(503, '分享链接正在启动，请稍后刷新。'); }

  if (req.method === 'GET' && url.pathname === '/__invite') {
    if (!equal(url.searchParams.get('code'), cfg.invite)) return reply(403, '体验链接已失效。');
    res.writeHead(303, {Location: '/',
      'Set-Cookie': `${cookieName}=${cfg.session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'});
    return res.end();
  }
  const session = (req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!equal(session, cfg.session)) return reply(401, '请使用好友提供的完整 Osmanthus 体验链接打开。');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) return reply(405, '不支持此操作。');
  if (req.headers.origin && req.headers.origin !== cfg.origin) return reply(403, '请从 Osmanthus 页面操作。');
  if (!['GET', 'HEAD'].includes(req.method) &&
      (req.headers.origin !== cfg.origin || req.headers['sec-fetch-site'] === 'cross-site'))
    return reply(403, '请从 Osmanthus 页面操作。');
  if (req.headers.upgrade || req.headers['transfer-encoding']) return reply(400, '无效请求。');
  if (Number(req.headers['content-length'] || 0) > 80000000) return reply(413, '文件超过 80 MB。');

  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) =>
    !hops.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('cf-')));
  headers.host = `127.0.0.1:${cfg.upstream_port}`;
  headers.origin = `http://${headers.host}`;
  headers.connection = 'close';
  const upstream = http.request({hostname: '127.0.0.1', port: cfg.upstream_port,
    path: url.pathname + url.search, method: req.method, headers}, incoming => {
    const outgoing = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) =>
      !['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'server'].includes(name)));
    Object.assign(outgoing, {'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff'});
    res.writeHead(incoming.statusCode, outgoing);
    incoming.on('error', () => res.destroy());
    incoming.pipe(res); // Preserve streaming and backpressure, including audio and uploads.
  });
  upstream.setTimeout(180000, () => upstream.destroy(Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) reply(502, '服务连接中断，请稍后重试。');
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.requestTimeout = 180000;
server.headersTimeout = 30000;
server.listen(initial.port, '127.0.0.1', () => console.log(JSON.stringify({ready: true, port: server.address().port})));
