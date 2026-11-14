#!/usr/bin/env node
// Tab Live — a self-hosted live view for an agent's Chrome.
// Serves a PWA, streams the active tab over WebSocket, and lets a human take over.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BrowserWatcher } from './lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CONFIG_DIR = process.env.TAB_LIVE_CONFIG_DIR || path.join(HOME, '.config', 'tab-live');

// ------------------------------------------------------------------ config
function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); } catch {}
  const env = process.env;
  const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);
  const c = {
    hosts: (env.TAB_LIVE_HOSTS || file.hosts || '127.0.0.1').toString().split(',').map((s) => s.trim()).filter(Boolean),
    port: num(env.TAB_LIVE_PORT ?? file.port, 8335),
    cdpUrl: env.TAB_LIVE_CDP || file.cdpUrl || 'http://127.0.0.1:9222',
    name: env.TAB_LIVE_NAME || file.name || 'Tab',
    quality: num(env.TAB_LIVE_QUALITY ?? file.quality, 60),
    maxWidth: num(env.TAB_LIVE_MAX_WIDTH ?? file.maxWidth, 1600),
    replayMinutes: num(env.TAB_LIVE_REPLAY_MINUTES ?? file.replayMinutes, 15),
    replayFps: num(env.TAB_LIVE_REPLAY_FPS ?? file.replayFps, 2),
    replayMaxMB: num(env.TAB_LIVE_REPLAY_MAX_MB ?? file.replayMaxMB, 400),
    takeoverIdleSec: num(env.TAB_LIVE_TAKEOVER_IDLE ?? file.takeoverIdleSec, 180),
    fullConsole: String(env.TAB_LIVE_FULL_CONSOLE ?? file.fullConsole ?? 'false') === 'true',
    desktopDir: env.TAB_LIVE_DESKTOP_DIR || file.desktopDir || path.join(HOME, '.cache', 'tab-live'),
    logDir: env.TAB_LIVE_LOG_DIR || file.logDir || path.join(HOME, 'Library', 'Logs', 'tab-live'),
    activityDays: num(env.TAB_LIVE_ACTIVITY_DAYS ?? file.activityDays, 7),
    allowAnyHost: String(env.TAB_LIVE_ALLOW_ANY_HOST ?? file.allowAnyHost ?? 'false') === 'true',
  };
  for (const h of c.hosts) {
    if (h === '0.0.0.0' || h === '::' || h === '*') {
      console.error(`[tab-live] refusing to bind ${h}: list explicit addresses (e.g. 127.0.0.1 and your Tailscale IP).`);
      process.exit(2);
    }
  }
  return c;
}
const cfg = loadConfig();

function loadToken() {
  if (process.env.TAB_LIVE_TOKEN) return process.env.TAB_LIVE_TOKEN;
  const f = path.join(CONFIG_DIR, 'token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 16) return t; } catch {}
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  console.log(`[tab-live] generated a new access token in ${f}`);
  return t;
}
const TOKEN = loadToken();
const TOKEN_BUF = Buffer.from(TOKEN);
function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t);
  return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF);
}
// Slow down guessing: per-IP failure counter with exponential lockout.
const failures = new Map();
function throttled(ip) { const f = failures.get(ip); return f && f.until > Date.now(); }
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60_000, 1000 * 2 ** (f.n - 4));
  failures.set(ip, f);
}

const log = (...a) => console.log(new Date().toISOString(), '[tab-live]', ...a);

// ------------------------------------------------------------------ activity log (ring + daily JSONL)
const FEED_MAX = 1500;
const feed = [];
fs.mkdirSync(cfg.logDir, { recursive: true });
function persist(ev) {
  const day = new Date(ev.ts).toISOString().slice(0, 10);
  fs.appendFile(path.join(cfg.logDir, `activity-${day}.jsonl`), JSON.stringify(ev) + '\n', () => {});
}
function pruneLogs() {
  try {
    const cutoff = Date.now() - cfg.activityDays * 86400_000;
    for (const f of fs.readdirSync(cfg.logDir)) {
      const m = f.match(/^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(cfg.logDir, f));
    }
  } catch {}
}
pruneLogs(); setInterval(pruneLogs, 6 * 3600_000).unref();

