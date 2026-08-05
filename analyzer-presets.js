'use strict';

// Built-in site presets: default "important" element hints for common paper
// sites. Presets are NOT special — they are the initial seed of the same
// per-domain marks that manual marks (via browser_mark) can override, add to,
// or delete. `presetsFor(hostname)` converts each regex match into a synthetic
// `source:'preset'` mark record that the memory layer merges with manual marks.

const PRESETS = [
  {
    domain: 'ieeexplore.ieee.org',
    marks: [
      { match: { text: /pdf/i, href: /\/document\/|\/stamp\// }, label: 'PDF Download', kind: 'important' },
      { match: { text: /view document/i }, label: 'View Document', kind: 'important' },
      { match: { text: /citation|cite this|export/i }, label: 'Citation / Export', kind: 'important' },
      { match: { text: /save/i }, label: 'Save', kind: 'important' },
      { match: { text: /search/i }, label: 'Search', kind: 'important' },
      // Sign-in cluster: the access entry points AND the paywall notices form
      // one "login required" signal — when any of them is present, the paper
      // is not downloadable without access, and the AI should route to
      // institutional/personal sign-in instead of attempting a blind download.
      // They only render when the page actually shows a wall, so promoting
      // them never wastes attention on an already-authorized paper.
      { match: { text: /institutional sign in/i }, label: 'Institutional Sign In', kind: 'important' },
      { match: { text: /personal sign in/i }, label: 'Personal Sign In', kind: 'important' },
      { match: { text: /sign in or purchase/i }, label: 'Login Required (Sign In or Purchase)', kind: 'important' },
      { match: { text: /sign in to continue reading/i }, label: 'Login Required (Continue Reading)', kind: 'important' },
    ],
  },
  {
    domain: 'arxiv.org',
    marks: [
      { match: { href: /\/pdf\// }, label: 'PDF', kind: 'important' },
      { match: { text: /bibtex|citation|export/i }, label: 'Cite / Export', kind: 'important' },
      { match: { text: /download/i }, label: 'Download', kind: 'important' },
    ],
  },
  {
    domain: 'dl.acm.org',
    marks: [
      { match: { href: /\/doi\/pdf/ }, label: 'PDF / eReader', kind: 'important' },
      { match: { text: /download pdf/i, href: /\/doi\/pdf.*download/ }, label: 'Download PDF', kind: 'important' },
      { match: { text: /citation|cite this/i, href: /citation|export/ }, label: 'Citation', kind: 'important' },
      { match: { text: /save/i }, label: 'Save', kind: 'important' },
    ],
  },
  {
    domain: 'sciencedirect.com',
    marks: [
      { match: { href: /\/pdf/ }, label: 'PDF Download', kind: 'important' },
      { match: { text: /export|cite/i, href: /export/ }, label: 'Export / Cite', kind: 'important' },
      { match: { href: /doi\.org/ }, label: 'DOI', kind: 'important' },
    ],
  },
];

// Normalize a hostname: lowercase, strip protocol/port, drop leading "www.".
function hostnameOf(url) {
  try {
    let s = String(url || '').trim();
    if (!s) return '';
    if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`; // bare host or path → treat as host
    const u = new URL(s);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch { return ''; }
}

// Registrable-domain fallback: for presets we accept the exact domain or its
// subdomain (www.sciencedirect.com → sciencedirect.com).
function presetFor(hostname) {
  if (!hostname) return null;
  const exact = PRESETS.find((p) => p.domain === hostname);
  if (exact) return exact;
  const base = hostname.split('.').slice(-2).join('.');
  return PRESETS.find((p) => p.domain === base) || null;
}

// Convert a preset's regex matches into synthetic source:'preset' mark records.
// cues.text / cues.href hold the regex objects; markMatchScore branches on
// source === 'preset' to do regex/substring testing instead of exact equality.
function presetsFor(hostname) {
  const preset = presetFor(hostname);
  if (!preset) return [];
  return preset.marks.map((m, i) => ({
    key: `preset:${preset.domain}:${i}:${m.label}`,
    kind: m.kind || 'important',
    source: 'preset',
    label: m.label,
    cues: {
      kind: null,
      text: m.match && m.match.text ? m.match.text : null,
      href: m.match && m.match.href ? m.match.href : null,
      ariaLabel: null,
      selector: null,
    },
    markedAt: null,
  }));
}

module.exports = { PRESETS, presetsFor, hostnameOf };
