#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const adapters = require('./adapters');

const port = Number(process.env.TPMONKEY_MCP_PORT || 18475);
const timeoutMs = Number(process.env.TPMONKEY_MCP_TIMEOUT_MS || 30000);
let bridgeChild = null;

function request(method, pathname, body) {
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

async function ensureBridge() {
  try { await request('GET', '/health'); return; } catch { /* Start a bridge for this MCP process. */ }
  if (!bridgeChild || bridgeChild.exitCode !== null) {
    bridgeChild = spawn(process.execPath, [path.join(__dirname, 'bridge.js')], { stdio: 'ignore', env: process.env });
    bridgeChild.unref();
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(100);
    try { await request('GET', '/health'); return; } catch { /* Retry while the bridge binds. */ }
  }
  throw new Error('Could not start the local browser bridge');
}

async function tabs() {
  await ensureBridge();
  const response = await request('GET', '/jobs');
  return Object.entries(response.clients).map(([id, client]) => ({ id, ...client }));
}

async function enqueue(type, payload) {
  await ensureBridge();
  if (!payload.tabId) throw new Error('tabId is required. Call browser_tabs first and choose the dedicated tab.');
  const queued = await request('POST', '/jobs', { type, payload, target: payload.tabId });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(250);
    const response = await request('GET', '/jobs');
    const job = response.jobs.find((item) => item.id === queued.job.id);
    if (job && ['completed', 'blocked', 'error'].includes(job.status)) {
      if (job.status === 'error') throw new Error(job.error || 'Browser action failed');
      return job;
    }
  }
  throw new Error('Browser tab did not complete the action within 30 seconds');
}

const tools = [
  { name: 'browser_tabs', description: 'List explicitly enabled dedicated browser tabs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read a compact, adapter-selected structured view of one tab. It never returns raw HTML.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] } },
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
    const job = await enqueue('extract', { tabId: args.tabId, plan: adapter.plan(tab.url) });
    return { adapter: adapter.name, ...job };
  }
  if (name === 'browser_action') {
    if (!['navigate', 'click', 'fill'].includes(args.action)) throw new Error('action must be navigate, click, or fill');
    return enqueue(args.action, args);
  }
  if (name === 'browser_download') return enqueue('download', args);
  if (name === 'browser_inspect') return enqueue('inspect', { ...args, mode: args.mode || 'text', limit: args.limit || 4000 });
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
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tabbridge-mcp', version: '0.2.0' } } });
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    else if (message.method === 'tools/call') {
      try { send({ jsonrpc: '2.0', id: message.id, result: content(await callTool(message.params?.name, message.params?.arguments)) }); }
      catch (error) { send({ jsonrpc: '2.0', id: message.id, result: content({ error: error.message }, true) }); }
    } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.on('exit', () => bridgeChild?.kill());
