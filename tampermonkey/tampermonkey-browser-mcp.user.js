// ==UserScript==
// @name         TabBridge MCP Browser Bridge
// @namespace    local.tampermonkey-browser-mcp
// @version      0.7.4
// @description  Cross-platform local MCP executor for explicitly enabled ordinary browser tabs.
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_download
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
    window.name = `${tabStatePrefix}${JSON.stringify(state)}`;
  }
  const storedTabState = readTabState();
  const legacyClientId = sessionStorage.getItem('tm-browser-mcp-client');
  const clientId = storedTabState?.clientId || legacyClientId || crypto.randomUUID();
  let enabled = storedTabState ? storedTabState.enabled === true : sessionStorage.getItem('tm-browser-mcp-enabled') === 'true';
  let tabState = { ...(storedTabState || {}), clientId, enabled };
  function updateTabState(patch) {
    tabState = { ...tabState, ...patch };
    writeTabState(tabState);
  }
  updateTabState({ clientId, enabled });
  let busy = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:6px 9px;border:1px solid #777;border-radius:4px;background:#fff;color:#222;font:12px sans-serif;cursor:pointer;box-shadow:0 1px 3px #777';
  function mountButton() {
    if (document.body && !button.isConnected) document.body.append(button);
  }
  function paint(note = '') {
    mountButton();
    button.textContent = `Browser MCP: ${enabled ? (busy ? 'working' : 'ready') : 'off'}${note ? ` (${note})` : ''}`;
    button.style.background = enabled ? '#e7f4ea' : '#f5f5f5';
  }
  button.addEventListener('click', () => {
    enabled = !enabled;
    sessionStorage.setItem('tm-browser-mcp-enabled', String(enabled));
    updateTabState({ enabled });
    paint();
  });
  mountButton();
  document.addEventListener('DOMContentLoaded', mountButton, { once: true });
  GM_registerMenuCommand('Toggle Browser MCP for this tab', () => button.click());
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
  const attentionRequired = () => {
    const title = document.title.toLowerCase();
    return /captcha|verify.*human|sign in|log in/.test(title) || Boolean(document.querySelector('input[type="password"], iframe[src*="captcha"], [class*="captcha"], [id*="captcha"]'));
  };
  function pageState() {
    return {
      url: location.href,
      title: document.title,
      attentionRequired: attentionRequired(),
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
  async function reportProgress(jobId, receivedBytes, totalBytes, phase = 'downloading') {
    try {
      await api('POST', '/progress', { jobId, clientId, receivedBytes, totalBytes, phase });
    } catch { /* Progress reporting must not interrupt the browser download. */ }
  }
  async function forceDownload(url, filename, jobId) {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) return { fallbackTo: target.href };
    const response = await fetch(target.href, { credentials: 'include' });
    if (!response.ok) throw new Error(`Download request failed: HTTP ${response.status}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
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
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
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
  function gmDownload(url, filename, jobId) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== 'function') return reject(new Error('GM_download unavailable'));
      reportProgress(jobId, 0, null, 'downloading');
      GM_download({
        url,
        name: safeFilename(filename, 'download'),
        saveAs: false,
        onload: () => { reportProgress(jobId, 0, null, 'completed'); resolve({ downloadTriggered: true, downloadMode: 'gm', url, filename: safeFilename(filename, 'download') }); },
        onerror: (err) => reject(new Error(`GM_download failed: ${(err && err.error) || 'unknown'}`)),
        ontimeout: () => reject(new Error('GM_download timed out')),
      });
    });
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
    if (job.type === 'extract') return { result: extract(payload.plan) };
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
        // Default to a forced download: browsers preview PDFs inline by default,
        // so a plain navigation would open the viewer instead of saving the
        // file. Prefer GM_download — it is browser-level, works cross-origin,
        // and saveAs:false writes the file directly (bypassing the inline
        // viewer). forceDownload (fetch→blob) only works same-origin, so use it
        // as the fallback. Pass preview:true to opt into the browser's own
        // inline-view / default behavior instead.
        if (payload.preview) {
          return { result: { downloadTriggered: true, downloadMode: 'preview', url: target }, downloadTo: target };
        }
        if (typeof GM_download === 'function') return { result: await gmDownload(target, payload.filename, job.id) };
        if (payload.force || new URL(target).origin === location.origin) {
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
      await api('POST', '/result', { jobId: job.id, clientId, status: result.attentionRequired ? 'blocked' : 'completed', result });
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
      // pre-scheduled setTimeout(poll) is torn down with the page, so this
      // finally — and the new page's boot path — restart the loop.
      pollDelay = 60;
      setTimeout(poll, pollDelay);
    }
  }
  let pollDelay = 1200;
  async function poll() {
    mountButton();
    if (!enabled) { pollDelay = 1200; setTimeout(poll, pollDelay); return; }
    let response;
    try { response = await api('POST', '/poll', { clientId, client: { url: location.href, title: document.title }, busy }); }
    catch { paint('bridge offline'); pollDelay = 1200; setTimeout(poll, pollDelay); return; }
    if (response.job && !busy) {
      // run()'s finally always reschedules poll(); do not double-schedule here,
      // otherwise two poll loops fight. Long jobs still get heartbeats because
      // run() posts /poll{busy:true} only on demand — see run().
      run(response.job);
    } else {
      pollDelay = response.pending > 0 ? 150 : 1200;
      setTimeout(poll, pollDelay);
    }
  }
  setTimeout(() => {
    const active = activeJob();
    if (enabled && active?.job) run(active.job, active.phase);
    else poll();
  }, 500);
})();
