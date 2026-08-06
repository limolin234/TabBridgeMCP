#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const adapters = require('./adapters');
const { interactPlan, analyzeInteract, verifyItem, buildCuesFromItem } = require('./analyzer');
const memory = require('./memory');

// Per-tab interact snapshots: { url, capturedAt, items }. The userscript is
// frozen; this server-side cache is how we resolve an index to a stable
// selector / point at action time.
const snapshots = new Map();

const port = Number(process.env.TPMONKEY_MCP_PORT || 18475);
const defaultTimeoutMs = Number(process.env.TPMONKEY_MCP_TIMEOUT_MS || 30000);
const tabHeartbeatMs = 60000;
let bridgeChild = null;

function request(method, pathname, body, timeoutMs = defaultTimeoutMs) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const client = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: raw ? {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
    } : {} }, (response) => {
      let text = '';
      response.on('data', (part) => { text += part; });
      response.on('end', () => {
        try {
          const result = JSON.parse(text);
          if (response.statusCode >= 400) throw new Error(result.error || `HTTP ${response.statusCode}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    client.setTimeout(timeoutMs, () => client.destroy(new Error('Bridge timed out')));
    client.on('error', reject);
    if (raw) client.write(raw);
    client.end();
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Spawn one shared bridge for this machine, never a private copy per MCP
// process. The bridge self-exits with code 0 when another instance already
// owns the port, so every mcp-server converges on the same single instance.
async function ensureBridge() {
  try { await request('GET', '/health', undefined, 2000); return; } catch { /* Start a bridge for this MCP process. */ }
  if (!bridgeChild || bridgeChild.exitCode !== null) {
    bridgeChild = spawn(process.execPath, [path.join(__dirname, 'bridge.js')], {
      stdio: 'ignore',
      env: process.env,
      detached: true,
    });
    bridgeChild.unref();
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(100);
    try { await request('GET', '/health', undefined, 2000); return; } catch { /* Retry while the bridge binds. */ }
  }
  throw new Error('Could not start the local browser bridge');
}

async function tabs() {
  await ensureBridge();
  const response = await request('GET', '/jobs');
  const cutoff = Date.now() - tabHeartbeatMs;
  return Object.entries(response.clients)
    .filter(([, client]) => Date.parse(client.lastSeenAt) >= cutoff)
    .map(([id, client]) => ({ id, ...client }));
}

// Operations that involve a full page load need longer than a quick extract.
const timeoutFor = (type) => {
  if (type === 'download') return Number(process.env.TPMONKEY_MCP_DOWNLOAD_TIMEOUT_MS || 180000);
  if (type === 'navigate') return Number(process.env.TPMONKEY_MCP_NAV_TIMEOUT_MS || 60000);
  return defaultTimeoutMs;
};

async function enqueue(type, payload) {
  await ensureBridge();
  if (!payload.tabId) throw new Error('tabId is required. Call browser_tabs first and choose the dedicated tab.');
  const queued = await request('POST', '/jobs', { type, payload, target: payload.tabId });
  const deadline = Date.now() + timeoutFor(type);
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await wait(100);
    let response;
    try { response = await request('GET', '/jobs'); } catch { continue; } // bridge restarting; keep polling
    const job = response.jobs.find((item) => item.id === queued.job.id);
    if (!job) continue; // rotated out of the in-memory tail; treat as lost
    lastStatus = job.status;
    if (['completed', 'blocked', 'error'].includes(job.status)) {
      if (job.status === 'error') throw new Error(job.error || 'Browser action failed');
      return job;
    }
  }
  throw new Error(`Browser tab did not complete the action within ${timeoutFor(type) / 1000}s (job ${queued.job.id}, last status: ${lastStatus})`);
}

async function enqueueBackground(type, payload) {
  await ensureBridge();
  if (!payload.tabId) throw new Error('tabId is required. Call browser_tabs first and choose the dedicated tab.');
  const queued = await request('POST', '/jobs', { type, payload, target: payload.tabId });
  return queued.job;
}

// --- Interact snapshot resolution -----------------------------------------

function snapshotFor(tabId) {
  const snapshot = snapshots.get(tabId);
  if (!snapshot) throw new Error('No interact snapshot. Call browser_read with mode "interact" first.');
  return snapshot;
}
function itemFor(tab, args) {
  const snapshot = snapshotFor(args.tabId);
  if (tab.url !== snapshot.url) throw new Error('Page changed since the interact snapshot; re-read interact.');
  if (args.index === undefined) throw new Error('index is required');
  const item = snapshot.items[args.index];
  if (!item) throw new Error(`No interact element at index ${args.index} (snapshot has ${snapshot.items.length}). Re-read interact.`);
  return item;
}
// Binding guard: before acting, confirm the point still hosts the recorded
// object. Off-screen targets cannot be verified (elementFromPoint misses them)
// so they skip the guard and rely on the URL check + selector click.
async function verifyBinding(tab, args, item) {
  if (!item || !item.inViewport || !item.point) return true;
  const job = await enqueue('verifyPoint', { tabId: args.tabId, x: item.point.x, y: item.point.y });
  const found = job.result && job.result.found;
  const verdict = verifyItem(item, found);
  if (!verdict.ok) throw new Error(verdict.reason);
  return true;
}

async function dispatchAction(tab, args) {
  const action = args.action;
  const base = { tabId: args.tabId };
  if (action === 'navigate') return enqueue('navigate', args);
  if (action === 'fill') {
    if (args.index !== undefined) return enqueue('fill', { ...base, selector: itemFor(tab, args).selector, value: args.value });
    if (args.selector) return enqueue('fill', args);
    throw new Error('fill requires index or selector');
  }
  if (action === 'click') {
    if (args.index !== undefined) {
      const item = itemFor(tab, args);
      await verifyBinding(tab, args, item);
      // Prefer point-click for in-viewport targets: the point is what
      // verifyPoint validated, so it can never be a wrong identical-class
      // sibling that a short CSS selector would match. Off-screen targets
      // have no reliable point, so scroll into view and click by selector.
      let job;
      if (item.inViewport && item.point) job = await enqueue('clickPoint', { ...base, x: item.point.x, y: item.point.y });
      else if (item.selector) {
        if (!item.inViewport) await enqueue('scroll', { ...base, selector: item.selector });
        job = await enqueue('click', { ...base, selector: item.selector });
      } else {
        throw new Error(`Element ${args.index} is off-screen and has no selector; scroll it into view then re-read.`);
      }
      // Only completed clicks are remembered (a blocked state or a verify
      // failure throws before this point) — the "wrong path" guard.
      if (job.status === 'completed') memory.recordClick(memory.hostnameOf(tab.url), buildCuesFromItem(item));
      return job;
    }
    if (args.point) {
      const job = await enqueue('clickPoint', { ...base, x: args.point.x, y: args.point.y });
      if (job.status === 'completed') memory.recordClick(memory.hostnameOf(tab.url), { kind: null, text: null, href: null, ariaLabel: null, selector: null });
      return job;
    }
    if (args.x !== undefined && args.y !== undefined) return enqueue('clickPoint', { ...base, x: args.x, y: args.y });
    if (args.selector) {
      const job = await enqueue('click', args);
      if (job.status === 'completed') memory.recordClick(memory.hostnameOf(tab.url), { kind: null, text: null, href: null, ariaLabel: null, selector: args.selector });
      return job;
    }
    throw new Error('click requires index, point{x,y}, x/y, or selector');
  }
  if (action === 'scroll') {
    if (args.index !== undefined) return enqueue('scroll', { ...base, selector: itemFor(tab, args).selector });
    if (args.selector) return enqueue('scroll', args);
    if (args.dx !== undefined || args.dy !== undefined) return enqueue('scroll', { ...base, dx: args.dx || 0, dy: args.dy || 0 });
    if (args.x !== undefined || args.y !== undefined) return enqueue('scroll', { ...base, x: args.x || 0, y: args.y || 0 });
    throw new Error('scroll requires index, selector, dx/dy, or x/y');
  }
  if (action === 'focus' || action === 'hover') {
    if (args.index !== undefined) return enqueue(action, { ...base, selector: itemFor(tab, args).selector });
    if (args.selector) return enqueue(action, args);
    throw new Error(`${action} requires index or selector`);
  }
  if (action === 'key') {
    if (!args.key) throw new Error('key requires a key value');
    return enqueue('key', args);
  }
  if (action === 'clickPoint') {
    if (args.x === undefined || args.y === undefined) throw new Error('clickPoint requires x and y');
    return enqueue('clickPoint', args);
  }
  if (action === 'verifyPoint') {
    if (args.x === undefined || args.y === undefined) throw new Error('verifyPoint requires x and y');
    return enqueue('verifyPoint', args);
  }
  throw new Error(`unknown action ${action}`);
}

async function jobStatus(jobId) {
  await ensureBridge();
  const response = await request('GET', '/jobs');
  const job = response.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error('Unknown jobId');
  return job;
}

function compactJob(job, extra = {}) {
  return { jobId: job.id, status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}), ...(job.progress ? { progress: job.progress } : {}), ...extra };
}

const tools = [
  { name: 'browser_tabs', description: 'List explicitly enabled dedicated browser tabs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read a cleaned, layered view of one tab. Use inspect only when this is insufficient. By default it waits for the page to be ready before extracting: SPA pages (e.g. IEEE Xplore search, an Angular app) render content asynchronously after navigate, so a read issued too early would see an empty shell. Pass a content selector (e.g. a[href*=\'/document/\'] on IEEE) to wait until that content appears; without a selector it waits for the document load event. Set force:true to read the current view immediately without waiting; waitMs bounds the wait (default 10000).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, mode: { type: 'string', enum: ['summary', 'text', 'elements', 'links', 'controls', 'media', 'interact'] }, selector: { type: 'string' }, contains: { type: 'string' }, visible: { type: 'boolean' }, limit: { type: 'number' }, offset: { type: 'number' }, expand: { type: 'string' }, force: { type: 'boolean' }, waitMs: { type: 'number' } }, required: ['tabId'] } },
  { name: 'browser_action', description: 'Navigate, click, or fill a selected tab. Interact modes also accept index/point/x/y/dx/dy/key. After a navigate to an SPA page (e.g. IEEE Xplore search), content renders asynchronously — browser_read waits for it by default; use force:true there to read immediately.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, action: { type: 'string', enum: ['navigate', 'click', 'fill', 'scroll', 'focus', 'hover', 'key', 'clickPoint', 'verifyPoint'] }, url: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' }, index: { type: 'number' }, point: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, key: { type: 'string' }, code: { type: 'string' } }, required: ['tabId', 'action'] } },
  { name: 'browser_download', description: 'Download a file. HTML wrapper pages (IEEE stamp.jsp) auto-resolve to the real PDF URL, load it in the tab, and fetch it from that warm context. preview:true opts into the browser inline view; force:true opts into a same-origin fetch->blob save; otherwise the tab navigates to the URL and the browser saves it. Returns immediately with a jobId; use browser_job_status to monitor progress.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, url: { type: 'string' }, selector: { type: 'string' }, force: { type: 'boolean' }, preview: { type: 'boolean' }, filename: { type: 'string' } }, required: ['tabId'] } },
  { name: 'browser_job_status', description: 'Get status and byte progress for a background browser job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } },
  { name: 'browser_inspect', description: 'Debug-only bounded fallback. Request limited plain text or HTML only when browser_read is insufficient.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, mode: { type: 'string', enum: ['text', 'html'] }, limit: { type: 'number' } }, required: ['tabId'] } },
  { name: 'browser_mark', description: 'Mark an interact element important/unimportant for the current page domain (site memory), or list/clear current marks. index = position from the latest browser_read interact snapshot; selector is the offline-capable alternative.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, action: { type: 'string', enum: ['important', 'unimportant', 'list', 'clear'] }, index: { type: 'number' }, selector: { type: 'string' } }, required: ['tabId', 'action'] } },
];

async function callTool(name, args = {}) {
  if (name === 'browser_tabs') return { tabs: await tabs() };
  if (name === 'browser_read') {
    const tab = (await tabs()).find((item) => item.id === args.tabId);
    if (!tab) throw new Error('Unknown tabId. Call browser_tabs again.');
    const options = { mode: args.mode || 'summary', selector: args.selector, contains: args.contains, visible: args.visible, limit: args.limit, offset: args.offset, force: args.force, waitMs: args.waitMs };
    if (options.mode === 'interact') {
      // Interact is a structural capability, not site content — it deliberately
      // bypasses URL adapters and uses the local analyzer. Always harvest a
      // generous candidate set (250) regardless of the caller's limit — many
      // pages lead with hidden elements (dropdowns, ARIA utilities) that the
      // analyzer filters, so a small harvest limit would collapse to 0 results.
      // The caller's limit only trims the analyzed output, not the harvest.
      // expand a previously-seen group from the stored harvest, no new extract
      if (args.expand) {
        const snapshot = snapshots.get(args.tabId);
        if (!snapshot) throw new Error('No interact snapshot. Call browser_read with mode "interact" first.');
        if (snapshot.url !== tab.url) throw new Error('Page changed since the interact snapshot; re-read interact.');
        const expanded = analyzeInteract(snapshot.raw, { expand: args.expand, limit: args.limit, viewport: snapshot.viewport, preference: snapshot.preference });
        return { adapter: 'interact', zone: 'grouped', ...expanded };
      }
      // Harvest only the interact field (skip the heavier structure field) and
      // cap the harvest: on dense pages (reddit) 250 candidates x 15 properties
      // can make the userscript stall and drop the /result — which surfaces as
      // "Bridge is not running". 120 candidates is plenty for attention zones.
      const plan = interactPlan(options);
      plan.fields = plan.fields.filter((f) => f.key === 'interact');
      const job = await enqueue('extract', { tabId: args.tabId, plan: { ...plan, query: { ...options, limit: 120 } } });
      const raw = (job.result && job.result.data && job.result.data.interact) || [];
      const viewport = { w: 1920, h: 1080 };
      const preference = memory.resolvePreference(memory.hostnameOf(tab.url));
      const analyzed = analyzeInteract(raw, { ...options, viewport, preference });
      const capturedAt = new Date().toISOString();
      snapshots.set(args.tabId, { url: job.result?.url || tab.url, capturedAt, viewport, raw, items: analyzed.items, zones: analyzed.zones, preference });
      return { adapter: 'interact', url: tab.url, title: tab.title, total: analyzed.total, capturedAt, viewport, zones: analyzed.zones };
    }
    const adapter = adapters.forUrl(tab.url);
    const job = await enqueue('extract', { tabId: args.tabId, plan: { ...adapter.plan(tab.url, options), query: options } });
    return compactJob(job, { adapter: adapter.name });
  }
  if (name === 'browser_action') {
    const tab = (await tabs()).find((item) => item.id === args.tabId);
    if (!tab) throw new Error('Unknown tabId. Call browser_tabs again.');
    return compactJob(await dispatchAction(tab, args));
  }
  if (name === 'browser_mark') {
    const tab = (await tabs()).find((item) => item.id === args.tabId);
    if (!tab) throw new Error('Unknown tabId. Call browser_tabs again.');
    const domain = memory.hostnameOf(tab.url);
    if (!domain) throw new Error('Cannot determine page domain');
    // 'list' needs no element resolution.
    if (args.action === 'list') {
      return { domain, memory: memory.listMemory(domain) };
    }
    // Resolve cues from the latest interact snapshot index, or from a selector.
    let cues = null;
    if (args.index !== undefined) {
      const item = itemFor(tab, args);
      cues = buildCuesFromItem(item);
    } else if (args.selector) {
      const snap = snapshots.get(args.tabId);
      const item = snap && snap.items.find((it) => it.selector === args.selector);
      cues = item ? buildCuesFromItem(item) : { kind: null, text: null, href: null, ariaLabel: null, selector: args.selector };
    } else {
      throw new Error('browser_mark requires index or selector');
    }
    if (args.action === 'important' || args.action === 'unimportant') {
      const mark = memory.markElement(domain, cues, args.action, 'manual');
      memory.saveNow();
      return { domain, action: args.action, mark, memory: memory.listMemory(domain) };
    }
    if (args.action === 'clear') {
      const res = memory.clearElement(domain, cues);
      memory.saveNow();
      return { domain, action: 'clear', ...res, memory: memory.listMemory(domain) };
    }
    throw new Error(`unknown browser_mark action ${args.action}`);
  }
  if (name === 'browser_download') return compactJob(await enqueueBackground('download', await resolveDownloadArgs(args)));
  if (name === 'browser_job_status') return compactJob(await jobStatus(args.jobId));
  if (name === 'browser_inspect') return compactJob(await enqueue('inspect', { ...args, mode: args.mode || 'text', limit: args.limit || 4000 }));
  throw new Error('Unknown tool');
}

// Some publishers serve a PDF through an HTML wrapper page that embeds the
// real file in an <iframe> (IEEE stamp.jsp → stampPDF/getPDF.jsp). Downloading
// the wrapper URL saves the HTML, not the PDF. For known wrappers we CONSTRUCT
// the real file URL from the wrapper's own parameters — no page parsing needed.
// (An earlier navigate→inspect approach proved unreliable: navigating a
// PDF-viewer tab can leave it stuck busy, and inspect returns an empty DOM
// inside the viewer. Construction is deterministic and verified against IEEE.)
const WRAPPER_BUILDERS = [
  {
    // stamp.jsp is the wrapper; stampPDF/getPDF.jsp is the real file. Both are
    // IEEE-specific and both need the navigate-then-fetch warm path below.
    test: /stamp\.jsp|stampPDF\/getPDF\.jsp/i,
    build(u) {
      const arnumber = u.searchParams.get('arnumber');
      if (!arnumber) return null;
      // getPDF.jsp requires ref=base64(abstract page URL); without it IEEE
      // serves no file. The abstract URL is derivable from the arnumber.
      const ref = Buffer.from(`https://ieeexplore.ieee.org/abstract/document/${arnumber}`).toString('base64');
      return `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}&ref=${ref}`;
    },
  },
];
// IEEE's APM rejects script-initiated fetches from an ordinary page but serves
// the real file once the tab has loaded it (a top-level navigation from the
// article page — same-site referrer — warms the session and its own IEEE
// viewer page keeps the userscript alive). So the resolved download FIRST
// navigates the tab to the real PDF URL, then dispatches a same-origin forced
// fetch from that warm context. If the navigation is bounced back to the
// article page, the session lacks access — fail with a clear sign-in error
// instead of saving an APM challenge page.
async function resolveDownloadArgs(args) {
  if (!args.url) return args;
  const u = new URL(args.url);
  if (u.hostname !== 'ieeexplore.ieee.org') return args;
  const builder = WRAPPER_BUILDERS.find((w) => w.test.test(u.pathname));
  if (!builder) return args;
  const real = builder.build(u);
  if (!real) return args;
  const tab = (await tabs()).find((item) => item.id === args.tabId);
  if (!tab) throw new Error('Unknown tabId. Call browser_tabs again.');
  const nav = await enqueue('navigate', { tabId: args.tabId, url: real });
  const landed = nav.result && nav.result.url;
  if (landed && new URL(landed).pathname !== new URL(real).pathname) {
    throw new Error('IEEE redirected the PDF page back to the article — an active institutional sign-in is required to download this paper. Route through the IEEE institutional sign-in flow first.');
  }
  return { ...args, url: real, force: true, filename: args.filename || filenameFromUrl(real) };
}
function filenameFromUrl(value) {
  try {
    const u = new URL(value);
    const arnumber = u.searchParams.get('arnumber');
    if (arnumber) return `${arnumber}.pdf`;
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (last && /\.\w{2,5}$/.test(last)) return last;
    return 'download.pdf';
  } catch { return 'download.pdf'; }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function content(value, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }; }

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tabbridge-mcp', version: '1.0.1' } } });
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    else if (message.method === 'tools/call') {
      try { send({ jsonrpc: '2.0', id: message.id, result: content(await callTool(message.params?.name, message.params?.arguments)) }); }
      catch (error) { send({ jsonrpc: '2.0', id: message.id, result: content({ error: error.message }, true) }); }
    } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
// The bridge is a shared, machine-wide single instance; an mcp-server must NOT
// kill it on exit, or one session would tear down the browser connection of all
// the others. Let it keep running until the machine reboots or it is re-spawned.
