#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const host = '127.0.0.1';
const port = Number(process.env.TPMONKEY_MCP_PORT || 18475);
const statePath = path.join(__dirname, 'state.json');
const maxJobs = 100;

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { jobs: Array.isArray(state.jobs) ? state.jobs : [], clients: state.clients || {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { jobs: [], clients: {} };
    throw error;
  }
}

let state = readState();

function saveState() {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, statePath);
}

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
      saveState();
      return send(response, 201, { job: publicJob(job) });
    }
    if (request.method === 'POST' && url.pathname === '/poll') {
      const body = await parseBody(request);
      if (typeof body.clientId !== 'string' || body.clientId.length > 128) throw new Error('clientId is required');
      state.clients[body.clientId] = { ...body.client, lastSeenAt: new Date().toISOString() };
      const job = state.jobs.find((item) => item.status === 'queued' && (!item.target || item.target === body.clientId));
      if (job) {
        job.status = 'claimed';
        job.clientId = body.clientId;
        job.claimedAt = new Date().toISOString();
      }
      saveState();
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
      saveState();
      return send(response, 200, { job: publicJob(job) });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`IEEE agent bridge listening on http://${host}:${port}\n`);
});
