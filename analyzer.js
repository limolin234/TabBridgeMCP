'use strict';

// Local interaction brain for TabBridge MCP. The frozen userscript only
// reports physical facts (rect, isDisplayed, flattened path, raw attrs);
// every judgment — what is interactive, how salient, how to group, the stable
// CSS selector, and the click point — happens here, server-side, so the
// userscript never has to change again.
//
// Human-attention model: instead of a flat list, `analyzeInteract` returns
// zones — primary (the few things a person looks at first), grouped (similar
// elements merged, e.g. a row of hot-search links), secondary (the rest).
// The AI reads primary+grouped first and drills into a group on demand.

const INTERACT_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]',
].join(', ');

const STRUCTURE_SELECTOR = [
  'h1, h2, h3, h4, h5, h6',
  'nav',
  'main',
  'article',
  'section',
  'form',
  'header',
  'footer',
  '[role="navigation"]',
  '[role="main"]',
  '[role="contentinfo"]',
].join(', ');

// Fields requested from the userscript. Every read mode benefits; the server
// decides which to use. 24 = userscript property cap.
const COMMON_FIELDS = [
  'tag', 'text', 'href', 'type', 'name', 'id', 'placeholder', 'aria-label',
  'role', 'value', 'rect', 'isDisplayed', 'disabled', 'checked', 'path',
];

function interactPlan(options = {}) {
  return {
    fields: [
      { key: 'interact', kind: 'list', selector: options.selector || INTERACT_SELECTOR, limit: 250, properties: COMMON_FIELDS },
      { key: 'structure', kind: 'list', selector: options.selector || STRUCTURE_SELECTOR, limit: 100, properties: ['tag', 'text', 'href', 'role', 'rect', 'isDisplayed', 'path'] },
    ],
  };
}

const KIND_RANK = { button: 0, input: 0, select: 0, textarea: 0, link: 1, clickable: 2 };
const KIND_WEIGHT = { input: 0.9, textarea: 0.85, select: 0.8, button: 0.7, link: 0.5, clickable: 0.35 };
function kindOf(el) {
  const t = el.tag;
  if (['input', 'select', 'textarea', 'button'].includes(t)) return t;
  if (t === 'a' && el.href) return 'link';
  return el.role || 'clickable';
}

function inViewport(rect, viewport) {
  return rect && rect.w > 0 && rect.h > 0
    && rect.x < viewport.w && rect.y < viewport.h
    && rect.x + rect.w > 0 && rect.y + rect.h > 0;
}

// Build a stable CSS selector from the flattened ancestor path reported by the
// userscript. Strategy: prefer the shortest robust chain — own id, then own
// tag+class, then walk up to the nearest ancestor with an id. Unstyled
// ancestors that carry no distinguishing feature still need an nth-of-type so
// the chain stays unambiguous; id/class-bearing ancestors stop the climb early
// to keep the selector short and resilient to re-render.
function selectorFromPath(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  const segments = [];
  let climbed = 0;
  for (const part of path) {
    if (!part) continue;
    let seg = part.tag || '*';
    if (part.id) seg += `#${CSS_escape(part.id)}`;
    if (Array.isArray(part.class) && part.class.length) {
      seg += part.class.slice(0, 2).map((c) => `.${CSS_escape(c)}`).join('');
    } else if (!part.id) {
      if (part.nth) seg += `:nth-of-type(${part.nth})`;
    }
    segments.push(seg);
    climbed += 1;
    if (part.id || (Array.isArray(part.class) && part.class.length)) break;
    if (climbed >= 5) break;
  }
  return segments.join(' > ');
}