// ------------------------------------------------------------------ replay ring buffer
const replay = { frames: [], bytes: 0, seq: 0, lastAt: 0 };
function recordFrame(fr) {
  const now = Date.now();
  if (now - replay.lastAt < 1000 / cfg.replayFps) return;
  replay.lastAt = now;
  const t = watcher.targets.get(fr.targetId);
  replay.frames.push({ seq: ++replay.seq, ts: now, targetId: fr.targetId, title: t?.title || '', url: t?.url || '', data: fr.data });
  replay.bytes += fr.data.length;
  const cutoff = now - cfg.replayMinutes * 60_000;
  while (replay.frames.length && (replay.frames[0].ts < cutoff || replay.bytes > cfg.replayMaxMB * 1048576)) {
    replay.bytes -= replay.frames.shift().data.length;
  }
}

// ------------------------------------------------------------------ browser watcher
const watcher = new BrowserWatcher({ cdpUrl: cfg.cdpUrl, quality: cfg.quality, maxWidth: cfg.maxWidth, maxHeight: cfg.maxWidth, fullConsole: cfg.fullConsole });
const clients = new Set();
let takeover = null; // { clientId, label, since, lastInput }
const STATE_FILE = path.join(CONFIG_DIR, 'takeover.json');
function writeTakeoverFile() {
  // Agents can read this file (or GET /api/takeover locally) to pause while a human drives.
  const body = takeover ? { active: true, by: takeover.label, since: takeover.since } : { active: false };
  fs.writeFile(STATE_FILE, JSON.stringify(body) + '\n', () => {});
}
writeTakeoverFile();

function broadcastJSON(obj, filter) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.authed && (!filter || filter(c)) && c.ws.readyState === 1) c.ws.send(s);
}
function stateMsg() {
  return {
    type: 'state', name: cfg.name, ...watcher.publicStatus(), targets: watcher.targetList(),
    takeover: takeover ? { by: takeover.label, since: takeover.since, clientId: takeover.clientId } : null,
    viewers: [...clients].filter((c) => c.authed).map((c) => ({ id: c.id, label: c.label, view: c.view })),
    replay: { minutes: cfg.replayMinutes, frames: replay.frames.length, from: replay.frames[0]?.ts || null },
    desktop: desktopState(),
    fullConsole: cfg.fullConsole,
  };
}
let stateTimer = null;
function pushState() { // coalesce bursts of target events
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcastJSON(stateMsg()); }, 120);
}

watcher.on('status', (s) => { pushState(); if (s.status === 'idle' && takeover) endTakeover('browser went away'); });
watcher.on('targets', pushState);
watcher.on('active', pushState);
watcher.on('background', (id) => broadcastJSON({ type: 'background', targetId: id }));
watcher.on('feed', (ev) => {
  feed.push(ev); if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
  persist(ev);
  broadcastJSON({ type: 'feed', ev });
});

function framePacket(kind, fr, extra = {}) {
  const head = Buffer.from(JSON.stringify(Object.assign({ kind, targetId: fr.targetId, meta: fr.meta, sentAt: Date.now() }, extra)));
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, fr.data]);
}
// Flow control: at most MAX_INFLIGHT frames travel to a viewer before it acks one. Newer frames
// replace an unsent one, so a slow phone gets fewer frames instead of a growing delay.
const MAX_INFLIGHT = 2;
function deliver(c, pkt) {
  if (c.inflight >= MAX_INFLIGHT || c.ws.bufferedAmount > 512 * 1024) { if (c.pending) c.dropped++; c.pending = pkt; return; }
  c.inflight++; c.pending = null;
  c.ws.send(pkt);
}
watcher.on('frame', (fr) => {
  recordFrame(fr);
  let pkt = null;
  for (const c of clients) {
    if (!c.authed || c.view !== 'browser' || c.paused || c.ws.readyState !== 1) continue;
    pkt ||= framePacket('browser', fr);
    deliver(c, pkt);
  }
});
watcher.start();

