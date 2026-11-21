/**
 * Agent P - Render(Node)用サーバー
 * worker.js（Cloudflare Worker形式）をそのまま動かすアダプタ。
 *  - public/index.html を配信（画面とAPIが同一オリジンになる）
 *  - KV互換ストア: UPSTASH_REDIS_REST_URL/TOKEN があればUpstash、なければメモリ+ファイル
 *  - 画像生成: CF_ACCOUNT_ID / CF_API_TOKEN があればCloudflare REST経由
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'kv.json');

/* ---------------- KV互換ストア ---------------- */
function makeMemoryKV() {
  const m = new Map(); // key -> { v, exp }
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [k, o] of Object.entries(saved)) m.set(k, o);
  } catch {}
  let dirty = false;
  const alive = (o) => o && (!o.exp || o.exp > Date.now());
  setInterval(() => {
    for (const [k, o] of m) if (!alive(o)) { m.delete(k); dirty = true; }
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(m)));
      dirty = false;
    } catch {}
  }, 30000).unref();
  return {
    async get(key, type) {
      const o = m.get(key);
      if (!alive(o)) { m.delete(key); return null; }
      return type === 'json' ? JSON.parse(o.v) : o.v;
    },
    async put(key, value, opts = {}) {
      m.set(key, { v: String(value), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
      dirty = true;
    }
  };
}

function makeUpstashKV(url, token) {
  const call = async (cmd) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    if (!r.ok) throw new Error('Upstash HTTP ' + r.status);
    return (await r.json()).result;
  };
  return {
    async get(key, type) {
      const v = await call(['GET', key]);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts = {}) {
      const cmd = ['SET', key, String(value)];
      if (opts.expirationTtl) cmd.push('EX', String(Math.max(1, Math.floor(opts.expirationTtl))));
      await call(cmd);
    }
  };
}

/* ---------------- 画像生成（Workers AI の REST 版） ---------------- */
function makeCfAI(accountId, token) {
  return {
    async run(model, input) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error('Workers AI error ' + r.status);
      return j.result;
    }
  };
}

/* ---------------- env を組み立て ---------------- */
const env = { ...process.env };
env.KV = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
  ? makeUpstashKV(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
  : makeMemoryKV();
if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) env.AI = makeCfAI(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);

/* ---------------- 静的ファイル ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const API_PATHS = ['/config', '/chat', '/title', '/summarize', '/health', '/v1'];
const isApi = (p) => API_PATHS.some((a) => p === a || p.startsWith(a + '/'));

/* ---------------- HTTPサーバー ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, `${proto}://${host}`);

    if (req.method === 'GET' && !isApi(url.pathname) && serveStatic(req, res, url.pathname)) return;

    // Request へ変換
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v != null) headers.set(k, v);
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    headers.set('CF-Connecting-IP', ip);
    // 同一オリジンのGETはOriginヘッダーが付かないため、自分のオリジンを補う
    if (!headers.get('origin') && !url.pathname.startsWith('/v1')) headers.set('origin', `${proto}://${host}`);

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) { res.writeHead(413).end('Payload Too Large'); return; } chunks.push(c); }
      body = Buffer.concat(chunks);
    }

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const request = new Request(url, { method: req.method, headers, body, signal: ac.signal });

    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil', e))), passThroughOnException() {} };

    const response = await worker.fetch(request, env, ctx);

    const out = {};
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    if (!response.body) { res.end(); return; }
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.end());
    stream.pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, '0.0.0.0', () => console.log(`Agent P listening on :${PORT}`));