function CSS_escape(value) {
  return String(value).replace(/^[^a-zA-Z_]|[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// ---- Attention model ------------------------------------------------------

// Special-action heuristic: form submission, auth, commerce, and strong-CTA
// affordances. Derived purely from physical/static facts (no JS).
const SPECIAL_KEYWORDS = /\b(submit|search|login|sign\s*-?\s*(in|on)|register|confirm|apply|buy|checkout|add\s*to\s*cart|accept|agree|确定|提交|搜索|登录|注册|确认|接受|同意|购买|结算|加入购物车)\b/i;
const SPECIAL_HREF = /\/?(login|signin|register|cart|checkout|search|logout|signout)/i;
const SPECIAL_CLASS = /\b(primary|submit|search|login|register|cta|accept|agree|confirm|main-|nav-|menu-)/i;
function isSpecial(el) {
  if (!el) return { isSpecial: false, hints: [] };
  const hints = [];
  const type = String(el.type || '').toLowerCase();
  if (type === 'submit') hints.push('type=submit');
  const role = String(el.role || '').toLowerCase();
  if (['button', 'menuitem', 'tab', 'link'].includes(role)) hints.push(`role=${role}`);
  const cls = (Array.isArray(el.path) && el.path[0] && Array.isArray(el.path[0].class) ? el.path[0].class : []).join(' ');
  if (SPECIAL_CLASS.test(cls)) hints.push(`class:${cls.slice(0, 40)}`);
  const text = String(el.text || '');
  if (SPECIAL_KEYWORDS.test(text)) hints.push(`text:${text.slice(0, 20)}`);
  const href = String(el.href || '');
  if (href && SPECIAL_HREF.test(new URL(href, 'https://x').pathname)) hints.push(`href:${href.slice(0, 40)}`);
  return { isSpecial: hints.length > 0, hints };
}

// ---- Noise detection ------------------------------------------------------
// Consent/cookie overlays, modal close buttons, and accessibility widgets are
// NOT what a user is looking at — promoting them to primary wastes the AI's
// attention and forces extra queries to reach the real content. Detect them
// from static facts (id/class/aria/role/text) and demote to hidden.

const NOISE_SELECTOR = [
  'CybotCookiebotDialog',       // Cookiebot — trademark token, no word boundary
  'osano-cm',                  // Osano consent
  'onetrust',                  // OneTrust consent
].join('|');
const NOISE_TOKEN_RE = new RegExp(NOISE_SELECTOR, 'i');
const NOISE_WORD_RE = new RegExp(`(^|[^a-z])(cookie|consent|gdpr|modal|dialog|popover|close-modal|bp-modal|visually-hidden|sr-only|skip-link|cookie-banner)([^a-z]|$)`, 'i');
const NOISE_TEXT_RE = /(allow all cookies|accept all cookies|use necessary cookies|manage consent|cookie settings|consent|cookie preferences|privacy settings)/i;
const NOISE_CLOSE_RE = /^[×x✕✖]|close( modal| dialog| menu)?$/i;

function isNoise(item) {
  if (!item) return false;
  const id = String(item.id || '');
  const cls = (item.path && item.path[0] && item.path[0].class ? item.path[0].class : []).join(' ');
  const role = String(item.role || '').toLowerCase();
  const text = String(item.text || '');
  const aria = String(item.ariaLabel || '');
  // 1. consent/cookie banner controls by id/class/role/text
  if (NOISE_TOKEN_RE.test(id) || NOISE_TOKEN_RE.test(cls) || NOISE_WORD_RE.test(id) || NOISE_WORD_RE.test(cls) || NOISE_TEXT_RE.test(text) || NOISE_TEXT_RE.test(aria)) return true;
  if (role === 'dialog' || role === 'alertdialog') return true;
  // 2. modal chrome: close buttons / hidden labels
  if (NOISE_CLOSE_RE.test(text) && item.kind !== 'link') return true;
  if (/^close/i.test(aria) && /modal|dialog|popup/i.test(aria)) return true;
  // 3. accessibility-only widgets
  if (/skip to (main )?content|跳转到主要/i.test(text) || /^main navigation/i.test(aria)) return true;
  return false;
}

// Human-salience score 0..100 from physical facts only.
// size (log-scaled area through a sigmoid so mid-sized controls beat giant
//   container blocks), position (F-pattern: top-left strongest), kind,
//   special-action bonus, textness (labelled controls are informative).
function salience(item, viewport) {
  const r = item.rect || {};
  const area = Math.max(1, r.w * r.h);
  const vpArea = Math.max(1, (viewport.w || 1920) * (viewport.h || 1080));
  const sizeRaw = Math.log1p(area) / Math.log1p(vpArea);
  const size = 1 / (1 + Math.exp(-6 * (sizeRaw - 0.35)));
  const cx = (r.x || 0) + (r.w || 0) / 2;
  const cy = (r.y || 0) + (r.h || 0) / 2;
  const normX = Math.min(1, Math.max(0, cx / (viewport.w || 1920)));
  const normY = Math.min(1, Math.max(0, cy / (viewport.h || 1080)));
  const position = 1 - (normY + 0.5 * normX);
  const kind = KIND_WEIGHT[item.kind] ?? 0.3;
  const special = item.special ? 1 : 0;
  // Text readability is the dominant signal WITHOUT a vision model: a button
  // or link the AI can read (author name, "Download PDF", a post title) is
  // worth far more than a large-but-mute icon or a checkbox whose text is "on".
  const text = String(item.text || '').trim();
  const label = String(item.ariaLabel || '').trim();
  const meaningful = (text && !/^(on|off|true|false|×|x)$/i.test(text) && text.length >= 2) || (label && label.length >= 4);
  const textness = meaningful ? Math.min(0.08 * Math.log1p(Math.max(text.length, label.length)), 1) : 0;
  let score = 100 * (0.22 * size + 0.18 * position + 0.18 * kind + 0.14 * special + 0.28 * textness);
  if (!item.inViewport) score = Math.min(score, 5); // off-screen never primary
  return Math.round(score);
}

// ---- Site memory / preference ---------------------------------------------
// Marks (manual + preset) and click history bias the salience score. Manual
// marks dominate; preset is a baseline; clicks are a weak, decaying hint that
// can never override a manual mark.

const PREF_IMPORTANT_BONUS = 60;    // important mark → +60, tops primary
const PREF_UNIMPORTANT_SCORE = 0;   // unimportant mark → floor, sorts last
const PREF_BOOST_CAP = 20;          // click-derived, never beats a manual mark
const PREF_BOOST_MIN_COUNT = 2;     // a single click never boosts
const PREF_CLICK_HALF_LIFE_DAYS = 30;
const PREF_CLICK_MAX_AGE_DAYS = 60;
const PREF_MATCH_THRESHOLD = 50;

function buildCuesFromItem(item) {
  return {
    kind: item.kind || item.tag || null,
    text: item.text || null,
    href: item.href || null,
    ariaLabel: item.ariaLabel || null,
    selector: item.selector || null,
  };
}

// Normalized pathname (digits stripped) so /document/123/ and /document/456/
// collapse to /document/ — marks survive across a site's article pages.
// Normalized pathname for grouping/matching. Digits-only segments become
// ":id" so /document/123/ and /document/456/ collapse to /document/:id/, but
// semantic prefixes survive: /doi/10.1145/3581783.3612344 keeps the "10.1145"
// publisher prefix and only the trailing numeric id folds — distinct article
// types (author vs citation) no longer share one group key.
function hrefPattern(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://x');
    const segments = u.pathname.split('/').filter(Boolean).map((s) => {
      if (/^\d+$/.test(s)) return ':id';
      if (/^[\d.]+$/.test(s) && s.includes('.')) return s; // 10.1145 style publisher prefix
      return s;
    });
    const p = segments.join('/');
    return p ? `/${p}` : null;
  } catch { return null; }
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Semantic identity key for storing marks — selector is only a confirmation.
function buildKey(cues) {
  const k = cues.kind;
  const t = normText(cues.text);
  const hp = hrefPattern(cues.href);
  if (t && hp) return `${k}|${t}|${hp}`;
  if (t) return `${k}|${t}`;
  if (hp) return `${k}||${hp}`;
  if (cues.selector) return `${k}|sel:${cues.selector}`;
  return `${k}|*`;
}

// Score how well a live element's cues match a stored mark. threshold 50.
function markMatchScore(cues, mark) {
  if (!cues || !mark || !mark.cues) return 0;
  const mc = mark.cues;
  let score = 0;
  // exact selector — strongest structural signal
  if (mc.selector && cues.selector && mc.selector === cues.selector) score += 100;
  // text
  const liveText = normText(cues.text);
  const markText = mc.text;
  if (markText) {
    if (mark.source === 'preset' && markText instanceof RegExp) {
      if (markText.test(cues.text || '')) score += 70;
    } else {
      const normMark = normText(markText);
      if (liveText && normMark && liveText === normMark) score += 70;
      else if (liveText && normMark && liveText.includes(normMark)) score += 50;
    }
  }
  // href
  const liveHp = hrefPattern(cues.href);
  const markHref = mc.href;
  if (markHref) {
    if (mark.source === 'preset' && markHref instanceof RegExp) {
      if (markHref.test(cues.href || '')) score += 60;
    } else if (liveHp && normText(markHref) && liveHp === hrefPattern(markHref)) {
      score += 60;
    }
  }
  // aria-label
  const liveAria = normText(cues.ariaLabel);
  const markAria = mc.ariaLabel;
  if (markAria && liveAria && liveAria === normText(markAria)) score += 55;
  return score;
}

// Weak, decaying, capped click boost. Guards against wrong-path solidification:
// only completed clicks are recorded, count must be ≥ 2, boosts decay over
// 30 days, zero after 60, capped at PREF_BOOST_CAP (below manual +60).
function clickBoost(clicks, cues) {
  if (!Array.isArray(clicks)) return 0;
  let best = null;
  for (const c of clicks) {
    const s = markMatchScore(cues, { cues: c.cues, source: 'manual' });
    if (s >= PREF_MATCH_THRESHOLD && (!best || s > best.score)) best = { ...c, score: s };
  }
  if (!best || best.count < PREF_BOOST_MIN_COUNT) return 0;
  const ageDays = best.lastAt ? (Date.now() - Date.parse(best.lastAt)) / 86400000 : 0;
  if (ageDays > PREF_CLICK_MAX_AGE_DAYS || ageDays < 0) return 0;
  const recency = Math.exp(-ageDays / PREF_CLICK_HALF_LIFE_DAYS);
  return Math.min(PREF_BOOST_CAP, Math.round((best.count - 1) * 5 * recency));
}

// Apply preference to an item: set item.pref and bias item.score.
// Returns early on a manual 'unimportant' — it beats everything.
function applyPreference(item, preference) {
  const cues = buildCuesFromItem(item);
  const marks = preference.marks || [];
  let bestManual = null, bestManualScore = 0;
  let bestPreset = null, bestPresetScore = 0;
  for (const m of marks) {
    const s = markMatchScore(cues, m);
    if (s < PREF_MATCH_THRESHOLD) continue;
    if (m.source === 'preset') { if (s > bestPresetScore) { bestPresetScore = s; bestPreset = m; } }
    else if (s > bestManualScore) { bestManualScore = s; bestManual = m; }
  }
  if (bestManual && bestManual.kind === 'unimportant') {
    item.pref = { important: false, unimportant: true, boost: 0 };
    item.score = PREF_UNIMPORTANT_SCORE;
    return;
  }
  const boost = clickBoost(preference.clicks, cues);
  if (bestManual && bestManual.kind === 'important') {
    item.pref = { important: true, unimportant: false, boost: 0, manual: true };
    item.score += PREF_IMPORTANT_BONUS;
  } else if (bestPreset && bestPreset.kind === 'important') {
    item.pref = { important: true, unimportant: false, boost: 0, manual: false };
    item.score += PREF_IMPORTANT_BONUS;
  } else {
    item.pref = { important: false, unimportant: false, boost, manual: false };
    item.score += boost;
  }
}

// ---- Grouping (auto-merge similar) ---------------------------------------

const GROUPABLE_KINDS = new Set(['link', 'clickable', 'button']);

// Normalize classes: drop numeric suffixes and double-underscore variants so
// hot-1/hot-2/hot-3 collapse to hot, css-module hashes collapse too.
function canonicalClasses(classes) {
  if (!Array.isArray(classes) || classes.length === 0) return null;
  const set = new Set();
  for (const c of classes) {
    const norm = String(c).replace(/\d+|[_-]{2,}/g, '').trim();
    if (norm && !/^(item|link|active|current|hover)$/.test(norm)) set.add(norm);
  }
  if (set.size === 0 || set.size >= 3) return null; // too generic or too varied
  return [...set].sort().join('.');
}

// Group key only: unlike hrefPattern (mark matching), grouping keeps the FULL
// path — folding numeric segments would wrongly merge distinct entity pages
// (news articles /newsDetail_forward_3371492 and 3371493, papers /document/123
// and 456). Query strings ARE folded — /group/explore?tag=A and ?tag=B are one
// nav list, not separate pages.
function groupHrefPattern(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://x');
    let p = u.pathname.replace(/\/+/g, '/');
    if (!p || p === '/' || p === '/#') return null;
    return p;
  } catch { return null; }
}

// Group key: kind + (href pattern for links, canonical class set otherwise).
// A link's href is the semantic identity — two different articles share layout
// classes (thepaper's inheritfqv_, a feed row) but never the same href pattern,
// so grouping links by class would wrongly merge distinct stories. Links group
// by href pattern when one exists; a class-based fallback covers links without
// a meaningful href (javascript:void(0), modal openers). Buttons/clickables
// have no href, so they group by canonical class set. Form controls
// (input/textarea/select) never group — each has a distinct purpose.
function groupKeyFor(item) {
  if (!GROUPABLE_KINDS.has(item.kind)) return null;
  const ownClasses = item.path && item.path[0] && item.path[0].class ? item.path[0].class : [];
  const canon = canonicalClasses(ownClasses);
  if (item.kind === 'link') {
    const hp = groupHrefPattern(item.href);
    if (hp) return `${item.kind}|href:${hp}`;
    if (canon) return `${item.kind}|class:${canon}`;
    return null;
  }
  if (canon) return `${item.kind}|class:${canon}`;
  return null;
}

function centerOf(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Greedy spatial chaining: candidates in salience order; each joins the nearest
// open group with the same key if within 320px, else seeds a new group. A group
// of count 1 is dissolved back into the flow (a lone CTA is not a "group").
// Each group carries avgTextLen — the mean length of non-empty member text —
// which assignZones uses to tell homogeneous helper clusters (vote arrows, hide
// buttons: short/identical text) from entity lists (video titles, news
// headlines: long, distinct text). The latter must NOT be collapsed into one
// representative — they are distinct targets.
function buildGroups(candidates, viewport) {
  const groups = [];
  const byKey = new Map();
  for (const item of candidates) {
    const key = groupKeyFor(item);
    if (!key) continue;
    const open = byKey.get(key);
    const c = centerOf(item.rect);
    let joined = false;
    if (open) {
      for (let i = open.length - 1; i >= 0; i -= 1) {
        const g = open[i];
        if (distance(g.center, c) <= 320) {
          g.members.push(item);
          g.rect = { x: Math.min(g.rect.x, item.rect.x), y: Math.min(g.rect.y, item.rect.y), w: Math.max(g.rect.x + g.rect.w, item.rect.x + item.rect.w) - Math.min(g.rect.x, item.rect.x), h: Math.max(g.rect.y + g.rect.h, item.rect.y + item.rect.h) - Math.min(g.rect.y, item.rect.y) };
          g.center = centerOf(g.rect);
          if (item.score > g.rep.score) g.rep = item;
          joined = true;
          break;
        }
      }
    }
    if (!joined) {
      const group = { key, kind: item.kind, members: [item], rep: item, rect: { ...item.rect }, center: c };
      groups.push(group);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(group);
    }
  }
  const sized = groups.filter((g) => g.members.length >= 2);
  for (const g of sized) {
    const texts = g.members.map((m) => String(m.text || '').trim()).filter(Boolean);
    g.avgTextLen = texts.length ? texts.reduce((s, t) => s + t.length, 0) / texts.length : 0;
  }
  return sized;
}

// An entity list is a cluster whose members are DISTINCT long-text targets
// (video titles, news headlines), not interchangeable helpers. Collapsing them
// into one representative would hide that "51 headlines" means 51 real pages
// to click. Homogeneous helpers (vote arrows, hide, navbar) have short or
// identical text and merge fine.
function isEntityGroup(group) {
  if (!group.members || group.members.length < 2) return false;
  return group.avgTextLen >= 14;
}

// ---- Zone assignment ------------------------------------------------------

function assignZones(items, options = {}) {
  const limit = Math.min(Number(options.limit) || 100, 100);
  let primary = [];
  const secondary = [];
  const hidden = [];

  // Hidden = dropped by the physical filter; list a bounded sample so the AI
  // knows collapsed elements exist without paying for 100s of records.
  for (const h of (options.hiddenRaw || []).slice(0, 15)) {
    hidden.push({ kind: h.kind || h.tag || 'unknown', selector: h.selector, reason: 'hidden' });
  }

  const visible = items.filter((it) => it.inViewport);
  const offscreen = items.filter((it) => !it.inViewport);

  // Consent/modal noise is demoted to hidden outright — even if it has
  // readable text ("Allow all cookies"), it is not what the user is trying to
  // reach, and listing it in primary/secondary wastes the AI's attention.
  const noise = [...visible, ...offscreen].filter((it) => it._noise).slice(0, 15);
  for (const it of noise) {
    hidden.push({ kind: it.kind || it.tag, selector: it.selector, reason: 'noise' });
  }
  const visibleMain = visible.filter((it) => !it._noise);
  const offscreenMain = offscreen.filter((it) => !it._noise);

  // Group FIRST: similar elements (hot-search rows, nav clusters, off-screen
  // card feeds) merge into groups before primary is chosen, so a row of 12
  // hot-links or 20 feed cards never floods the zones. Off-screen elements
  // group too — without it, long feeds (douban group cards) lay flat as 50+
  // secondary rows. Marked-unimportant and NOISE elements never seed a group —
  // a cluster of cookie-banner buttons must not become a "group".
  const groupable = [...visibleMain, ...offscreenMain].filter((it) => groupKeyFor(it) !== null && !(it.pref && it.pref.unimportant));
  const grouped = buildGroups(groupable.map((it) => ({ ...it })), options.viewport);
  // Entity groups (long distinct member text: video titles, news headlines)
  // are NOT collapsed to one representative — each member is a real clickable
  // page. They dissolve back into the flow and surface as a truncated list in
  // secondary (capped with an "and N more" note). Homogeneous helper groups
  // (vote arrows, hide, navbar) stay merged.
  const entityGroups = new Set();
  const entityMemberKeys = new Set();
  const groupedMemberKeys = new Set();
  for (const g of grouped) {
    if (isEntityGroup(g)) { entityGroups.add(g); g.members.forEach((m) => entityMemberKeys.add(m._k)); continue; }
    g.members.forEach((m) => groupedMemberKeys.add(m._k));
  }
  const groupedMeta = grouped.filter((g) => !entityGroups.has(g)).map((g) => ({
    groupKey: g.key,
    kind: g.kind,
    label: (g.rep.text || '').slice(0, 40) || g.rep.ariaLabel || g.rep.kind,
    count: g.members.length,
    rect: g.rect,
    center: g.center,
    point: { x: Math.round(g.center.x * 10) / 10, y: Math.round(g.center.y * 10) / 10 },
    selector: g.rep.selector,
    score: g.rep.score,
  }));

  // primary: from NON-grouped visible elements only — adaptive top-k plus
  // hard-promote form controls / special actions. Cap at 8 so the AI sees a
  // short list of the salient actions, not a crowded row. Marked-unimportant
  // and consent/modal NOISE elements are excluded — a cookie banner must not
  // claim the top of the list.
  const ungroupedVis = visible.filter((it) => !groupedMemberKeys.has(it._k) && !(it.pref && it.pref.unimportant) && !it._noise);
  const k = Math.max(3, Math.min(8, Math.floor(ungroupedVis.length / 4)));
  const sortedUngrouped = [...ungroupedVis].sort((a, b) => b.score - a.score);
  // Hard-promote only form controls that carry READABLE text (a labelled
  // search box, a submit button with "Download PDF"). A mute checkbox whose
  // text is "on" is not something the AI can act on, so it must not be pushed
  // into primary by kind alone.
  const meaningful = (it) => String(it.text || '').trim().length >= 2 && !/^(on|off|true|false)$/i.test(String(it.text || '').trim());
  const promoted = sortedUngrouped.filter((it) => (it.special || ['input', 'textarea', 'select'].includes(it.kind)) && (meaningful(it) || String(it.ariaLabel || '').length >= 4)).slice(0, 12);
  const promotedKeys = new Set(promoted.map((it) => it._k));
  const topK = sortedUngrouped.filter((it) => !promotedKeys.has(it._k)).slice(0, k);
  primary.push(...[...promoted, ...topK].slice(0, 8));

  // Marked-important elements always land in primary. MANUAL marks are an
  // absolute user signal and are never capped out — a user-marked element must
  // not be pushed off the top by presets or salience. Preset marks follow the
  // cap (they're a baseline, not a demand).
  const markedImportant = [...visible, ...offscreen].filter((it) => it.pref && it.pref.important && !primary.some((p) => p._k === it._k));
  const manualImportant = markedImportant.filter((it) => it.pref && it.pref.manual);
  const presetImportant = markedImportant.filter((it) => !(it.pref && it.pref.manual));
  primary = [...manualImportant, ...primary, ...presetImportant].slice(0, 10 + manualImportant.length);
  const primaryKeys = new Set(primary.map((it) => it._k));

  // Entity-list truncation: a dissolved entity group (51 news headlines, 15
  // video titles) must not re-flatten into rows. Keep the top
  // ENTITY_SHOW_PER_PATTERN per pattern across both viewports and attach one
  // "还有 N 个同类" pseudo-element so the AI knows the list is longer without
  // paying for every row.
  const ENTITY_SHOW_PER_PATTERN = 6;
  const entityPatternOf = (it) => (entityMemberKeys.has(it._k) ? groupKeyFor(it) : null);
  const allEntityMembers = [...visibleMain, ...offscreenMain].filter((it) => entityPatternOf(it));
  const keep = new Set();
  const moreByPattern = new Map();
  for (const it of allEntityMembers.sort((a, b) => b.score - a.score)) {
    const p = entityPatternOf(it);
    if (!moreByPattern.has(p)) moreByPattern.set(p, 0);
    if (moreByPattern.get(p) < ENTITY_SHOW_PER_PATTERN) { keep.add(it._k); moreByPattern.set(p, moreByPattern.get(p) + 1); }
  }
  const moreCount = (p) => allEntityMembers.filter((it) => entityPatternOf(it) === p).length - ENTITY_SHOW_PER_PATTERN;

  // secondary = visible not primary not grouped-member (entity lists truncated),
  // then off-screen (also excluding grouped members — an off-screen card feed
  // must collapse to its group representative, not re-flatten into rows).
  const visPool = visibleMain.filter((it) => !primaryKeys.has(it._k) && !groupedMemberKeys.has(it._k) && (keep.has(it._k) || !entityPatternOf(it)));
  const offPool = offscreenMain.filter((it) => !groupedMemberKeys.has(it._k) && (keep.has(it._k) || !entityPatternOf(it)));
  secondary.push(
    ...visPool.sort((a, b) => b.score - a.score).slice(0, limit),
    ...offPool.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit - visPool.length)),
  );
  for (const p of moreByPattern.keys()) {
    const n = moreCount(p);
    if (n > 0) secondary.push({ _k: null, _groupedMore: true, kind: 'more', tag: 'a', text: `还有 ${n} 个同类`, groupKey: p, selector: null, score: -1 });
  }

  return { primary, secondary, grouped: groupedMeta, hidden };
}

// ---- Main entry -----------------------------------------------------------

// Returns { zones:{primary,secondary,grouped,hidden}, total, items }.
// `items` is the flat snapshot member list in zone order — primary members,
// then secondary, then one representative per grouped group. Indices are its
// positions, so click-by-index keeps working unchanged.
// `options.expand` re-analyzes a stored raw harvest into a group's members.
function analyzeInteract(raw, options = {}) {
  const viewport = options.viewport || { w: 1920, h: 1080 };
  const include = Array.isArray(options.include) ? new Set(options.include) : null;
  const offset = Math.max(Number(options.offset) || 0, 0);

  const all = (raw || []).map((el, i) => {
    const kind = kindOf(el);
    const rect = el.rect;
    const vis = rect && rect.w > 0 && rect.h > 0 && el.isDisplayed !== false;
    const special = isSpecial(el);
    const item = {
      _k: i,
      rawIndex: i,
      tag: el.tag,
      kind,
      text: (el.text || '').slice(0, 120),
      href: el.href || null,
      type: el.type || null,
      name: el.name || null,
      id: el.id || null,
      placeholder: el.placeholder || null,
      ariaLabel: el['aria-label'] || null,
      role: el.role || null,
      value: el.value || null,
      rect,
      inViewport: vis && inViewport(rect, viewport),
      isDisplayed: vis,
      disabled: !!el.disabled,
      checked: !!el.checked,
      selector: selectorFromPath(el.path),
      path: el.path,
      special: special.isSpecial,
      _noise: isNoise({ id: el.id, path: el.path, role: el.role, text: el.text, ariaLabel: el['aria-label'], kind }),
      _hidden: !vis,
    };
    item.score = salience(item, viewport);
    if (options.preference) applyPreference(item, options.preference);
    if (!vis) item.selector = item.selector || selectorFromPath(el.path);
    return item;
  });

  const visibleItems = all.filter((it) => !it._hidden).map((it) => ({ ...it }));
  visibleItems.forEach((it) => { it._k = it.rawIndex; });
  const hiddenRaw = all.filter((it) => it._hidden);

  // Deduplicate virtual-scroll repeats: the same element (same selector + same
  // aria-label + same x) often appears once per viewport slot on infinite lists
  // (reddit, feeds). Keep the highest-salience instance; the rest would flood
  // primary/secondary with identical rows.
  const seen = new Map();
  const deduped = [];
  for (const it of visibleItems) {
    if (!it.selector) { deduped.push(it); continue; }
    // Same element repeated by virtual scroll shares selector + aria-label AND
    // href (or both null). Distinct links in a feed share x but differ by href,
    // so href keeps them apart.
    const key = `${it.selector}|${it.ariaLabel || ''}|${it.href || ''}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, it); deduped.push(it); }
    else if (it.score > prev.score) {
      // replace: drop the old instance, keep this higher-salience one
      const idx = deduped.indexOf(prev);
      if (idx >= 0) deduped[idx] = it;
      seen.set(key, it);
    }
  }
  const visibleItemsFinal = deduped;

  // expand a group from a stored harvest
  if (options.expand) {
    const key = String(options.expand);
    const members = visibleItemsFinal.filter((it) => groupKeyFor(it) === key);
    return {
      zone: 'grouped',
      groupKey: key,
      total: members.length,
      members: members.slice(offset, offset + (Number(options.limit) || 50)).map((m, i) => {
        const out = {};
        for (const k of ['index', 'tag', 'kind', 'text', 'href', 'type', 'name', 'id', 'placeholder', 'ariaLabel', 'role', 'value', 'rect', 'inViewport', 'isDisplayed', 'disabled', 'checked', 'selector']) if (m[k] !== undefined) out[k] = m[k];
        out.index = i;
        return out;
      }),
    };
  }

  const zones = assignZones(visibleItemsFinal, { ...options, viewport, hiddenRaw });

  // Flat member list: primary, then secondary, then one rep per grouped group.
  const flat = [];
  for (const it of [...zones.primary, ...zones.secondary]) {
    flat.push(stripIndex(it));
  }
  for (const g of zones.grouped) {
    flat.push({ index: null, groupKey: g.groupKey, kind: g.kind, label: g.label, count: g.count, rect: g.rect, point: g.point, selector: g.selector, isGroupedRep: true });
  }
  flat.forEach((it, i) => { it.index = i; });

  const pick = (item) => {
    if (!include) return item;
    const out = {};
    for (const key of include) if (item[key] !== undefined) out[key] = item[key];
    return out;
  };
  const zonePick = (arr) => arr.map((it) => {
    const clean = { ...it };
    for (const k of ['_k', '_hidden', '_grouped', 'score', 'path', 'pref']) delete clean[k];
    return include ? pick(clean) : clean;
  });
  const pickFlat = (arr) => arr.map((it) => {
    const { _k, _hidden, _grouped, score, pref, ...rest } = it;
    return include ? pick(rest) : rest;
  });

  // expose zones with stable indices aligned to `flat`
  const indexOf = (item) => flat.findIndex((f) => f.selector === item.selector && f.text === item.text);
  return {
    zones: {
      primary: zonePick(zones.primary.map((it) => ({ ...pick(it), index: indexOf(it) }))),
      secondary: zonePick(zones.secondary.map((it) => ({ ...pick(it), index: indexOf(it) }))),
      grouped: zonePick(zones.grouped.map((g) => ({ ...g, index: flat.findIndex((f) => f.groupKey === g.groupKey) }))),
      hidden: zones.hidden,
    },
    total: flat.length,
    items: pickFlat(flat),
  };
}

function stripIndex(item) {
  const { _k, _hidden, _grouped, score, pref, ...rest } = item;
  return rest;
}

function verifyItem(item, found) {
  if (!found) return { ok: false, reason: 'verifyPoint returned no element at that point' };
  const expectedTag = item && item.tag;
  const gotTag = found.tag;
  if (expectedTag && gotTag && expectedTag !== gotTag) {
    return { ok: false, reason: `element changed: expected <${expectedTag}> at point but found <${gotTag}> (page likely re-rendered or a popup covers the point)` };
  }
  const expectedText = item && item.text && item.text.trim();
  const gotText = found.text && found.text.trim();
  if (expectedText && gotText && expectedText !== gotText) {
    return { ok: false, reason: `element text changed: expected "${item.text.slice(0, 60)}" but found "${found.text.slice(0, 60)}"` };
  }
  const expectedHref = item && item.href;
  const gotHref = found.href;
  if (expectedHref && gotHref && expectedHref !== gotHref) {
    return { ok: false, reason: `element href changed: expected "${expectedHref}" but found "${gotHref}"` };
  }
  return { ok: true };
}

module.exports = { interactPlan, analyzeInteract, verifyItem, selectorFromPath, isSpecial, groupKeyFor, buildCuesFromItem, markMatchScore, clickBoost, applyPreference, buildKey, INTERACT_SELECTOR, STRUCTURE_SELECTOR };