// ------------------------------------------------------------------ whole-desktop frames (written by the optional desktop helper)
const DESKTOP_JPG = path.join(cfg.desktopDir, 'desktop.jpg');
const DESKTOP_WANT = path.join(cfg.desktopDir, 'desktop.want');
let desktopLast = { mtime: 0, size: 0 };
function desktopState() {
  try { const st = fs.statSync(DESKTOP_JPG); return { available: Date.now() - st.mtimeMs < 6 * 3600_000, updated: st.mtimeMs }; }
  catch { return { available: false, updated: null }; }
}
setInterval(() => {
  const watching = [...clients].some((c) => c.authed && c.view === 'desktop' && !c.paused);
  if (!watching) return;
  try { fs.mkdirSync(cfg.desktopDir, { recursive: true }); fs.writeFileSync(DESKTOP_WANT, String(Date.now())); } catch {}
  let st; try { st = fs.statSync(DESKTOP_JPG); } catch { return; }
  if (st.mtimeMs === desktopLast.mtime && st.size === desktopLast.size) return;
  desktopLast = { mtime: st.mtimeMs, size: st.size };
  let data; try { data = fs.readFileSync(DESKTOP_JPG); } catch { return; }
  if (data.length < 1000 || data[0] !== 0xff || data[1] !== 0xd8) return;
  const pkt = framePacket('desktop', { targetId: null, meta: { capturedAt: st.mtimeMs }, data });
  for (const c of clients) if (c.authed && c.view === 'desktop' && !c.paused && c.ws.readyState === 1) deliver(c, pkt);
}, 400).unref();

// ------------------------------------------------------------------ take-over
function endTakeover(reason) {
  if (!takeover) return;
  const t = takeover; takeover = null;
  watcher.feed('takeover', `${t.label} handed control back${reason ? ` (${reason})` : ''}`, { level: 'warn' });
  writeTakeoverFile(); pushState();
}
setInterval(() => {
  if (takeover && Date.now() - takeover.lastInput > cfg.takeoverIdleSec * 1000) endTakeover('idle');
}, 5000).unref();

// ------------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
const PUBLIC = path.join(__dirname, 'public');
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const allowedHosts = new Set();
for (const h of cfg.hosts) { allowedHosts.add(`${h}:${cfg.port}`); }
allowedHosts.add(`localhost:${cfg.port}`);
for (const h of (process.env.TAB_LIVE_EXTRA_HOSTNAMES || '').split(',').filter(Boolean)) allowedHosts.add(h.includes(':') ? h : `${h}:${cfg.port}`);
function hostOk(req) { return cfg.allowAnyHost || allowedHosts.has(String(req.headers.host || '').toLowerCase()); }
function ipOf(req) { return req.socket.remoteAddress || '?'; }

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC_HEADERS, extra));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function reqToken(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('t');
}

