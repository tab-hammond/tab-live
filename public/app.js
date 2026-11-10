/* Tab Live client. No build step, no dependencies. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.hash.slice(1));
  const TOKEN_KEY = 'tablive.token';
  let token = qs.get('token') || qs.get('t') || localStorage.getItem(TOKEN_KEY) || '';

  // ---------------------------------------------------------------- state
  const S = {
    ws: null, clientId: null, state: null, connected: false, retry: 0,
    view: 'browser', follow: true, feed: [], filter: 'all', errors: 0,
    frames: 0, fps: 0, rtt: null, lastFrameAt: 0, lastMeta: null, frameTarget: null,
    replay: { on: false, index: [], pos: 0, playing: false, speed: 4, timer: null },
    driving: false, pane: 'feed', bgTimer: null,
  };
  const canvas = $('screen'), ctx = canvas.getContext('2d', { alpha: false });

  // ---------------------------------------------------------------- auth
  function showLogin(err) {
    $('app').hidden = true; $('login').hidden = false; $('loginErr').hidden = !err;
    setTimeout(() => $('tokenInput').focus(), 50);
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('tokenInput').value.trim(); if (!t) return;
    const ok = await fetch('api/state', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.ok).catch(() => false);
    if (!ok) return showLogin(true);
    token = t; localStorage.setItem(TOKEN_KEY, t);
    // keep the code in the URL fragment so "Add to Home Screen" carries it; fragments never reach the network
    history.replaceState(null, '', location.pathname + '#token=' + encodeURIComponent(t));
    start();
  });

  // ---------------------------------------------------------------- utils
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'now'; if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd';
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : (n | 0) + ' B';
  function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function favEl(t, cls = 'fav') {
    const letter = (t.host || t.title || '?').replace(/^www\./, '')[0]?.toUpperCase() || '?';
    const img = document.createElement('img');
    img.className = cls; img.alt = ''; img.loading = 'lazy';
    if (t.id && /^https?:/.test(t.url || '')) img.src = `api/favicon?id=${encodeURIComponent(t.id)}&t=${encodeURIComponent(token)}&u=${encodeURIComponent(t.host || '')}`;
    img.onerror = () => {
      const d = document.createElement('div'); d.className = cls + ' letter'; d.textContent = letter;
      d.style.background = `hsl(${hue(t.host || t.title)} 55% 38%)`; img.replaceWith(d);
    };
    if (!img.src) setTimeout(img.onerror, 0);
    return img;
  }
  let toastT = null;
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
  const send = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };

  // ---------------------------------------------------------------- socket
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws?t=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    ws.onopen = () => { S.connected = true; S.retry = 0; send({ type: 'view', view: S.view }); renderStatus(); };
    ws.onmessage = (e) => (typeof e.data === 'string' ? onJSON(JSON.parse(e.data)) : onFrame(e.data));
    ws.onclose = (e) => {
      S.connected = false; S.ws = null; renderStatus();
      if (S.driving) setDriving(false);
      const delay = Math.min(10000, 500 * 2 ** S.retry++);
      // 401 shows up as an immediate close before open: check the token
      fetch('api/state', { headers: { Authorization: 'Bearer ' + token } }).then((r) => {
        if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); showLogin(true); } else setTimeout(connect, delay);
      }).catch(() => setTimeout(connect, delay));
    };
  }
  setInterval(() => send({ type: 'ping', t: performance.now() }), 3000);
  document.addEventListener('visibilitychange', () => {
    send({ type: 'pause', paused: document.hidden });
    if (!document.hidden && !S.ws) connect();
  });

  function onJSON(m) {
    switch (m.type) {
      case 'state': S.state = m; renderAll(); break;
      case 'hello': S.clientId = m.clientId; S.feed = m.feed || []; S.errors = S.feed.filter(isErr).length; renderFeed(true); break;
      case 'feed': addFeed(m.ev); break;
      case 'pong': S.rtt = performance.now() - m.t; break;
      case 'background': if (m.targetId === S.state?.activeId) armBackground(true); break;
      case 'error': toast(m.error); break;
    }
  }

  // ---------------------------------------------------------------- frames
  let drawing = false, pendingFrame = null;
  async function onFrame(buf) {
    const dv = new DataView(buf); const hl = dv.getUint32(0);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    send({ type: 'ack' }); // flow control: tells the server this frame arrived
    if (head.kind !== S.view || S.replay.on) return;
    pendingFrame = { head, blob: new Blob([new Uint8Array(buf, 4 + hl)], { type: 'image/jpeg' }) };
    if (!drawing) drawLoop();
  }
  async function drawLoop() {
    drawing = true;
    while (pendingFrame) {
      const f = pendingFrame; pendingFrame = null;
      try { await paint(f.blob); } catch { continue; }
      S.frames++; S.lastFrameAt = Date.now(); S.lastMeta = f.head.meta; S.frameTarget = f.head.targetId;
      if (f.head.kind === 'browser' && !f.head.meta?.still) armBackground(false);
    }
    drawing = false;
  }
  async function paint(blob) {
    const bmp = await createImageBitmap(blob);
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width; canvas.height = bmp.height;
      if (window.innerWidth < 1000) $('screenWrap').style.aspectRatio = `${bmp.width} / ${bmp.height}`;
    }
    ctx.drawImage(bmp, 0, 0); bmp.close?.();
  }
  setInterval(() => {
    S.fps = S.frames; S.frames = 0;
    const live = S.state?.status === 'live';
    const age = Date.now() - S.lastFrameAt;
    const parts = [];
    if (S.view === 'browser') parts.push(`${S.fps} fps`);
    if (S.rtt != null) parts.push(`${Math.round(S.rtt)} ms`);
    if (S.lastFrameAt && age > 4000) parts.push(`still ${ago(S.lastFrameAt)}`);
    $('statBadge').textContent = parts.join(' · ') || '—';
    $('liveBadge').classList.toggle('stale', !live || age > 15000);
    if (S.view === 'desktop' && S.lastMeta?.capturedAt) $('statBadge').textContent = `desktop · ${ago(S.lastMeta.capturedAt)}${S.rtt != null ? ' · ' + Math.round(S.rtt) + ' ms' : ''}`;
    tickTimes();
  }, 1000);
  // A tab that isn't painting (background, or a static page) sends no screencast frames.
  function armBackground(on) {
    clearTimeout(S.bgTimer);
    if (!on) { $('bgOverlay').hidden = true; return; }
    S.bgTimer = setTimeout(() => { if (Date.now() - S.lastFrameAt > 2500 && S.state?.status === 'live' && S.view === 'browser' && !S.replay.on) $('bgOverlay').hidden = false; }, 2500);
  }

  // ---------------------------------------------------------------- render
  function renderAll() { renderStatus(); renderTabs(); renderCurrent(); renderDrive(); renderViewers(); }
  function renderStatus() {
    const p = $('statusPill'); const st = S.state;
    p.className = 'pill';
    let text = 'Connecting';
    if (!S.connected) { p.classList.add('off'); text = 'Reconnecting'; }
    else if (st?.takeover) { p.classList.add('drive'); text = st.takeover.clientId === S.clientId ? 'You\u2019re driving' : `${st.takeover.by} driving`; }
    else if (st?.status === 'live') { p.classList.add('live'); text = 'Live'; }
    else if (st) { p.classList.add('idle'); text = st.status === 'connecting' ? 'Looking for browser' : 'Idle'; }
    $('statusText').textContent = text;
    $('brandName').textContent = st?.name || 'Tab';
    document.title = `${st?.name || 'Tab'} Live${st?.status === 'live' ? '' : ' · idle'}`;
    const idle = st && st.status !== 'live' && S.view === 'browser';
    $('idleOverlay').hidden = !idle;
    if (idle) $('idleText').textContent = st.lastSeen ? `Last seen ${ago(st.lastSeen)} ago. This view lights up the moment it starts again.` : 'Waiting for the browser to start. This view lights up on its own.';
    if (S.view === 'desktop') {
      const d = st?.desktop;
      if (d && !d.available) { $('idleOverlay').hidden = false; $('idleText').textContent = 'No desktop frames yet. On the Mac, switch on \u201cTab Live Capture\u201d in System Settings \u203a Privacy & Security \u203a Screen & System Audio Recording (one time).'; }
    }
  }
  function curTarget() { return S.state?.targets?.find((t) => t.id === S.state.activeId); }
  let lastFavFor = null;
  function renderCurrent() {
    const t = curTarget();
    if (S.view === 'desktop') {
      $('curTitle').textContent = 'Whole desktop'; $('curUrl').textContent = 'Everything on screen in the agent\u2019s session';
      $('curSpin').hidden = true; return;
    }
    $('curTitle').textContent = t ? (t.title || t.host || 'New tab') : (S.state?.status === 'live' ? 'No tab open' : 'Waiting for the browser\u2026');
    $('curUrl').textContent = t ? t.url : '';
    $('curSpin').hidden = !t?.loading;
    const key = t ? t.id + t.host : null;
    if (key !== lastFavFor) { lastFavFor = key; const f = t ? favEl(t) : Object.assign(document.createElement('img'), { className: 'fav' }); f.id = 'curFav'; $('curFav').replaceWith(f); }
    if (S.driving && document.activeElement !== $('urlInput')) $('urlInput').value = t?.url && t.url !== 'about:blank' ? t.url : '';
  }
  const tabEls = new Map();
  function renderTabs() {
    const list = S.state?.targets || [];
    $('tabCount').textContent = list.length; $('tabCount2').textContent = list.length;
    const ul = $('tabList');
    const seen = new Set();
    list.forEach((t, i) => {
      seen.add(t.id);
      let li = tabEls.get(t.id);
      if (!li) {
        li = document.createElement('li'); li.className = 'tab-item'; li.dataset.id = t.id;
        li.innerHTML = '<span class="favslot"></span><div class="meta"><div class="t"></div><div class="u"></div></div><div class="side"></div>';
        li.addEventListener('click', () => onTabClick(t.id));
        tabEls.set(t.id, li);
      }
      if (li._host !== t.host) { li._host = t.host; li.querySelector('.favslot').replaceChildren(favEl(t)); }
      li.querySelector('.t').textContent = t.title || 'New tab';
      li.querySelector('.u').textContent = t.host || t.url;
      li.classList.toggle('active', t.active);
      const tags = [];
      if (t.loading) tags.push('<div class="spinner mini-spin"></div>');
      if (t.pinned) tags.push('<span class="tag pin">PINNED</span>');
      else if (t.active) tags.push('<span class="tag">WATCHING</span>');
      else if (t.visible) tags.push('<span class="tag vis">FRONT</span>');
      tags.push(`<span class="ago" data-ts="${t.activity || ''}">${t.activity ? ago(t.activity) : ''}</span>`);
      li.querySelector('.side').innerHTML = tags.join('');
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    });
    for (const [id, li] of tabEls) if (!seen.has(id)) { li.remove(); tabEls.delete(id); }
    S.follow = !S.state?.pinnedId;
    $('followBtn').classList.toggle('on', S.follow);
  }
  function onTabClick(id) {
    if (S.view !== 'browser') setView('browser');
    if (S.driving) send({ type: 'activate', targetId: id }); // brings it to the front for real
    else send({ type: 'pin', targetId: id });                  // only changes what you watch
    if (window.innerWidth < 1000) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('followBtn').addEventListener('click', () => send({ type: 'pin', targetId: S.follow ? S.state?.activeId : null }));

  function renderViewers() {
    const v = S.state?.viewers || [];
    $('viewersCount').textContent = v.length;
    $('viewersList').innerHTML = v.map((x) => `<li><span>${esc(x.label)}${x.id === S.clientId ? ' (this device)' : ''}</span><span style="color:var(--dim)">${esc(x.view)}</span></li>`).join('');
    const st = S.state;
    $('sheetMeta').innerHTML = st ? [
      st.browser ? `Browser: ${esc(st.browser)}` : 'Browser: not connected',
      `Rewind buffer: ${st.replay.frames ? `${Math.round((Date.now() - st.replay.from) / 60000)} of ${st.replay.minutes} min` : 'empty'}`,
      `Console capture: ${st.fullConsole ? 'full' : 'stealth-safe (no Runtime domain)'}`,
    ].join('<br>') : '';
  }
  $('viewersBtn').addEventListener('click', () => { renderViewers(); $('viewersSheet').hidden = false; });
  $('sheetClose').addEventListener('click', () => ($('viewersSheet').hidden = true));
  $('viewersSheet').addEventListener('click', (e) => { if (e.target.id === 'viewersSheet') e.target.hidden = true; });

  // ---------------------------------------------------------------- feed
  const isErr = (e) => e.level === 'error';
  function matches(e) {
    if (S.filter === 'all') return true;
    if (S.filter === 'error') return e.level === 'error' || e.kind === 'console';
    if (S.filter === 'nav') return e.kind === 'nav' || e.kind === 'load' || e.kind === 'tab' || e.kind === 'takeover';
    if (S.filter === 'net') return e.kind === 'net';
    return true;
  }
  const ICONS = {
    nav: '<svg viewBox="0 0 24 24"><path d="M5 12h12M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>',
    load: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8"/></svg>',
    tab: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M3 9h18" stroke="currentColor" stroke-width="2.4"/></svg>',
    net: '<svg viewBox="0 0 24 24"><path d="M7 4v13M3 13l4 4 4-4M17 20V7M13 11l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
    console: '<svg viewBox="0 0 24 24"><path d="M12 4v10M12 18v2" stroke="currentColor" stroke-width="3"/></svg>',
    takeover: '<svg viewBox="0 0 24 24"><path d="M9 3v10l-2-2a2 2 0 0 0-3 3l5 5a6 6 0 0 0 4 2h2a5 5 0 0 0 5-5v-4a2 2 0 0 0-4 0V9a2 2 0 0 0-4 0V3a2 2 0 0 0-3 0Z"/></svg>',
    browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  };
  function evEl(e) {
    const li = document.createElement('li');
    li.className = `ev k-${e.kind} lv-${e.level || 'info'}`;
    const subs = [];
    if (e.kind === 'net') {
      const ok = typeof e.status === 'number' && e.status < 400;
      if (e.status !== undefined) subs.push(`<span class="st ${ok ? 'ok' : 'bad'}">${esc(e.status)}</span>`);
      if (e.rtype) subs.push(esc(e.rtype));
      if (e.ms != null) subs.push(e.ms + ' ms');
      if (e.bytes) subs.push(bytes(e.bytes));
    }
    const t = e.targetId && S.state?.targets?.find((x) => x.id === e.targetId);
    if (t && e.kind === 'console') subs.push(esc(t.host || t.title));
    li.innerHTML = `<time data-ts="${e.ts}" title="${new Date(e.ts).toLocaleString()}">${clock(e.ts)}</time><span class="ic">${ICONS[e.kind] || ICONS.browser}</span><div class="body">${esc(e.text)}${subs.length ? `<div class="sub">${subs.join('<span>·</span>')}</div>` : ''}</div>`;
    if (e.url) li.title = e.url;
    if (e.targetId) li.addEventListener('click', () => S.state?.targets?.some((x) => x.id === e.targetId) && onTabClick(e.targetId));
    return li;
  }
  function renderFeed(full) {
    const ul = $('feed');
    const items = S.feed.filter(matches).slice(-250).reverse();
    ul.replaceChildren(...items.map(evEl));
    if (!items.length) ul.innerHTML = '<li class="feed-empty">Nothing yet. Activity shows up here as it happens.</li>';
    $('errCount').hidden = !S.errors; $('errCount').textContent = S.errors;
  }
  function addFeed(e) {
    S.feed.push(e); if (S.feed.length > 1500) S.feed.splice(0, 300);
    if (isErr(e)) { S.errors++; $('errCount').hidden = false; $('errCount').textContent = S.errors; }
    if (!matches(e)) return;
    const ul = $('feed'); ul.querySelector('.feed-empty')?.remove();
    ul.insertBefore(evEl(e), ul.firstChild);
    while (ul.children.length > 250) ul.lastChild.remove();
  }
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.filter = b.dataset.f; [...$('filters').children].forEach((x) => x.classList.toggle('on', x === b));
    if (S.filter === 'error') { S.errors = 0; }
    renderFeed(true);
  });
  function tickTimes() { document.querySelectorAll('.tab-item .ago').forEach((el) => { if (el.dataset.ts) el.textContent = ago(+el.dataset.ts); }); }

  // ---------------------------------------------------------------- view switch
  function setView(v) {
    if (S.replay.on) exitReplay();
    S.view = v; S.lastFrameAt = 0; S.lastMeta = null;
    [...$('viewSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    $('bgOverlay').hidden = true;
    send({ type: 'view', view: v });
    if (v === 'desktop' && S.driving) setDriving(false);
    $('takeBtn').hidden = v === 'desktop'; $('rewindBtn').hidden = v === 'desktop';
    renderStatus(); renderCurrent();
  }
  $('viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
  $('mobileSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.pane = b.dataset.pane; [...$('mobileSwitch').children].forEach((x) => x.classList.toggle('on', x === b));
    $('feedPane').classList.toggle('mobile-hidden', S.pane !== 'feed'); $('tabsPane').classList.toggle('mobile-hidden', S.pane !== 'tabs');
  });
  $('tabsPane').classList.add('mobile-hidden');

  // ---------------------------------------------------------------- full screen
  $('fsBtn').addEventListener('click', () => {
    const on = !document.body.classList.contains('fs');
    document.body.classList.toggle('fs', on);
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (on) $('screenWrap').style.aspectRatio = ''; else if (canvas.width && window.innerWidth < 1000) $('screenWrap').style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('fs'); });

  // ---------------------------------------------------------------- take over
  function renderDrive() {
    const tk = S.state?.takeover;
    const mine = !!tk && tk.clientId === S.clientId;
    if (S.driving !== mine) setDriving(mine, true);
    $('controlBanner').hidden = !tk;
    $('controlBanner').classList.toggle('other', !!tk && !mine);
    $('controlText').textContent = mine ? 'You\u2019re in control' : tk ? `${tk.by} is in control` : '';
    $('takeText').textContent = mine ? 'Hand back' : 'Take over';
    $('takeBtn').classList.toggle('on', mine);
  }
  function setDriving(on, fromServer) {
    S.driving = on;
    $('screenWrap').classList.toggle('driving', on);
    $('driveBar').hidden = !on;
    if (on) { canvas.focus({ preventScroll: true }); renderCurrent(); }
    if (!fromServer) send({ type: 'takeover', on });
  }
  $('takeBtn').addEventListener('click', () => {
    if (S.replay.on) exitReplay();
    const tk = S.state?.takeover;
    if (tk && tk.clientId !== S.clientId) {
      if (!confirm(`${tk.by} is in control. Take it from them?`)) return;
      send({ type: 'takeover', on: true, force: true }); return;
    }
    if (!S.driving && navigator.vibrate) navigator.vibrate(15);
    setDriving(!S.driving);
  });
  $('driveBar').addEventListener('click', (e) => { const b = e.target.closest('[data-nav]'); if (b) send({ type: 'nav', action: b.dataset.nav }); });
  $('urlForm').addEventListener('submit', (e) => { e.preventDefault(); send({ type: 'nav', action: 'goto', url: $('urlInput').value }); $('urlInput').blur(); });

  // pointer -> normalized coordinates inside the drawn image (canvas uses object-fit: contain)
  function norm(ev) {
    const r = canvas.getBoundingClientRect();
    const cw = canvas.width || 1, ch = canvas.height || 1;
    const scale = Math.min(r.width / cw, r.height / ch);
    const w = cw * scale, h = ch * scale, ox = (r.width - w) / 2, oy = (r.height - h) / 2;
    return { x: (ev.clientX - r.left - ox) / w, y: (ev.clientY - r.top - oy) / h };
  }
  const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BTN = ['left', 'middle', 'right'];
  let touch = null, moveQueued = null, lastClick = { t: 0, x: 0, y: 0, n: 1 };
  canvas.addEventListener('contextmenu', (e) => S.driving && e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!S.driving) return;
    e.preventDefault(); canvas.focus({ preventScroll: true });
    const p = norm(e);
    if (e.pointerType === 'touch') { touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, p, moved: false, t0: Date.now() }; return; }
    canvas.setPointerCapture(e.pointerId);
    const now = Date.now();
    const n = now - lastClick.t < 400 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 0.01 ? lastClick.n + 1 : 1;
    lastClick = { t: now, x: p.x, y: p.y, n };
    send({ type: 'mouse', action: 'down', ...p, button: BTN[e.button] || 'left', clickCount: n, modifiers: mods(e) });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!S.driving) return;
    if (e.pointerType === 'touch' && touch && e.pointerId === touch.id) {
      e.preventDefault();
      const dy = e.clientY - touch.ly, dx = e.clientX - touch.lx;
      if (Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) > 8) touch.moved = true;
      if (touch.moved) {
        const r = canvas.getBoundingClientRect(); const k = (canvas.width / r.width) * 1.6;
        send({ type: 'mouse', action: 'wheel', ...touch.p, deltaX: -dx * k, deltaY: -dy * k });
      }
      touch.lx = e.clientX; touch.ly = e.clientY; return;
    }
    if (e.pointerType === 'touch') return;
    const p = norm(e);
    const was = moveQueued; moveQueued = { ...p, buttons: e.buttons, modifiers: mods(e) };
    if (!was) requestAnimationFrame(() => { const m = moveQueued; moveQueued = null; if (m) send({ type: 'mouse', action: 'move', ...m }); });
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!S.driving) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {
      if (touch && !touch.moved && e.pointerId === touch.id) send({ type: 'tap', ...touch.p });
      touch = null; return;
    }
    send({ type: 'mouse', action: 'up', ...norm(e), button: BTN[e.button] || 'left', clickCount: lastClick.n, modifiers: mods(e) });
  });
  canvas.addEventListener('wheel', (e) => {
    if (!S.driving) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    send({ type: 'mouse', action: 'wheel', ...norm(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k, modifiers: mods(e) });
  }, { passive: false });

  // keyboard (desktop): forward while the canvas has focus
  const MAC_CMDS = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' };
  function keyMsg(e, action) {
    const m = { type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) };
    if (action === 'down' && e.key.length === 1 && !e.ctrlKey && !e.metaKey) m.text = e.key;
    if (action === 'down' && e.key === 'Enter') m.text = '\r';
    if (action === 'down' && (e.metaKey || e.ctrlKey) && MAC_CMDS[e.key.toLowerCase()]) m.commands = [e.shiftKey && e.key.toLowerCase() === 'z' ? 'redo' : MAC_CMDS[e.key.toLowerCase()]];
    return m;
  }
  canvas.addEventListener('keydown', (e) => {
    if (!S.driving) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return; // let the paste event carry the text
    e.preventDefault(); send(keyMsg(e, 'down'));
  });
  canvas.addEventListener('keyup', (e) => { if (S.driving) { e.preventDefault(); send(keyMsg(e, 'up')); } });
  document.addEventListener('paste', (e) => {
    if (!S.driving || document.activeElement === $('urlInput')) return;
    const text = e.clipboardData?.getData('text'); if (text) { e.preventDefault(); send({ type: 'text', text }); }
  });

  // keyboard (phone): a hidden input raises the on-screen keyboard; typed text goes through insertText
  $('kbBtn').addEventListener('click', () => { const k = $('kbInput'); k.value = ''; k.focus(); });
  $('kbInput').addEventListener('input', (e) => {
    const k = e.target;
    if (e.inputType === 'deleteContentBackward') send({ type: 'key', action: 'down', key: 'Backspace', code: 'Backspace', keyCode: 8 }), send({ type: 'key', action: 'up', key: 'Backspace', code: 'Backspace', keyCode: 8 });
    else if (e.data) send({ type: 'text', text: e.data });
    k.value = ' '; // keep something to delete so Backspace keeps firing
  });
  $('kbInput').addEventListener('keydown', (e) => {
    const special = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
    if (special[e.key]) {
      e.preventDefault();
      send({ type: 'key', action: 'down', key: e.key, code: e.key, keyCode: special[e.key], text: e.key === 'Enter' ? '\r' : undefined });
      send({ type: 'key', action: 'up', key: e.key, code: e.key, keyCode: special[e.key] });
    }
  });

  // ---------------------------------------------------------------- rewind
  async function enterReplay() {
    const idx = await fetch('api/replay/index', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json()).catch(() => []);
    if (!idx.length) return toast('Nothing recorded yet. Rewind fills up as the browser works.');
    if (S.driving) setDriving(false);
    S.replay.on = true; S.replay.index = idx;
    $('replayBar').hidden = false; $('replayBadge').hidden = false; $('screenWrap').classList.add('replaying'); $('rewindBtn').classList.add('on');
    $('bgOverlay').hidden = true; $('idleOverlay').hidden = true;
    const sl = $('replaySlider'); sl.max = idx.length - 1; sl.value = Math.max(0, idx.length - 1 - 60 * (S.state?.replay?.minutes ? 2 : 2));
    showReplay(+sl.value);
  }
  const replayCache = new Map();
  function replayBlob(seq) {
    if (!replayCache.has(seq)) {
      replayCache.set(seq, fetch(`api/replay/frame/${seq}`, { headers: { Authorization: 'Bearer ' + token } }).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
      if (replayCache.size > 400) replayCache.delete(replayCache.keys().next().value);
    }
    return replayCache.get(seq);
  }
  async function showReplay(i) {
    const f = S.replay.index[i]; if (!f) return;
    S.replay.pos = i;
    const [seq, ts, , title] = f;
    $('replayTime').textContent = `${clock(ts)} · ${ago(ts)} ago`;
    $('curTitle').textContent = title || 'Recorded frame';
    for (let k = 1; k <= 6; k++) { const n = S.replay.index[i + k]; if (n) replayBlob(n[0]); }
    const b = await replayBlob(seq);
    if (b && S.replay.on && S.replay.pos === i) await paint(b).catch(() => {});
  }
  function exitReplay() {
    S.replay.on = false; stopPlay();
    $('replayBar').hidden = true; $('replayBadge').hidden = true; $('screenWrap').classList.remove('replaying'); $('rewindBtn').classList.remove('on');
    renderCurrent(); renderStatus();
    send({ type: 'view', view: S.view }); // ask for a fresh live frame
  }
  function stopPlay() { S.replay.playing = false; clearTimeout(S.replay.timer); $('playIcon').innerHTML = '<path d="M7 4l13 8-13 8V4Z"/>'; }
  function playStep() {
    if (!S.replay.playing) return;
    const i = S.replay.pos + 1;
    if (i >= S.replay.index.length) { stopPlay(); return; }
    $('replaySlider').value = i; showReplay(i);
    const dt = (S.replay.index[i + 1]?.[1] ?? S.replay.index[i][1] + 500) - S.replay.index[i][1];
    S.replay.timer = setTimeout(playStep, Math.max(30, Math.min(1500, dt / S.replay.speed)));
  }
  $('rewindBtn').addEventListener('click', () => (S.replay.on ? exitReplay() : enterReplay()));
  $('toLiveBtn').addEventListener('click', exitReplay);
  $('replaySlider').addEventListener('input', (e) => { stopPlay(); showReplay(+e.target.value); });
  $('playBtn').addEventListener('click', () => {
    if (S.replay.playing) return stopPlay();
    S.replay.playing = true; $('playIcon').innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; playStep();
  });
  $('speedBtn').addEventListener('click', () => {
    const order = [1, 2, 4, 8, 16]; S.replay.speed = order[(order.indexOf(S.replay.speed) + 1) % order.length];
    $('speedBtn').textContent = S.replay.speed + '×';
  });

  // ---------------------------------------------------------------- boot
  function start() {
    $('login').hidden = true; $('app').hidden = false;
    renderFeed(true); connect();
  }
  if (!token) showLogin(false);
  else {
    localStorage.setItem(TOKEN_KEY, token);
    if (!qs.get('token') && !qs.get('t')) history.replaceState(null, '', location.pathname + '#token=' + encodeURIComponent(token));
    start();
  }
  window.addEventListener('resize', () => { if (window.innerWidth >= 1000) $('screenWrap').style.aspectRatio = ''; else if (canvas.width) $('screenWrap').style.aspectRatio = `${canvas.width} / ${canvas.height}`; });
})();
