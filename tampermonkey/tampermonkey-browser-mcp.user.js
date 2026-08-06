// ==UserScript==
// @name         TabBridge MCP Browser Bridge
// @namespace    local.tampermonkey-browser-mcp
// @version      1.0.4
// @description  Cross-platform local MCP executor for explicitly enabled ordinary browser tabs.
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const bridge = 'http://127.0.0.1:18475';
  const tabStatePrefix = 'tabbridge-mcp:';
  function readTabState() {
    if (!window.name.startsWith(tabStatePrefix)) return null;
    try { return JSON.parse(window.name.slice(tabStatePrefix.length)); } catch { return null; }
  }
  function writeTabState(state) {
    try { window.name = `${tabStatePrefix}${JSON.stringify(state)}`; } catch { /* some pages guard window.name */ }
  }
  const storedTabState = readTabState();
  const legacyClientId = sessionStorage.getItem('tm-browser-mcp-client');
  const clientId = storedTabState?.clientId || legacyClientId || crypto.randomUUID();
  // enabled is PER-TAB, recovered from window.name (survives cross-origin
  // navigation) with sessionStorage as a same-origin fallback. A NEW tab that
  // has neither uses a global DEFAULT preference (GM storage) — default on, so
  // a fresh tab is immediately usable without clicking the toggle. Manually
  // toggling a tab writes window.name/sessionStorage and overrides the default
  // for that tab.
  let enabled;
  if (storedTabState) {
    enabled = storedTabState.enabled === true;
  } else if (sessionStorage.getItem('tm-browser-mcp-enabled') != null) {
    enabled = sessionStorage.getItem('tm-browser-mcp-enabled') === 'true';
  } else {
    enabled = defaultEnabledPref(); // GM-stored default for brand-new tabs (on by default)
  }
  let tabState = { ...(storedTabState || {}), clientId, enabled };
  function updateTabState(patch) {
    tabState = { ...tabState, ...patch };
    writeTabState(tabState);
  }
  updateTabState({ clientId, enabled });
  let busy = false;

  // No floating button: per-tab state is controlled entirely through the
  // Tampermonkey menu (GM_registerMenuCommand). This keeps the page untouched
  // and avoids any overlay/click issues.
  function paint(/* note = '' */) { /* state shown via menu label only */ }
  function setEnabled(value) {
    enabled = value;
    sessionStorage.setItem('tm-browser-mcp-enabled', String(enabled));
    updateTabState({ enabled });
    paint();
    if (enabled) schedulePoll();
  }
  // Menu command shows the live per-tab state and toggles it. Re-register
  // after each toggle so the label always reflects the current state.
  let menuCmdId = null;
  let menuDefaultId = null;
  function defaultEnabledPref() {
    try { return typeof GM_getValue === 'function' ? GM_getValue('tm-browser-mcp-default-enabled', true) !== false : true; } catch { return true; }
  }
  function registerMenu() {
    if (typeof GM_unregisterMenuCommand === 'function') {
      if (menuCmdId != null) { try { GM_unregisterMenuCommand(menuCmdId); } catch { /* ignore */ } }
      if (menuDefaultId != null) { try { GM_unregisterMenuCommand(menuDefaultId); } catch { /* ignore */ } }
    }
    const label = `Browser MCP for this tab: ${enabled ? 'ON' : 'OFF'} (click to toggle)`;
    menuCmdId = GM_registerMenuCommand(label, () => { setEnabled(!enabled); registerMenu(); });
    const defOn = defaultEnabledPref();
    menuDefaultId = GM_registerMenuCommand(`Default for new tabs: ${defOn ? 'ON' : 'OFF'} (click to switch)`, () => {
      const next = !defaultEnabledPref();
      try { if (typeof GM_setValue === 'function') GM_setValue('tm-browser-mcp-default-enabled', next); } catch { /* ignore */ }
      registerMenu();
    });
  }
  registerMenu();
  paint();

  function api(method, pathname, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: `${bridge}${pathname}`, data: data ? JSON.stringify(data) : undefined,
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      onload: (response) => {
        try {
          const parsed = JSON.parse(response.responseText);
          if (response.status >= 400) throw new Error(parsed.error || `HTTP ${response.status}`);
          resolve(parsed);
        } catch (error) { reject(error); }
      },
      onerror: () => reject(new Error('Bridge is not running')),
    }));
  }
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const validSelector = (value) => typeof value === 'string' && value.length > 0 && value.length <= 500;
  // Wait for async-rendered content before extracting (v1.0.1). SPA pages
  // (IEEE Xplore search, Angular apps) fill their DOM AFTER navigate; a read
  // issued too early returns an empty shell even though the page looks loaded.
  // Default waits for the page to be ready: with a caller-supplied content
  // selector, poll until it matches; otherwise wait for the document load.
  // force:true skips the wait and returns the current view immediately.
  // Bounded by waitMs; never throws on timeout — the extract then sees whatever
  // is actually there. Low-level timing only, no judgment.
  function waitForReady(plan) {
    const query = (plan && plan.query) || {};
    if (query.force === true) return Promise.resolve();
    const maxMs = Math.min(Math.max(Number(query.waitMs) || 10000, 250), 25000);
    const selector = validSelector(query.selector) ? query.selector : null;
    if (!selector && document.readyState === 'complete') return Promise.resolve();
    const deadline = Date.now() + maxMs;
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); resolve(); };
      const check = () => {
        if (Date.now() >= deadline) return done();
        if (selector) {
          try { if (document.querySelector(selector)) return done(); } catch { return done(); }
        } else if (document.readyState === 'complete') {
          return done();
        }
        timer = setTimeout(check, 200);
      };
      check();
    });
  }
  const attentionRequired = () => {
    const title = document.title.toLowerCase();
    if (/captcha|verify.*human|sign in|log in/.test(title)) return true;
    // Only a VISIBLE login/captcha element is a real wall. Hidden sign-in
    // modals (e.g. IEEE "Sign In to Save Your Search") embed password inputs
    // in collapsed dialogs that are never shown — flagging them made every
    // IEEE search read report "blocked" even though the content is complete.
    // `visible` is defined below; this is only invoked at job runtime.
    const markers = 'input[type="password"], iframe[src*="captcha"], [class*="captcha"], [id*="captcha"]';
    return [...document.querySelectorAll(markers)].some(visible);
  };
  function pageState() {
    return {
      url: location.href,
      title: document.title,
      attentionRequired: attentionRequired(),
      // Raw browser geometry (v1.0.4): the viewport size every rect is relative
      // to. Server-side inViewport/salience/point need the ACTUAL window size —
      // a hardcoded fallback is wrong on any other display. Pure collection, no
      // judgment, so this stays within the frozen contract (FROZEN-INTERFACE).
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }
  function bounded(value, limit) { return clean(value).slice(0, Math.min(Number(limit) || 1000, 8000)); }
  // Physical-state collectors (geometry + flattened ancestor chain). These
  // report browser-only facts; interpretation stays on the local MCP server.
  function geometry(item) {
    if (!item || item.nodeType !== Node.ELEMENT_NODE) return null;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }
  function flatPath(item, maxDepth = 8) {
    const parts = [];
    let el = item;
    while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < maxDepth) {
      // SVG elements expose classList as SVGAnimatedString (baseVal), which is
      // not iterable — guard so extraction never throws on icon-heavy pages.
      let classes = [];
      try {
        const list = el.classList;
        if (list && typeof list.length === 'number' && typeof list.item === 'function') {
          for (let i = 0; i < list.length; i += 1) classes.push(String(list.item(i)));
        } else if (typeof list === 'string') classes = [list];
      } catch { /* ignore class collection errors */ }
      classes = classes.slice(0, 3);
      let nth = null;
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === el.tagName);
        if (same.length > 1) nth = same.indexOf(el) + 1;
      }
      parts.push({ tag: el.tagName.toLowerCase(), id: el.id || null, class: classes, nth });
      el = parent;
    }
    return parts;
  }
  function property(item, name) {
    if (!item) return null;
    if (name === 'text') return bounded(item.innerText || item.textContent || item.value, 240);
    if (name === 'href') return item.href || item.getAttribute('href') || null;
    if (name === 'tag') return item.tagName.toLowerCase();
    if (name === 'rect') return geometry(item);
    if (name === 'isDisplayed') return visible(item);
    if (name === 'disabled') return item.disabled === true || item.hasAttribute('disabled');
    if (name === 'checked') return item.checked === true;
    if (name === 'value') return item.value != null ? String(item.value) : null;
    if (name === 'type') return item.getAttribute('type') || (item.type != null ? String(item.type) : null);
    if (name === 'role') return item.getAttribute('role') || null;
    if (name === 'path') return flatPath(item);
    return item.getAttribute(name) || item[name] || null;
  }
  function visible(item) {
    if (!item || item.nodeType !== Node.ELEMENT_NODE) return false;
    const style = getComputedStyle(item);
    return style.display !== 'none' && style.visibility !== 'hidden' && item.getClientRects().length > 0;
  }
  function excluded(item) {
    return ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(item?.tagName);
  }
  function matches(item, query) {
    if (excluded(item)) return false;
    if (query.visible === true && !visible(item)) return false;
    if (query.contains && !clean(item.innerText || item.textContent || item.value).toLowerCase().includes(String(query.contains).toLowerCase())) return false;
    return true;
  }
  function cleanedText(item, limit) {
    if (!item) return '';
    const copy = item.cloneNode(true);
    copy.querySelectorAll('script, style, noscript, template, [hidden]').forEach((node) => node.remove());
    return bounded(copy.textContent, limit);
  }
  function extract(plan) {
    const fields = Array.isArray(plan?.fields) ? plan.fields.slice(0, 20) : [];
    const query = plan?.query || {};
    const data = {};
    for (const field of fields) {
      if (!field || typeof field.key !== 'string' || !validSelector(field.selector)) continue;
      const limit = Math.min(Number(field.limit) || 20, 250);
      if (field.kind === 'text') {
        const item = document.querySelector(field.selector);
        data[field.key] = matches(item, query) ? cleanedText(item, field.limit) : '';
      }
      if (field.kind === 'attribute') {
        const item = document.querySelector(field.selector);
        data[field.key] = matches(item, query) ? property(item, field.attribute || 'text') : null;
      }
      if (field.kind === 'list') {
        const properties = Array.isArray(field.properties) ? field.properties.slice(0, 24) : ['text'];
        const offset = Math.max(Number(query.offset) || 0, 0);
        const wanted = Math.min(Number(query.limit) || limit, 250);
        data[field.key] = [...document.querySelectorAll(field.selector)].slice(0, 5000).filter((item) => matches(item, query)).slice(offset, offset + wanted).map((item) => Object.fromEntries(properties.map((name) => [name, property(item, name)])));
      }
    }
    return { ...pageState(), data };
  }
  function inspect(mode, limit) {
    const max = Math.min(Number(limit) || 4000, mode === 'html' ? 24000 : 12000);
    return { ...pageState(), [mode === 'html' ? 'html' : 'text']: (mode === 'html' ? document.documentElement.outerHTML : document.body?.innerText || '').slice(0, max) };
  }
  function navigate(url) {
    const target = new URL(url, location.href);
    if (!/^https?:$/.test(target.protocol)) throw new Error('Only HTTP and HTTPS navigation is allowed');
    if (location.href !== target.href) location.assign(target.href);
  }
  function fill(selector, value) {
    if (!validSelector(selector)) throw new Error('Invalid selector');
    const item = document.querySelector(selector);
    if (!item) throw new Error('Element not found');
    item.focus();
    if (item.isContentEditable) item.textContent = value;
    else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(item, value) : (item.value = value);
    }
    item.dispatchEvent(new Event('input', { bubbles: true }));
    item.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function click(selector) {
    if (!validSelector(selector)) throw new Error('Invalid selector');
    const item = document.querySelector(selector);
    if (!item) throw new Error('Element not found');
    item.click();
  }
  function safeFilename(value, fallback = 'download') {
    const name = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180);
    return name || fallback;
  }
  // Derive a useful filename from a download URL: IEEE stamp.jsp?arnumber=…
  // and /document/123 patterns map to "<id>.pdf", plain paths keep their last
  // segment, everything else falls back to 'download'.
  function filenameFromUrl(value) {
    try {
      const u = new URL(value, location.href);
      const arnumber = u.searchParams.get('arnumber');
      if (arnumber) return `${arnumber}.pdf`;
      const m = u.pathname.match(/(\d+)\/?$/);
      if (m) return `${m[1]}.pdf`;
      const last = decodeURIComponent(u.pathname.split('/').pop() || '');
      if (last && /\.\w{2,5}$/.test(last)) return last;
      return 'download';
    } catch { return 'download'; }
  }
  async function reportProgress(jobId, receivedBytes, totalBytes, phase = 'downloading') {
    try {
      await api('POST', '/progress', { jobId, clientId, receivedBytes, totalBytes, phase });
    } catch { /* Progress reporting must not interrupt the browser download. */ }
  }
  // Detect a bot-management / paywall response masquerading as a download.
  // Publishers serve an HTML/JS challenge (IEEE APM_DO_NOT_TOUCH, Cloudflare
  // "Just a moment", reCAPTCHA) to script-initiated downloads even when the
  // browser session is valid. Saving that HTML would silently write garbage —
  // fail loudly instead so the caller routes to real sign-in / manual access.
  async function challengeFrom(blob, contentType, url) {
    if (!/text\/html|application\/javascript|text\/javascript/i.test(contentType || '')) return null;
    const head = await blob.slice(0, 2000).text();
    if (/APM_DO_NOT_TOUCH|Just a moment|cf-browser|challenge-platform|g-recaptcha|hcaptcha|verify|puzzle/i.test(head)) {
      return { reason: 'bot-check', detail: (head.match(/\S{3,40}/g) || []).slice(0, 4).join(' ') };
    }
    // A download URL that returns HTML it was not asked to download is a wall.
    if (/\.(pdf|zip|docx?|xlsx?|tar|gz)\b/i.test(url) && /<html|<head|<body/i.test(head)) {
      return { reason: 'not-a-file', detail: contentType };
    }
    return null;
  }
  async function forceDownload(url, filename, jobId) {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) return { fallbackTo: target.href };
    const response = await fetch(target.href, { credentials: 'include' });
    if (!response.ok) throw new Error(`Download request failed: HTTP ${response.status}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
    const contentType = response.headers.get('content-type') || '';
    const chunks = [];
    let receivedBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      await reportProgress(jobId, 0, totalBytes, 'downloading');
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        receivedBytes += part.value.byteLength;
        await reportProgress(jobId, receivedBytes, totalBytes);
      }
    } else {
      const blob = await response.blob();
      chunks.push(blob);
      receivedBytes = blob.size;
    }
    const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
    const wall = await challengeFrom(blob, contentType, target.href);
    if (wall) throw new Error(`Download blocked (${wall.reason}): ${wall.detail || 'challenge page'}`);
    const fallback = safeFilename(decodeURIComponent(target.pathname.split('/').pop() || ''), 'download');
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = safeFilename(filename, fallback);
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return { downloadTriggered: true, downloadMode: 'forced', url: target.href, bytes: blob.size, filename: link.download };
  }
  function activeJob() {
    if (tabState.activeJob) return tabState.activeJob;
    try { return JSON.parse(sessionStorage.getItem('tm-browser-mcp-active-job')); } catch { return null; }
  }
  function setActiveJob(value) {
    updateTabState({ activeJob: value });
    sessionStorage.setItem('tm-browser-mcp-active-job', JSON.stringify(value));
  }
  function clearActiveJob() {
    const { activeJob: _, ...rest } = tabState;
    tabState = rest;
    writeTabState(tabState);
    sessionStorage.removeItem('tm-browser-mcp-active-job');
  }
  async function execute(job, phase) {
    const payload = job.payload || {};
    if (job.type === 'navigate') {
      const target = new URL(payload.url, location.href).href;
      if (phase !== 'afterNavigate' && location.href !== target) return { navigateTo: target };
      await wait(500);
      return { result: pageState() };
    }
    if (job.type === 'extract') { await waitForReady(payload.plan); return { result: extract(payload.plan) }; }
    if (job.type === 'inspect') return { result: inspect(payload.mode, payload.limit) };
    if (job.type === 'fill') { fill(payload.selector, String(payload.value ?? '')); return { result: pageState() }; }
    if (job.type === 'click') {
      if (phase !== 'afterClick') {
        setActiveJob({ job, phase: 'afterClick' });
        click(payload.selector);
      }
      await wait(300);
      return { result: pageState() };
    }
    if (job.type === 'download') {
      if (payload.url) {
        const target = new URL(payload.url, location.href).href;
        // Default to the browser's own navigation path: issue a real
        // navigation to the target and let the browser decide whether to
        // download (Content-Disposition: attachment) or preview inline.
        // Publisher bot management (IEEE APM) rejects script-initiated
        // download requests (GM_download, fetch, <a download>) with a JS
        // challenge, but always serves the real file to a top-level
        // navigation — so the navigation path is the reliable one and we do
        // NOT fight the anti-bot layer. force:true opts into a same-origin
        // fetch→blob forced save (with challenge detection); preview:true
        // requests the browser's inline viewer explicitly.
        if (payload.preview) {
          return { result: { downloadTriggered: true, downloadMode: 'preview', url: target }, downloadTo: target };
        }
        if (payload.force && new URL(target).origin === location.origin) {
          const forced = await forceDownload(target, payload.filename, job.id);
          if (forced.fallbackTo) return { result: { downloadTriggered: true, downloadMode: 'browser', url: forced.fallbackTo }, downloadTo: forced.fallbackTo };
          return { result: forced };
        }
        return { result: { downloadTriggered: true, downloadMode: 'browser', url: target }, downloadTo: target };
      }
      return { result: { downloadTriggered: true, ...pageState() }, clickAfter: payload.selector };
    }
    if (job.type === 'scroll') {
      if (validSelector(payload.selector)) {
        const el = document.querySelector(payload.selector);
        if (el) el.scrollIntoView({ block: 'center' });
        else throw new Error('Element not found');
      } else if (Number.isFinite(payload.x) || Number.isFinite(payload.y)) window.scrollTo(Number(payload.x) || 0, Number(payload.y) || 0);
      else if (Number.isFinite(payload.dx) || Number.isFinite(payload.dy)) window.scrollBy(Number(payload.dx) || 0, Number(payload.dy) || 0);
      else throw new Error('scroll requires selector, x/y, or dx/dy');
      return { result: pageState() };
    }
    if (job.type === 'focus') {
      if (!validSelector(payload.selector)) throw new Error('Invalid selector');
      const el = document.querySelector(payload.selector);
      if (!el) throw new Error('Element not found');
      el.focus();
      return { result: pageState() };
    }
    if (job.type === 'hover') {
      if (!validSelector(payload.selector)) throw new Error('Invalid selector');
      const el = document.querySelector(payload.selector);
      if (!el) throw new Error('Element not found');
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(type, o));
      return { result: pageState() };
    }
    if (job.type === 'key') {
      const el = (validSelector(payload.selector) && document.querySelector(payload.selector)) || document.activeElement;
      if (!el) throw new Error('No target for key event');
      const key = String(payload.key ?? '');
      if (!key) throw new Error('key is required');
      const code = payload.code || key;
      for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true }));
      return { result: pageState() };
    }
    if (job.type === 'clickPoint') {
      const x = Number(payload.x), y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('clickPoint requires x and y');
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error('No element at point');
      const target = el.closest('button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]') || el;
      if (typeof target.click !== 'function') throw new Error('Element at point is not clickable');
      target.click();
      return { result: pageState() };
    }
    if (job.type === 'verifyPoint') {
      const x = Number(payload.x), y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('verifyPoint requires x and y');
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error('No element at point');
      const target = el.closest('button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]') || el;
      return { result: { ...pageState(), found: { tag: target.tagName.toLowerCase(), text: bounded(target.innerText || target.textContent || '', 120), href: target.href || null, rect: geometry(target) } } };
    }
    throw new Error(`Unsupported action: ${job.type}`);
  }
  async function run(job, phase) {
    busy = true;
    paint();
    try {
      const action = await execute(job, phase);
      if (action.navigateTo) {
        setActiveJob({ job, phase: 'afterNavigate' });
        location.assign(action.navigateTo);
        return;
      }
      const result = action.result || {};
      // Transport-level completion only. The userscript collects raw facts and
      // never judges — the semantic blocked/completed verdict is computed on
      // the MCP server from result.attentionRequired + result.data
      // (FROZEN-INTERFACE: 采集 + 执行 + 汇报,不判断).
      await api('POST', '/result', { jobId: job.id, clientId, status: 'done', result });
      clearActiveJob();
      if (action.downloadTo) navigate(action.downloadTo);
      if (action.clickAfter) click(action.clickAfter);
    } catch (error) {
      await api('POST', '/result', { jobId: job.id, clientId, status: 'error', error: error.message });
      clearActiveJob();
    } finally {
      busy = false;
      paint();
      // Always resume the poll loop after a job. During a navigation the
      // pre-scheduled poll is torn down with the page, so this finally — and
      // the new page's boot path — restart the loop.
      pollDelay = 60;
      schedulePoll();
    }
  }
  let pollDelay = 1200;
  let pollTimer = null;
  let polling = false;
  function schedulePoll() {
    if (pollTimer) return; // already scheduled
    pollTimer = setTimeout(() => { pollTimer = null; poll(); }, pollDelay);
    if (pollTimer.unref) pollTimer.unref();
  }
  async function poll() {
    if (polling) return; // re-entry guard
    polling = true;
    try {
      if (!enabled) { pollDelay = 1200; return; }
      let response;
      try { response = await api('POST', '/poll', { clientId, client: { url: location.href, title: document.title }, busy }); }
      catch { paint('bridge offline'); pollDelay = 1200; return; }
      if (response.job && !busy) {
        // run()'s finally always calls schedulePoll(); do not schedule here.
        run(response.job);
      } else {
        pollDelay = response.pending > 0 ? 150 : 1200;
      }
    } finally {
      polling = false;
      // Re-schedule unless a job is being handled (run() will schedule).
      if (!busy) schedulePoll();
    }
  }
  setTimeout(() => {
    const active = activeJob();
    if (enabled && active?.job) run(active.job, active.phase);
    else schedulePoll();
  }, 500);
  // -- Consent-overlay / page-stall resilience (v0.7.5) ---------------------
  // WHY THIS EXISTS: some sites (ACM Digital Library, Stack Overflow, others)
  // inject heavy consent/cookie overlays or login-gate JS that runs *on top of*
  // the page but inside the same document. That script can temporarily freeze
  // or re-render the DOM in a way that stalls our `setTimeout(poll)` chain: the
  // scheduled callback keeps getting deferred (busy main thread) and the tab
  // stops reporting to the bridge — it looks "offline" until the user manually
  // refreshes. This is NOT a navigation bug: cross-origin navigation alone was
  // verified safe (clientId survives). It is specifically overlay/SPA stalls.
  //
  // WHY THESE EVENTS: there is no reliable "main thread is free again" event.
  // But a tab that was stalled by an overlay becomes visible again once the
  // overlay is dismissed or the user switches away and back — that's
  // `visibilitychange`. And bfcache restore fires `pageshow`. Both are cheap,
  // fire in the exact "user is looking again" moment, and calling `poll()`
  // directly re-arms the loop immediately instead of waiting up to 1200ms.
  //
  // WHY NOT A FIXED FASTER INTERVAL: a permanent 100ms poll would catch stalls
  // sooner but burns CPU / battery and still doesn't help when the main thread
  // is genuinely frozen (the timer itself can't fire). Event-driven re-arming
  // is the right recovery; the steady-state interval stays low.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedulePoll();
  });
  window.addEventListener('pageshow', schedulePoll);
})();
