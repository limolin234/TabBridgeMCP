#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const host = '127.0.0.1';
const port = Number(process.env.TPMONKEY_MCP_PORT || 18475);
const maxJobs = 100;
// Single-instance lock: a shared bridge must serve every MCP process. Atomic
// mkdir (not a pidfile write) so a second instance can detect a live owner
// and hand off instead of failing on a stale port. Two-nodefs fallbacks keep
// the bridge usable in single-MCP setups.
function acquireLock() {
  const lockDir = path.join(os.tmpdir(), 'tabbridge-mcp.lock');
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch (error) {
    if (error.code === 'EEXIST') {
      try { const existing = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10); if (Number.isInteger(existing) && existing > 0 && fs.kill(existing, 0)) return 'handoff'; } catch (e) { /* stale lock */ }
      try { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir, { recursive: true }); } catch (e) { /* raced */ }
    } else { return 'nodir'; }
  }
  try { fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`, { mode: 0o600 }); return 'acquired'; } catch (e) { return 'nopid'; }
}

const lock = acquireLock();
if (lock === 'handoff') {
  process.stderr.write('TabBridge: another instance holds the lock; handing off.\n');
  process.exit(0);
}

let state = { jobs: [], clients: {} };

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) request.destroy(new Error('Request body too large'));
    });
    request.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    target: job.target || null,
    status: job.status,
    createdAt: job.createdAt,
    claimedAt: job.claimedAt || null,
    completedAt: job.completedAt || null,
    clientId: job.clientId || null,
    result: job.result || null,
    error: job.error || null,
  };
}

function validateJob(body) {
  const allowed = new Set(['navigate', 'extract', 'inspect', 'click', 'fill', 'download']);
  if (!body || !allowed.has(body.type)) throw new Error('type must be navigate, extract, inspect, click, fill, or download');
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) throw new Error('payload must be an object');
  if (body.target != null && (typeof body.target !== 'string' || body.target.length > 128)) throw new Error('target must be a client id');
  return { type: body.type, payload: body.payload, target: body.target || null };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ok: true, queued: state.jobs.filter((job) => job.status === 'queued').length });
    }
    if (request.method === 'GET' && url.pathname === '/jobs') {
      return send(response, 200, { jobs: state.jobs.map(publicJob), clients: state.clients });
    }
    if (request.method === 'POST' && url.pathname === '/jobs') {
      const input = validateJob(await parseBody(request));
      const job = { id: randomUUID(), ...input, status: 'queued', createdAt: new Date().toISOString() };
      state.jobs.push(job);
      state.jobs = state.jobs.slice(-maxJobs);
      return send(response, 201, { job: publicJob(job) });
    }
    if (request.method === 'POST' && url.pathname === '/poll') {
      const body = await parseBody(request);
      if (typeof body.clientId !== 'string' || body.clientId.length > 128) throw new Error('clientId is required');
      state.clients[body.clientId] = { ...body.client, lastSeenAt: new Date().toISOString() };
      // Recover jobs claimed by a tab that stopped polling (closed/navigated):
      // no point keeping them in 'claimed' forever where no one can pick them up.
      const now = new Date().getTime();
      state.jobs.forEach((job) => {
        if (job.status === 'claimed') {
          const client = state.clients[job.clientId];
          if (!client || (now - Date.parse(client.lastSeenAt)) > 15000) {
            job.status = 'queued';
            job.clientId = null;
            job.claimedAt = null;
          }
        }
      });
      const job = state.jobs.find((item) => item.status === 'queued' && (!item.target || item.target === body.clientId));
      if (job) {
        job.status = 'claimed';
        job.clientId = body.clientId;
        job.claimedAt = new Date().toISOString();
      }
      return send(response, 200, { job: job ? publicJob(job) : null });
    }
    if (request.method === 'POST' && url.pathname === '/result') {
      const body = await parseBody(request);
      const job = state.jobs.find((item) => item.id === body.jobId);
      if (!job) return send(response, 404, { error: 'Unknown job' });
      if (job.clientId !== body.clientId) return send(response, 409, { error: 'Job belongs to another tab' });
      job.status = body.status === 'blocked' ? 'blocked' : body.status === 'error' ? 'error' : 'completed';
      job.completedAt = new Date().toISOString();
      job.result = body.result && typeof body.result === 'object' ? body.result : null;
      job.error = typeof body.error === 'string' ? body.error.slice(0, 2000) : null;
      return send(response, 200, { job: publicJob(job) });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

const listen = server.listen(port, host, () => process.stdout.write(`TabBridge listening on http://${host}:${port}\n`));
listen.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`TabBridge: port ${port} already in use by another instance; exiting.\n`);
    process.exit(0);
  }
  throw error;
});
