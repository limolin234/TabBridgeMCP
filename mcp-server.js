#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const adapters = require('./adapters');

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
const timeoutFor = (type) => (type === 'navigate' || type === 'download'
  ? Number(process.env.TPMONKEY_MCP_NAV_TIMEOUT_MS || 60000)
  : defaultTimeoutMs);

async function enqueue(type, payload) {
  await ensureBridge();
  if (!payload.tabId) throw new Error('tabId is required. Call browser_tabs first and choose the dedicated tab.');
  const queued = await request('POST', '/jobs', { type, payload, target: payload.tabId });
  const deadline = Date.now() + timeoutFor(type);
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await wait(250);
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

function compactJob(job, extra = {}) {
  return { jobId: job.id, status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}), ...extra };
}

const tools = [
  { name: 'browser_tabs', description: 'List explicitly enabled dedicated browser tabs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read a cleaned, layered view of one tab. Use inspect only when this is insufficient.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, mode: { type: 'string', enum: ['summary', 'text', 'elements', 'links', 'controls', 'media'] }, selector: { type: 'string' }, contains: { type: 'string' }, visible: { type: 'boolean' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['tabId'] } },
  { name: 'browser_action', description: 'Navigate, click, or fill one dedicated tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, action: { type: 'string', enum: ['navigate', 'click', 'fill'] }, url: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['tabId', 'action'] } },
  { name: 'browser_download', description: 'Use the normal browser session to follow a URL or click a download control; it never bypasses access checks.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, url: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId'] } },
  { name: 'browser_inspect', description: 'Debug-only bounded fallback. Request limited plain text or HTML only when browser_read is insufficient.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, mode: { type: 'string', enum: ['text', 'html'] }, limit: { type: 'number' } }, required: ['tabId'] } },
];

async function callTool(name, args = {}) {
  if (name === 'browser_tabs') return { tabs: await tabs() };
  if (name === 'browser_read') {
    const tab = (await tabs()).find((item) => item.id === args.tabId);
    if (!tab) throw new Error('Unknown tabId. Call browser_tabs again.');
    const adapter = adapters.forUrl(tab.url);
    const options = { mode: args.mode || 'summary', selector: args.selector, contains: args.contains, visible: args.visible, limit: args.limit, offset: args.offset };
    const job = await enqueue('extract', { tabId: args.tabId, plan: { ...adapter.plan(tab.url, options), query: options } });
    return compactJob(job, { adapter: adapter.name });
  }
  if (name === 'browser_action') {
    if (!['navigate', 'click', 'fill'].includes(args.action)) throw new Error('action must be navigate, click, or fill');
    return compactJob(await enqueue(args.action, args));
  }
  if (name === 'browser_download') return compactJob(await enqueue('download', args));
  if (name === 'browser_inspect') return compactJob(await enqueue('inspect', { ...args, mode: args.mode || 'text', limit: args.limit || 4000 }));
  throw new Error('Unknown tool');
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
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tabbridge-mcp', version: '0.3.0' } } });
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
