'use strict';

// Per-domain site memory: manual marks, click history, and preset baseline.
// Presets (analyzer-presets.js) are the initial seed of the SAME marks array
// that manual marks join — both are mutable, manual overrides preset when they
// conflict on the same element. Persisted to ~/.tabbridge-memory.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { presetsFor, hostnameOf } = require('./analyzer-presets');
const { buildKey } = require('./analyzer');

const MEMORY_FILE = process.env.TABBRIDGE_MEMORY_FILE || path.join(os.homedir(), '.tabbridge-memory.json');
const MAX_DOMAINS = 200;
const MAX_MARKS_PER_DOMAIN = 50;
const MAX_CLICKS_PER_DOMAIN = 200;
const SAVE_DEBOUNCE_MS = 500;
const CLICK_BURST_WINDOW_MS = 30000;

let state = load();

function emptyState() {
  return { version: 1, updatedAt: null, domains: {} };
}

// Re-read the persisted file so cross-process changes (another mcp-server
// instance marking an element) are visible without a restart. Cheap: one small
// file read per interact. Keep in-memory state if the file is missing/empty.
function reload() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.domains && typeof parsed.domains === 'object') {
      state = parsed;
    }
  } catch { /* keep current state on missing/corrupt file */ }
}

function load() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.domains || typeof parsed.domains !== 'object') return emptyState();
    return parsed;
  } catch (err) {
    // Corrupt or missing → back up a corrupt file, start empty.
    if (err.code !== 'ENOENT') {
      try { fs.renameSync(MEMORY_FILE, `${MEMORY_FILE}.bak`); } catch { /* ignore */ }
    }
    return emptyState();
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref && saveTimer.unref();
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    state.updatedAt = new Date().toISOString();
    const tmp = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, MEMORY_FILE); // atomic on POSIX
  } catch { /* best-effort */ }
}

process.once('exit', () => { try { saveNow(); } catch { /* ignore */ } });

function domainState(hostname) {
  if (!state.domains[hostname]) state.domains[hostname] = { marks: [], clicks: [] };
  return state.domains[hostname];
}

// Trim per-domain arrays to caps (evict oldest clicks by lastAt).
function trimDomain(d) {
  if (d.marks.length > MAX_MARKS_PER_DOMAIN) d.marks = d.marks.slice(-MAX_MARKS_PER_DOMAIN);
  if (d.clicks.length > MAX_CLICKS_PER_DOMAIN) {
    d.clicks.sort((a, b) => (a.lastAt || '').localeCompare(b.lastAt || ''));
    d.clicks = d.clicks.slice(-MAX_CLICKS_PER_DOMAIN);
  }
}

// ---- Public API -----------------------------------------------------------

// Combined manual + preset marks + clicks for a hostname.
function resolvePreference(hostname) {
  reload(); // pick up cross-process marks
  const d = domainState(hostname);
  const presets = presetsFor(hostname);
  const marks = [...(d.marks || []), ...presets];
  return { domain: hostname, marks, clicks: d.clicks || [], preset: presets.length > 0 };
}

function listMemory(hostname) {
  reload(); // pick up cross-process marks
  const d = domainState(hostname);
  return { domain: hostname, marks: d.marks || [], clicks: d.clicks || [], preset: presetsFor(hostname).length > 0 };
}

function markElement(hostname, cues, kind, source) {
  const d = domainState(hostname);
  const key = buildKey(cues);
  // Replace an existing mark with the same key (manual only).
  d.marks = (d.marks || []).filter((m) => !(m.source !== 'preset' && m.key === key));
  const record = {
    key,
    kind: kind === 'unimportant' ? 'unimportant' : 'important',
    source: source || 'manual',
    cues: { kind: cues.kind, text: cues.text, href: cues.href, ariaLabel: cues.ariaLabel, selector: cues.selector },
    url: null,
    markedAt: new Date().toISOString(),
  };
  d.marks.push(record);
  trimDomain(d);
  save();
  return record;
}

function clearElement(hostname, cues) {
  const d = domainState(hostname);
  const key = buildKey(cues);
  const before = d.marks.length;
  d.marks = (d.marks || []).filter((m) => !(m.source !== 'preset' && m.key === key));
  const removed = d.marks.length < before;
  if (removed) { trimDomain(d); save(); }
  return { removed };
}

function recordClick(hostname, cues) {
  const d = domainState(hostname);
  const key = buildKey(cues);
  const now = Date.now();
  const clicks = d.clicks || [];
  const existing = clicks.find((c) => c.key === key);
  if (existing) {
    // Session burst guard: same key within 30s updates lastAt only.
    const age = now - Date.parse(existing.lastAt || 0);
    existing.lastAt = new Date().toISOString();
    if (age > CLICK_BURST_WINDOW_MS) existing.count += 1;
  } else {
    clicks.push({ key, cues: { kind: cues.kind, text: cues.text, href: cues.href, ariaLabel: cues.ariaLabel, selector: cues.selector }, count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() });
  }
  d.clicks = clicks;
  trimDomain(d);
  save();
}

function compact() {
  const names = Object.keys(state.domains);
  if (names.length > MAX_DOMAINS) {
    const sorted = names.sort((a, b) => ((state.domains[a].clicks || []).length - (state.domains[b].clicks || []).length));
    for (const n of sorted.slice(0, names.length - MAX_DOMAINS)) delete state.domains[n];
  }
}

module.exports = { resolvePreference, listMemory, markElement, clearElement, recordClick, saveNow, reload, hostnameOf, _resetForTests: (m) => { state = m || emptyState(); } };
