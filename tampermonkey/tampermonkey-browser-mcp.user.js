// ==UserScript==
// @name         TabBridge MCP Browser Bridge
// @namespace    local.tampermonkey-browser-mcp
// @version      0.6.0
// @description  Cross-platform local MCP executor for explicitly enabled ordinary browser tabs.
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
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
  function property(item, name) {
    if (!item) return null;
    if (name === 'text') return bounded(item.innerText || item.textContent || item.value, 240);
    if (name === 'href') return item.href || item.getAttribute('href') || null;
    if (name === 'tag') return item.tagName.toLowerCase();
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
      const limit = Math.min(Number(field.limit) || 20, 100);
      if (field.kind === 'text') {
        const item = document.querySelector(field.selector);
        data[field.key] = matches(item, query) ? cleanedText(item, field.limit) : '';
      }
      if (field.kind === 'attribute') {
        const item = document.querySelector(field.selector);
        data[field.key] = matches(item, query) ? property(item, field.attribute || 'text') : null;
      }
      if (field.kind === 'list') {
        const properties = Array.isArray(field.properties) ? field.properties.slice(0, 16) : ['text'];
        const offset = Math.max(Number(query.offset) || 0, 0);
        const wanted = Math.min(Number(query.limit) || limit, 100);
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
      await wait(500);
      return { result: pageState() };
    }
    if (job.type === 'download') {
      if (payload.url) {
        const target = new URL(payload.url, location.href).href;
        if (payload.force) {
          const forced = await forceDownload(target, payload.filename, job.id);
          if (forced.fallbackTo) return { result: { downloadTriggered: true, downloadMode: 'browser', url: forced.fallbackTo }, downloadTo: forced.fallbackTo };
          return { result: forced };
        }
        return { result: { downloadTriggered: true, downloadMode: 'browser', url: target }, downloadTo: target };
      }
      return { result: { downloadTriggered: true, ...pageState() }, clickAfter: payload.selector };
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
    }
  }
  async function poll() {
    mountButton();
    if (!enabled) return;
    try {
      const response = await api('POST', '/poll', { clientId, client: { url: location.href, title: document.title }, busy });
      if (!busy && response.job) await run(response.job);
    } catch { paint('bridge offline'); }
  }
  setInterval(poll, 1200);
  setTimeout(() => {
    const active = activeJob();
    if (enabled && active?.job) run(active.job, active.phase);
    else poll();
  }, 500);
})();