const favCache = new Map(); // url -> {data,type,ts}
async function favicon(targetId) {
  const t = watcher.targets.get(targetId);
  if (!t || !t.url) return null;
  let src = null;
  try {
    const list = await fetch(cfg.cdpUrl.replace(/\/$/, '') + '/json/list', { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
    src = list.find((x) => x.id === targetId)?.faviconUrl || null;
  } catch {}
  if (!src) { try { src = new URL('/favicon.ico', t.url).href; } catch { return null; } }
  if (favCache.has(src) && Date.now() - favCache.get(src).ts < 3600_000) return favCache.get(src);
  try {
    if (src.startsWith('data:')) {
      const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (!m) return null;
      const v = { type: m[1], data: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])), ts: Date.now() };
      favCache.set(src, v); return v;
    }
    if (!/^https?:/.test(src)) return null;
    const r = await fetch(src, { signal: AbortSignal.timeout(3000), redirect: 'follow' });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\//.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 200_000) return null;
    const v = { type, data: buf, ts: Date.now() }; favCache.set(src, v);
    if (favCache.size > 300) favCache.delete(favCache.keys().next().value);
    return v;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req)) return send(res, 421, { error: 'unknown host' });
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, { ok: true, browser: watcher.status });

  if (p.startsWith('/api/')) {
    const ip = ipOf(req);
    if (throttled(ip)) return send(res, 429, { error: 'too many attempts' });
    if (!tokenOk(reqToken(req, url))) { noteFailure(ip); return send(res, 401, { error: 'token required' }); }
    failures.delete(ip);
    if (p === '/api/activity' && req.method === 'POST') {
      let body = '';
      for await (const ch of req) { body += ch; if (body.length > 8192) break; }
      let j = {}; try { j = JSON.parse(body); } catch {}
      const ev = { ts: Date.now(), kind: 'shell', level: j.level === 'error' ? 'error' : 'info', text: String(j.text || '').slice(0, 200), sub: String(j.sub || '').slice(0, 300) };
      if (!ev.text) return send(res, 400, { error: 'text required' });
      watcher.emit('feed', ev);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/state') return send(res, 200, stateMsg());
    if (p === '/api/feed') return send(res, 200, feed.slice(-500));
    if (p === '/api/takeover') return send(res, 200, takeover ? { active: true, by: takeover.label, since: takeover.since } : { active: false });
    if (p === '/api/frame.jpg') {
      if (!watcher.lastFrame) return send(res, 404, { error: 'no frame yet' });
      return send(res, 200, watcher.lastFrame.data, 'image/jpeg');
    }
    if (p === '/api/desktop.jpg') {
      try { return send(res, 200, fs.readFileSync(DESKTOP_JPG), 'image/jpeg'); } catch { return send(res, 404, { error: 'desktop helper not running' }); }
    }
    if (p === '/api/favicon') {
      const v = await favicon(url.searchParams.get('id'));
      if (!v) return send(res, 404, '', 'text/plain');
      return send(res, 200, v.data, v.type, { 'Cache-Control': 'private, max-age=600' });
    }
    if (p === '/api/replay/index') {
      return send(res, 200, replay.frames.map((f) => [f.seq, f.ts, f.targetId, f.title]));
    }
    const m = p.match(/^\/api\/replay\/frame\/(\d+)$/);
    if (m) {
      const seq = +m[1];
      const f = replay.frames.find((x) => x.seq === seq);
      if (!f) return send(res, 404, { error: 'gone' });
      return send(res, 200, f.data, 'image/jpeg', { 'Cache-Control': 'private, max-age=3600' });
    }
    return send(res, 404, { error: 'not found' });
  }

  // static
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    send(res, 200, data, type, { 'Cache-Control': file === '/index.html' ? 'no-cache' : 'public, max-age=300' });
  });
});

// ------------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
let nextClient = 1;
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const ip = ipOf(req);
  if (url.pathname !== '/ws' || !hostOk(req) || throttled(ip) || !tokenOk(url.searchParams.get('t'))) {
    if (url.pathname === '/ws') noteFailure(ip);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  failures.delete(ip);
  wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, req));
});

