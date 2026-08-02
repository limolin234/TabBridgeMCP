// ==UserScript==
// @name         TabBridge MCP Browser Bridge
// @namespace    local.tampermonkey-browser-mcp
// @version      0.2.1
// @description  Cross-platform local MCP executor for explicitly enabled ordinary browser tabs.
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// ==/UserScript==

(() => {
  'use strict';
  const bridge = 'http://127.0.0.1:18475';
  const clientId = sessionStorage.getItem('tm-browser-mcp-client') || crypto.randomUUID();
  sessionStorage.setItem('tm-browser-mcp-client', clientId);
  let enabled = sessionStorage.getItem('tm-browser-mcp-enabled') === 'true';
  let busy = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:6px 9px;border:1px solid #777;border-radius:4px;background:#fff;color:#222;font:12px sans-serif;cursor:pointer;box-shadow:0 1px 3px #777';
  function paint(note = '') {
    button.textContent = `Browser MCP: ${enabled ? (busy ? 'working' : 'ready') : 'off'}${note ? ` (${note})` : ''}`;
    button.style.background = enabled ? '#e7f4ea' : '#f5f5f5';
  }
  button.addEventListener('click', () => {
    enabled = !enabled;
    sessionStorage.setItem('tm-browser-mcp-enabled', String(enabled));
    paint();
  });
  if (document.body) document.body.append(button);
  else document.addEventListener('DOMContentLoaded', () => document.body.append(button), { once: true });
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
    if (name === 'text') return bounded(item.innerText || item.textContent || item.value, 1000);
    if (name === 'href') return item.href || item.getAttribute('href') || null;
    if (name === 'tag') return item.tagName.toLowerCase();
    return item.getAttribute(name) || item[name] || null;
  }
  function extract(plan) {
    const fields = Array.isArray(plan?.fields) ? plan.fields.slice(0, 20) : [];
    const data = {};
    for (const field of fields) {
      if (!field || typeof field.key !== 'string' || !validSelector(field.selector)) continue;
      const limit = Math.min(Number(field.limit) || 20, 100);
      if (field.kind === 'text') data[field.key] = bounded(document.querySelector(field.selector)?.textContent, field.limit);
      if (field.kind === 'attribute') data[field.key] = property(document.querySelector(field.selector), field.attribute || 'text');
      if (field.kind === 'list') {
        const properties = Array.isArray(field.properties) ? field.properties.slice(0, 8) : ['text'];
        data[field.key] = [...document.querySelectorAll(field.selector)].slice(0, limit).map((item) => Object.fromEntries(properties.map((name) => [name, property(item, name)])));
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
  function activeJob() {
    try { return JSON.parse(sessionStorage.getItem('tm-browser-mcp-active-job')); } catch { return null; }
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
        sessionStorage.setItem('tm-browser-mcp-active-job', JSON.stringify({ job, phase: 'afterClick' }));
        click(payload.selector);
      }
      await wait(500);
      return { result: pageState() };
    }
    if (job.type === 'download') {
      if (payload.url) return { result: { downloadTriggered: true, url: new URL(payload.url, location.href).href }, downloadTo: payload.url };
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
        sessionStorage.setItem('tm-browser-mcp-active-job', JSON.stringify({ job, phase: 'afterNavigate' }));
        location.assign(action.navigateTo);
        return;
      }
      const result = action.result || {};
      await api('POST', '/result', { jobId: job.id, clientId, status: result.attentionRequired ? 'blocked' : 'completed', result });
      sessionStorage.removeItem('tm-browser-mcp-active-job');
      if (action.downloadTo) navigate(action.downloadTo);
      if (action.clickAfter) click(action.clickAfter);
    } catch (error) {
      await api('POST', '/result', { jobId: job.id, clientId, status: 'error', error: error.message });
      sessionStorage.removeItem('tm-browser-mcp-active-job');
    } finally {
      busy = false;
      paint();
    }
  }
  async function poll() {
    if (!enabled || busy) return;
    try {
      const response = await api('POST', '/poll', { clientId, client: { url: location.href, title: document.title } });
      if (response.job) await run(response.job);
    } catch { paint('bridge offline'); }
  }
  setInterval(poll, 1200);
  setTimeout(() => {
    const active = activeJob();
    if (enabled && active?.job) run(active.job, active.phase);
    else poll();
  }, 500);
})();
