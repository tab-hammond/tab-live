// Minimal Chrome DevTools Protocol client over one browser-level WebSocket.
// Uses flat sessions (Target.attachToTarget {flatten:true}) so every page shares this socket.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.on('open', () => { clearTimeout(timer); this.ws = ws; resolve(this); });
      ws.on('error', (e) => { clearTimeout(timer); if (!this.ws) reject(e); });
      ws.on('close', () => {
        this.closed = true;
        for (const { reject: rj, timer: t } of this.pending.values()) { clearTimeout(t); rj(new Error('CDP closed')); }
        this.pending.clear();
        this.emit('close');
      });
      ws.on('message', (buf) => this._onMessage(buf));
    });
  }

  _onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code }));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) this.emit('event', msg.method, msg.params || {}, msg.sessionId || null);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (!this.ws || this.closed) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws?.close(); } catch {} }
}

export async function fetchJson(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