function labelFor(req, given) {
  if (given) return String(given).slice(0, 40);
  const ua = String(req.headers['user-agent'] || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Viewer';
}

function onClient(ws, req) {
  const url = new URL(req.url, 'http://x');
  const c = { id: nextClient++, ws, authed: true, view: 'browser', paused: false, dropped: 0, inflight: 0, pending: null, label: labelFor(req, url.searchParams.get('label')) };
  clients.add(c);
  log(`viewer ${c.id} (${c.label}) connected from ${ipOf(req)}`);
  ws.send(JSON.stringify(stateMsg()));
  ws.send(JSON.stringify({ type: 'hello', clientId: c.id, feed: feed.slice(-300), serverTime: Date.now() }));
  if (watcher.lastFrame && watcher.lastFrame.targetId === watcher.activeId) deliver(c, framePacket('browser', watcher.lastFrame, { cached: true }));
  pushState();

  ws.on('message', async (buf, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    try {
      switch (m.type) {
        case 'ping': ws.send(JSON.stringify({ type: 'pong', t: m.t, serverTime: Date.now() })); return;
        case 'ack': c.inflight = Math.max(0, c.inflight - 1); if (c.pending && c.ws.readyState === 1) deliver(c, c.pending); return;
        case 'view':
          c.view = m.view === 'desktop' ? 'desktop' : 'browser'; desktopLast = { mtime: 0, size: 0 }; c.inflight = 0; c.pending = null;
          if (c.view === 'browser' && watcher.lastFrame) deliver(c, framePacket('browser', watcher.lastFrame, { cached: true }));
          pushState(); return;
        case 'pause': c.paused = !!m.paused; if (!c.paused) { c.inflight = 0; } return;
        case 'pin': watcher.pin(m.targetId || null); return;    // what to watch; never changes the browser
        case 'takeover':
          if (m.on) {
            if (takeover && takeover.clientId !== c.id && !m.force) { ws.send(JSON.stringify({ type: 'error', error: `${takeover.label} is already in control` })); return; }
            takeover = { clientId: c.id, label: c.label, since: Date.now(), lastInput: Date.now() };
            watcher.feed('takeover', `${c.label} took control of the browser`, { level: 'warn' });
            writeTakeoverFile(); pushState();
          } else if (takeover?.clientId === c.id) endTakeover();
          return;
        case 'mouse': case 'tap': case 'key': case 'text': case 'nav': case 'activate':
          if (!takeover || takeover.clientId !== c.id) { ws.send(JSON.stringify({ type: 'error', error: 'view-only: take over first' })); return; }
          takeover.lastInput = Date.now();
          if (m.type === 'nav') watcher.feed('takeover', `${c.label}: ${m.action}${m.url ? ' ' + String(m.url).slice(0, 120) : ''}`, { level: 'warn' });
          await watcher.input(m);
          return;
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) })); } catch {}
    }
  });
  ws.on('close', () => {
    clients.delete(c);
    log(`viewer ${c.id} disconnected`);
    if (takeover?.clientId === c.id) endTakeover('viewer disconnected');
    pushState();
  });
  ws.on('error', () => {});
}
// keepalive so phones on flaky links are noticed quickly
setInterval(() => { for (const c of clients) { if (c.ws.readyState === 1) c.ws.ping(); } }, 15_000).unref();

// ------------------------------------------------------------------ listen (retry each address: a VPN address may come up after boot)
function listenOn(host) {
  const srv = host === cfg.hosts[0] ? server : http.createServer(server.listeners('request')[0]);
  if (srv !== server) srv.on('upgrade', (...a) => server.emit('upgrade', ...a));
  const attempt = () => {
    srv.once('error', (e) => {
      log(`cannot listen on ${host}:${cfg.port} (${e.code}); retrying in 5s`);
      setTimeout(attempt, 5000);
    });
    srv.listen(cfg.port, host, () => log(`listening on http://${host}:${cfg.port}`));
  };
  attempt();
}
cfg.hosts.forEach(listenOn);
log(`watching Chrome at ${cfg.cdpUrl}; replay ${cfg.replayMinutes} min @ ${cfg.replayFps} fps; console mode ${cfg.fullConsole ? 'full' : 'stealth-safe'}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); watcher.stop(); process.exit(0); });
process.on('uncaughtException', (e) => log('uncaught', e?.stack || e));
process.on('unhandledRejection', (e) => log('unhandled', e?.stack || e));
