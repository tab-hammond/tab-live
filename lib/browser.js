// BrowserWatcher: follows one Chrome over CDP, streams the active tab, builds an activity feed.
//
// Stealth note: this module never calls Runtime.enable / Console.enable on pages, because
// anti-bot scripts can detect a DevTools client that serializes console arguments.
// Page code is only ever evaluated in a private isolated world (to read
// document.visibilityState), and input is only dispatched while a human has taken over.
import { EventEmitter } from 'node:events';
import { CDP, fetchJson } from './cdp.js';

const PAGE_TYPES = new Set(['page']);
const NOISY_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media', 'Ping', 'Manifest', 'Other', 'Prefetch', 'CSPViolationReport']);

function shortUrl(u, max = 140) {
  try {
    const x = new URL(u);
    let s = x.host + x.pathname;
    if (x.search) s += '?…';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  } catch { return (u || '').slice(0, max); }
}
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function isInternal(u) { return !u || u.startsWith('chrome://') || u.startsWith('devtools://') || u.startsWith('chrome-extension://') || u.startsWith('chrome-untrusted://'); }

export class BrowserWatcher extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = Object.assign({
      cdpUrl: 'http://127.0.0.1:9222',
      quality: 70, maxWidth: 1600, maxHeight: 1600,
      fullConsole: false,
      pollMs: 2000,
    }, opts || {});
    this.cdp = null;
    this.status = 'idle';          // idle | connecting | live
    this.browserVersion = null;
    this.lastSeen = null;
    this.targets = new Map();      // targetId -> info
    this.sessions = new Map();     // sessionId -> targetId
    this.activeId = null;
    this.pinnedId = null;
    this.casting = null;           // { targetId, sessionId }
    this.lastFrame = null;         // { targetId, meta, data(Buffer), ts }
    this.lastSwitch = 0;
    this.requests = new Map();     // `${sessionId}:${requestId}` -> {url,type,method,t0,targetId}
    this._stop = false;
    this._loopTimer = null;
    this._visTimer = null;
  }

  start() { this._loop(); }
  stop() { this._stop = true; clearTimeout(this._loopTimer); clearInterval(this._visTimer); this.cdp?.close(); }

  // ---------------------------------------------------------------- connection
  async _loop() {
    if (this._stop) return;
    if (!this.cdp || this.cdp.closed) {
      try {
        this._setStatus('connecting');
        const v = await fetchJson(this.opts.cdpUrl.replace(/\/$/, '') + '/json/version');
        await this._connect(v);
      } catch (e) {
        if (this.status !== 'idle') this._setStatus('idle');
      }
    }
    this._loopTimer = setTimeout(() => this._loop(), this.opts.pollMs);
  }

  async _connect(version) {
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();
    this.cdp = cdp;
    this.browserVersion = version.Browser;
    this.targets.clear(); this.sessions.clear(); this.casting = null; this.requests.clear();
    this._booting = true; // setDiscoverTargets replays every existing target as targetCreated
    cdp.on('event', (m, p, s) => this._onEvent(m, p, s));
    cdp.on('close', () => {
      this.cdp = null; this.casting = null; this.sessions.clear();
      this.lastSeen = Date.now();
      this._setStatus('idle');
      this.feed('browser', 'Browser disconnected — waiting for it to come back');
      clearInterval(this._visTimer);
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const ti of targetInfos) this._upsertTarget(ti, true);
    this._booting = false;
    this._setStatus('live');
    this.lastSeen = Date.now();
    this.feed('browser', `Connected to ${this.browserVersion}`);
    // Attach in the background: a frozen background tab can take seconds to answer.
    for (const t of this.targets.values()) this._attach(t.targetId).catch(() => {});
    this._chooseActive(true);
    const tick = () => this._pollVisibility().then(() => this._chooseActive()).catch(() => {});
    setTimeout(tick, 1200);
    clearInterval(this._visTimer);
    this._visTimer = setInterval(tick, 2500);
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (s === 'live') this.lastSeen = Date.now();
    this.emit('status', this.publicStatus());
  }

  publicStatus() {
    return { status: this.status, browser: this.browserVersion, lastSeen: this.lastSeen, activeId: this.activeId, pinnedId: this.pinnedId };
  }

  // ---------------------------------------------------------------- targets
  _upsertTarget(ti, initial = false) {
    if (!PAGE_TYPES.has(ti.type)) return null;
    let t = this.targets.get(ti.targetId);
    const now = Date.now();
    if (!t) {
      t = { targetId: ti.targetId, url: ti.url, title: ti.title, created: now, activity: initial ? 0 : now, visible: false,
            sessionId: null, attached: false, net: { requests: 0, bytes: 0, failed: 0 }, loading: false, favicon: null, isolated: null };
      this.targets.set(ti.targetId, t);
      if (!initial) {
        t.lastNav = now;
        this.feed('tab', `Opened a new tab${ti.url && ti.url !== 'about:blank' ? ' · ' + shortUrl(ti.url) : ''}`, { targetId: ti.targetId });
        this._attach(ti.targetId).catch(() => {});
      }
    } else {
      const urlChanged = ti.url !== t.url;
      if (urlChanged && !isInternal(ti.url)) {
        t.activity = now; t.lastNav = now;
        if (ti.url !== 'about:blank') this.feed('nav', shortUrl(ti.url, 200), { targetId: t.targetId, url: ti.url });
        t.favicon = null;
      }
      if (ti.title !== t.title && ti.title && !ti.title.startsWith('http')) t.activity = Math.max(t.activity, now - 500);
      t.url = ti.url; t.title = ti.title;
    }
    return t;
  }

  async _attach(targetId) {
    const t = this.targets.get(targetId);
    if (!t || t.attached || !this.cdp) return;
    t.attached = true;
    try {
      const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      t.sessionId = sessionId; t.attachedAt = Date.now();
      this.sessions.set(sessionId, targetId);
      const s = (m, p) => this.cdp.send(m, p || {}, sessionId).catch(() => {});
      await Promise.all([
        s('Page.enable'),
        s('Network.enable', { maxTotalBufferSize: 1024, maxResourceBufferSize: 512, maxPostDataSize: 0 }),
        s('Log.enable'),
        this.opts.fullConsole ? s('Runtime.enable') : null,
      ]);
    } catch (e) {
      t.attached = false;
    }
  }

  async _isolatedEval(t, expression) {
    if (!t.sessionId || !this.cdp) return undefined;
    try {
      if (!t.isolated) {
        const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, t.sessionId, 3000);
        const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: '__tab_live__', grantUniveralAccess: false }, t.sessionId, 3000);
        t.isolated = executionContextId;
      }
      const r = await this.cdp.send('Runtime.evaluate', { expression, contextId: t.isolated, returnByValue: true, silent: true }, t.sessionId, 3000);
      return r.result?.value;
    } catch (e) {
      t.isolated = null;
      return undefined;
    }
  }

  async _pollVisibility() {
    if (this._polling) return;
    this._polling = true;
    const now = Date.now();
    const list = [...this.targets.values()].filter((t) => t.sessionId && !(t.evalFailAt && now - t.evalFailAt < 30_000));
    await Promise.all(list.map(async (t) => {
      const v = await this._isolatedEval(t, 'JSON.stringify([document.visibilityState, document.hasFocus(), performance.timeOrigin, document.title])');
      if (typeof v !== 'string') { t.evalFailAt = Date.now(); return; }
      t.evalFailAt = 0;
      let vis, focus, origin, title;
      try { [vis, focus, origin, title] = JSON.parse(v); } catch { return; }
      // Chrome doesn't always send targetInfoChanged for a title; read it from the page itself.
      if (title && title !== t.title) { t.title = title; this._titlesChanged = true; }
      const visible = vis === 'visible';
      // Seed "last activity" from when the current document started loading, so a fresh start
      // already knows which tab was used last.
      if (!t.activity && origin) t.activity = Math.min(Date.now(), Math.round(origin));
      if (t.polled && visible && !t.visible) t.activity = Math.max(t.activity, Date.now() - 1000);
      if (t.polled && focus && !t.focused) t.activity = Math.max(t.activity, Date.now() - 1000);
      t.visible = visible; t.focused = !!focus; t.polled = true;
    })).finally(() => { this._polling = false; if (this._titlesChanged) { this._titlesChanged = false; this.emit('targets'); } });
  }

  // Pick the tab Tab is working in: pinned > visible+most recent activity > most recent activity.
  _chooseActive(force = false) {
    const now = Date.now();
    let pick = null;
    if (this.pinnedId && this.targets.has(this.pinnedId)) pick = this.pinnedId;
    else {
      const all = [...this.targets.values()].filter((t) => !isInternal(t.url));
      const score = (t) => t.activity + (t.visible ? 3_000 : 0) + (t.focused ? 5_000 : 0);
      all.sort((a, b) => score(b) - score(a));
      pick = all[0]?.targetId || [...this.targets.keys()][0] || null;
    }
    if (pick === this.activeId && this.casting?.targetId === pick) return;
    if (!force && this.activeId && this.targets.has(this.activeId) && now - this.lastSwitch < 1500 && pick !== this.pinnedId) return;
    this._switchTo(pick);
  }

  async _switchTo(targetId) {
    const prev = this.casting;
    this.activeId = targetId;
    this.lastSwitch = Date.now();
    this.emit('active', targetId);
    if (prev && prev.targetId !== targetId) {
      this.cdp?.send('Page.stopScreencast', {}, prev.sessionId).catch(() => {});
      this.casting = null;
    }
    const t = this.targets.get(targetId);
    if (!t || !this.cdp) return;
    if (!t.sessionId) await this._attach(targetId);
    if (!t.sessionId) return;
    this.casting = { targetId, sessionId: t.sessionId };
    // An immediate still so the viewer never stares at nothing, then the live stream.
    this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.opts.quality, optimizeForSpeed: true }, t.sessionId, 4000)
      .then(async (r) => {
        if (this.casting?.targetId !== targetId || !r?.data) return;
        const m = await this.cdp.send('Page.getLayoutMetrics', {}, t.sessionId, 2000).catch(() => null);
        const vp = m?.cssLayoutViewport || m?.layoutViewport;
        this._frame(targetId, { deviceWidth: vp?.clientWidth || 0, deviceHeight: vp?.clientHeight || 0, offsetTop: 0, pageScaleFactor: 1, timestamp: Date.now() / 1000, still: true }, r.data);
      })
      .catch(() => this.emit('background', targetId));
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: this.opts.quality, maxWidth: this.opts.maxWidth, maxHeight: this.opts.maxHeight, everyNthFrame: 1,
    }, t.sessionId).catch(() => {});
  }

  _frame(targetId, meta, b64) {
    const data = Buffer.from(b64, 'base64');
    this.lastFrame = { targetId, meta, data, ts: Date.now() };
    this.emit('frame', this.lastFrame);
  }

  pin(targetId) {
    this.pinnedId = targetId && this.targets.has(targetId) ? targetId : null;
    this.emit('status', this.publicStatus());
    this._chooseActive(true);
  }

  // ---------------------------------------------------------------- events
  _onEvent(method, p, sessionId) {
    const targetId = sessionId ? this.sessions.get(sessionId) : null;
    const t = targetId ? this.targets.get(targetId) : null;
    switch (method) {
      case 'Target.targetCreated': this._upsertTarget(p.targetInfo, this._booting); if (!this._booting) { this.emit('targets'); this._chooseActive(); } break;
      case 'Target.targetInfoChanged': {
        if (this._booting) { this._upsertTarget(p.targetInfo, true); break; }
        const before = this.targets.get(p.targetInfo.targetId)?.url;
        this._upsertTarget(p.targetInfo); this.emit('targets');
        if (before !== p.targetInfo.url) this._chooseActive();
        break;
      }
      case 'Target.targetDestroyed': {
        const old = this.targets.get(p.targetId);
        if (old) {
          this.targets.delete(p.targetId);
          if (old.sessionId) this.sessions.delete(old.sessionId);
          this.feed('tab', `Closed tab · ${old.title || shortUrl(old.url)}`, { targetId: p.targetId });
          if (this.pinnedId === p.targetId) this.pinnedId = null;
          if (this.activeId === p.targetId) { this.casting = null; this._chooseActive(true); }
          this.emit('targets');
        }
        break;
      }
      case 'Target.detachedFromTarget': {
        const tid = this.sessions.get(p.sessionId);
        this.sessions.delete(p.sessionId);
        const tt = tid && this.targets.get(tid);
        if (tt) { tt.sessionId = null; tt.attached = false; tt.isolated = null; }
        if (this.casting?.sessionId === p.sessionId) this.casting = null;
        break;
      }
      case 'Page.screencastFrame':
        this.cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
        if (targetId && this.casting?.targetId === targetId) {
          if (t) t.activity = Math.max(t.activity, Date.now() - 20_000); // painting = alive, but weak signal
          this._frame(targetId, p.metadata, p.data);
        }
        break;
      case 'Page.frameStartedLoading': if (t) { t.loading = true; t.loadStart = Date.now(); this.emit('targets'); } break;
      case 'Page.loadEventFired':
        if (t) {
          t.loading = false; t.activity = Math.max(t.activity, Date.now() - 2000);
          this._isolatedEval(t, 'document.title').then((tt) => { if (tt && tt !== t.title) { t.title = tt; this.emit('targets'); } });
          const ms = t.loadStart ? Date.now() - t.loadStart : null;
          this.feed('load', `Loaded ${t.title || shortUrl(t.url)}${ms ? ` in ${(ms / 1000).toFixed(1)}s` : ''}`, { targetId });
          this.emit('targets');
        }
        break;
      case 'Page.frameStoppedLoading': if (t) { t.loading = false; this.emit('targets'); } break;
      case 'Page.javascriptDialogOpening':
        this.feed('error', `${p.type} dialog: ${String(p.message || '').slice(0, 160)}`, { targetId, level: 'warn' });
        break;
      case 'Page.executionContextsCleared': if (t) t.isolated = null; break;
      case 'Network.requestWillBeSent': {
        if (!t) break;
        const key = `${sessionId}:${p.requestId}`;
        this.requests.set(key, { url: p.request.url, method: p.request.method, type: p.type, t0: Date.now(), targetId });
        t.net.requests++;
        if (p.type === 'Document' && p.frameId === p.loaderId) { /* main doc: shown via nav */ }
        if (this.requests.size > 5000) this.requests.delete(this.requests.keys().next().value);
        break;
      }
      case 'Network.responseReceived': {
        const r = this.requests.get(`${sessionId}:${p.requestId}`);
        if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
        break;
      }
      case 'Network.loadingFinished': {
        const key = `${sessionId}:${p.requestId}`;
        const r = this.requests.get(key);
        this.requests.delete(key);
        if (!r || !t) break;
        t.net.bytes += p.encodedDataLength || 0;
        const ms = Date.now() - r.t0;
        const bad = r.status >= 400;
        if (bad) t.net.failed++;
        if (bad || !NOISY_TYPES.has(r.type) && r.type !== 'Script') {
          this._netEvent(t, { level: bad ? 'error' : 'info', method: r.method, url: r.url, status: r.status, type: r.type, ms, bytes: p.encodedDataLength || 0 });
        }
        break;
      }
      case 'Network.loadingFailed': {
        const key = `${sessionId}:${p.requestId}`;
        const r = this.requests.get(key);
        this.requests.delete(key);
        if (!r || !t || p.canceled || p.errorText === 'net::ERR_ABORTED') break;
        t.net.failed++;
        this._netEvent(t, { level: 'error', method: r.method, url: r.url, status: 0, type: r.type, error: p.errorText, ms: Date.now() - r.t0 });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry;
        if (!t || !this._relevant(t) || (t.attachedAt && e.timestamp && e.timestamp < t.attachedAt - 500)) break;
        if (e.level === 'error' || (e.level === 'warning' && (e.source === 'security' || e.source === 'javascript'))) {
          this.feed('console', `${e.source}: ${String(e.text || '').slice(0, 300)}`, { targetId, level: e.level === 'error' ? 'error' : 'warn', url: e.url });
        }
        break;
      }
      case 'Runtime.consoleAPICalled': {
        if (!t || !this._relevant(t) || p.type !== 'error' && p.type !== 'warning') break;
        if (t.attachedAt && p.timestamp < t.attachedAt) break;
        const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300);
        this.feed('console', `console.${p.type}: ${text}`, { targetId, level: p.type === 'error' ? 'error' : 'warn' });
        break;
      }
      case 'Runtime.exceptionThrown': {
        if (!t || !this._relevant(t)) break;
        const d = p.exceptionDetails || {};
        this.feed('console', `Uncaught: ${(d.exception?.description || d.text || '').split('\n')[0].slice(0, 300)}`, { targetId, level: 'error' });
        break;
      }
    }
  }

  // Requests are summarized: documents/XHR/fetch individually (rate-limited), everything else rolled up per tab.
  // Background tabs (mail clients, dashboards) poll constantly; only the watched tab and tabs
  // touched in the last two minutes contribute network/console lines.
  _relevant(t) { return t && (t.targetId === this.activeId || Date.now() - (t.lastNav || 0) < 120_000); }

  _netEvent(t, r) {
    if (!this._relevant(t)) return;
    const now = Date.now();
    t._netWin = t._netWin && now - t._netWin.t < 2000 ? t._netWin : { t: now, n: 0, dropped: 0 };
    t._netWin.n++;
    if (r.level !== 'error' && t._netWin.n > 6) {
      t._netWin.dropped++;
      clearTimeout(t._netTimer);
      t._netTimer = setTimeout(() => {
        if (t._netWin?.dropped) this.feed('net', `+${t._netWin.dropped} more requests on ${hostOf(t.url)}`, { targetId: t.targetId, level: 'info', rollup: true });
        if (t._netWin) t._netWin.dropped = 0;
      }, 2100);
      return;
    }
    const st = r.status ? r.status : (r.error || 'failed').replace('net::', '');
    this.feed('net', `${r.method} ${shortUrl(r.url, 120)}`, {
      targetId: t.targetId, level: r.level, status: st, rtype: r.type, ms: r.ms, bytes: r.bytes, url: r.url,
    });
  }

  feed(kind, text, extra = {}) {
    const ev = Object.assign({ ts: Date.now(), kind, text }, extra);
    this.emit('feed', ev);
  }

  // ---------------------------------------------------------------- public state
  targetList() {
    return [...this.targets.values()]
      .filter((t) => !isInternal(t.url) || t.targetId === this.activeId)
      .sort((a, b) => b.activity - a.activity || b.created - a.created)
      .map((t) => ({
        id: t.targetId, title: t.title || shortUrl(t.url), url: t.url, host: hostOf(t.url), visible: !!t.visible,
        loading: !!t.loading, activity: t.activity || null, net: t.net, active: t.targetId === this.activeId, pinned: t.targetId === this.pinnedId,
      }));
  }

  // ---------------------------------------------------------------- take-over input (only called when a human holds control)
  async input(msg) {
    const c = this.casting; if (!c || !this.cdp) throw new Error('no active tab');
    const s = (m, p) => this.cdp.send(m, p, c.sessionId, 5000);
    const meta = this.lastFrame?.targetId === c.targetId ? this.lastFrame.meta : null;
    const W = meta?.deviceWidth || 1280, H = meta?.deviceHeight || 800;
    const x = Math.max(0, Math.min(W, (msg.x ?? 0) * W));
    const y = Math.max(0, Math.min(H, (msg.y ?? 0) * H));
    const t = this.targets.get(c.targetId); if (t) t.activity = Date.now();
    const modifiers = msg.modifiers | 0;
    switch (msg.type) {
      case 'mouse': {
        const typeMap = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
        if (msg.action === 'wheel') return s('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0, modifiers });
        const buttons = msg.action === 'move' ? (msg.buttons | 0) : 0;
        return s('Input.dispatchMouseEvent', { type: typeMap[msg.action], x, y, button: msg.button || (msg.action === 'move' ? 'none' : 'left'), buttons, clickCount: msg.clickCount || 1, modifiers });
      }
      case 'tap': {
        await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: msg.clickCount || 1 });
        return s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: msg.clickCount || 1 });
      }
      case 'key': {
        const p = { type: msg.action === 'up' ? 'keyUp' : (msg.text ? 'keyDown' : 'rawKeyDown'), key: msg.key, code: msg.code, modifiers,
          windowsVirtualKeyCode: msg.keyCode | 0, nativeVirtualKeyCode: msg.keyCode | 0 };
        if (msg.text && msg.action !== 'up') { p.text = msg.text; p.unmodifiedText = msg.text; }
        if (msg.commands) p.commands = msg.commands;
        return s('Input.dispatchKeyEvent', p);
      }
      case 'text': return s('Input.insertText', { text: String(msg.text || '').slice(0, 2000) });
      case 'nav': {
        if (msg.action === 'reload') return s('Page.reload', {});
        if (msg.action === 'goto') {
          let u = String(msg.url || '').trim(); if (!u) return;
          if (!/^[a-z]+:/i.test(u)) u = (/\s/.test(u) || !u.includes('.')) ? 'https://www.google.com/search?q=' + encodeURIComponent(u) : 'https://' + u;
          return s('Page.navigate', { url: u });
        }
        const h = await s('Page.getNavigationHistory', {});
        const idx = h.currentIndex + (msg.action === 'back' ? -1 : 1);
        if (h.entries[idx]) return s('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id });
        return;
      }
      case 'activate': {
        if (!this.targets.has(msg.targetId)) return;
        await this.cdp.send('Target.activateTarget', { targetId: msg.targetId });
        this.pin(msg.targetId);
        return;
      }
    }
  }
}
