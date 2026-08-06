'use strict';

// Unit tests for the interaction-safety hardening:
//   1. verifyItem binding guard — incl. the asymmetry rules that catch an
//      unlabeled control re-rendered into a labeled button ("close"→"logout").
//   2. index alignment — zone indices must equal flat snapshot positions even
//      when two elements share a selector AND text (indexOf ambiguity).
//   3. in-viewport items carry a point (the click anchor) and off-screen ones
//      do not; viewport size drives inViewport (no hardcoded 1920x1080).
// Run: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert');

const { analyzeInteract, verifyItem, selectorFromPath } = require('../analyzer');

// ---- verifyItem -------------------------------------------------------------

const A = { tag: 'button', text: '', href: null }; // an unlabeled icon button
const B = { tag: 'button', text: '退出登录', href: null };
const L = { tag: 'a', text: 'Paper', href: '/paper.pdf' };

test('verifyItem: exact match passes', () => {
  assert.deepStrictEqual(verifyItem({ tag: 'button', text: '确定', href: null }, { tag: 'button', text: '确定', href: null }), { ok: true });
});

test('verifyItem: no found element → reject', () => {
  assert.strictEqual(verifyItem(A, null).ok, false);
});

test('verifyItem: tag changed → reject', () => {
  const r = verifyItem(A, { tag: 'a', text: '', href: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /element changed/i);
});

test('verifyItem: text changed → reject', () => {
  const r = verifyItem({ tag: 'button', text: '确定', href: null }, { tag: 'button', text: '取消', href: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /text changed/i);
});

test('verifyItem: href changed → reject', () => {
  const r = verifyItem(L, { tag: 'a', text: 'Paper', href: '/other.pdf' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /href changed/i);
});

test('verifyItem: unlabeled control that gained text → reject (close became logout)', () => {
  // The captured element had NO text (an aria-labelled close icon-button); the
  // element now at that point is a labeled logout button. The symmetric text
  // check cannot catch it (expectedText is empty), the asymmetry guard must.
  const r = verifyItem(A, B);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /gained text/i);
});

test('verifyItem: non-link control that gained an href → reject', () => {
  const r = verifyItem(A, { tag: 'button', text: '', href: '/login' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /gained a link/i);
});

test('verifyItem: both unlabeled → passes (no false positive)', () => {
  assert.deepStrictEqual(verifyItem(A, { tag: 'button', text: '', href: null }), { ok: true });
});

// ---- index alignment + point + viewport -------------------------------------

const VW = { w: 1920, h: 1080 };
function raw(overrides) {
  const base = {
    tag: 'a', text: 'x', href: null, type: null, name: null, id: null,
    placeholder: null, 'aria-label': null, role: null, value: null,
    rect: { x: 100, y: 100, w: 80, h: 24 }, isDisplayed: true,
    path: [{ tag: 'body', id: null, class: [], nth: null }],
  };
  return { ...base, ...overrides };
}

test('zone indices equal flat snapshot positions even for same-selector+text siblings', () => {
  // Two controls that would collapse to the SAME selector ("button.icon-button"
  // topbar logout vs modal close) and the SAME text, differentiated only by
  // aria-label (so the dedup keeps both — the real-world close/logout pair).
  // The old indexOf (findIndex by selector+text) mapped BOTH zone entries to
  // the first flat slot; the rawIndex map must give each its own slot.
  const icon = (y, nth, aria) => raw({
    tag: 'button', text: '', 'aria-label': aria,
    rect: { x: 1429, y, w: 40, h: 40 },
    path: [{ tag: 'button', class: ['icon-button'], nth }, { tag: 'header', class: [], nth: 1 }, { tag: 'body', class: [], nth: null }],
  });
  const r = analyzeInteract([icon(13, 1, null), icon(400, 2, '关闭详情')], { viewport: VW });
  assert.strictEqual(r.total, 2, 'two distinct controls stay distinct in the flat list');
  // Every zone entry's reported index must point back at its OWN flat member.
  for (const zone of ['primary', 'secondary']) {
    for (const entry of r.zones[zone]) {
      const flat = r.items[entry.index];
      assert.ok(flat, `zone entry index ${entry.index} has a flat member`);
      assert.strictEqual(flat.rawIndex, entry.rawIndex,
        `zone index ${entry.index} resolves to rawIndex ${flat.rawIndex}, not the entry's own ${entry.rawIndex}`);
    }
  }
  const byRaw = Object.fromEntries(r.items.map((it) => [it.rawIndex, it]));
  const [rawA, rawB] = [byRaw[0], byRaw[1]];
  assert.ok(rawA && rawB && rawA.index !== rawB.index, 'the two same-selector siblings get distinct indices');
});

test('in-viewport items carry a point (click anchor); off-screen items do not', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '在屏', rect: { x: 100, y: 100, w: 80, h: 40 }, path: [{ tag: 'button', class: ['btn-on'], nth: 1 }, { tag: 'body', class: [], nth: null }] }),
    raw({ tag: 'button', text: '离屏', rect: { x: 100, y: 5000, w: 80, h: 40 }, path: [{ tag: 'button', class: ['btn-off'], nth: 2 }, { tag: 'body', class: [], nth: null }] }),
  ], { viewport: VW });
  const on = r.items.find((i) => i.text === '在屏');
  const off = r.items.find((i) => i.text === '离屏');
  assert.ok(on && off, 'both elements survive into the flat list');
  assert.ok(on.inViewport, 'in-viewport element flagged');
  assert.deepStrictEqual(on.point, { x: 140, y: 120 }, 'point is the rect center');
  assert.strictEqual(off.inViewport, false, 'off-screen element not flagged');
  assert.strictEqual(off.point, undefined, 'off-screen element has no clickable point');
});

test('viewport size drives inViewport (no hardcoded 1920x1080)', () => {
  const el = raw({ tag: 'button', text: 'x', rect: { x: 0, y: 1000, w: 80, h: 100 } });
  const tall = analyzeInteract([el], { viewport: { w: 1280, h: 1080 } });
  const short = analyzeInteract([el], { viewport: { w: 1280, h: 900 } });
  assert.strictEqual(tall.items[0].inViewport, true, 'element below a 1080px fold is on a 1080px screen');
  assert.strictEqual(short.items[0].inViewport, false, 'the same rect is off-screen when the real viewport is shorter');
});

// ---- selectorFromPath ---------------------------------------------------------
// The userscript reports the flattened ancestor path LEAF-first
// (element, parent, grandparent, ...). A CSS selector must read ancestor ->
// descendant, and document.querySelector only resolves the chain when the
// leftmost segment is an ancestor. Regression: the leaf was emitted leftmost,
// so off-screen scrolls used a back-to-front selector like
// "button:nth-of-type(1) > div > div.freshman-task-pending", which never
// matches the real DOM ("div.freshman-task-pending > div > button:nth-of-type(1)")
// and the scroll failed with "Element not found".

test('selectorFromPath: class-bearing leaf stays a single segment', () => {
  const path = [{ tag: 'button', id: null, class: ['freshman-summary-card'], nth: 1 }, { tag: 'body', id: null, class: [], nth: null }];
  assert.strictEqual(selectorFromPath(path), 'button.freshman-summary-card');
});

test('selectorFromPath: emits root->leaf (leaf rightmost) when ancestors are needed', () => {
  // Leaf (the pill button) has no class; its grandparent carries the anchor class.
  const path = [
    { tag: 'button', id: null, class: [], nth: 1 },
    { tag: 'div', id: null, class: [], nth: null },
    { tag: 'div', id: null, class: ['freshman-task-pending'], nth: 1 },
  ];
  assert.strictEqual(
    selectorFromPath(path),
    'div.freshman-task-pending > div > button:nth-of-type(1)',
    'must be back-to-front compared with the old leaf-first output'
  );
});

test('selectorFromPath: textarea/section chain also emits root->leaf', () => {
  const path = [
    { tag: 'textarea', id: null, class: [], nth: null },
    { tag: 'section', id: null, class: ['freshman-sms-panel'], nth: 1 },
  ];
  assert.strictEqual(selectorFromPath(path), 'section.freshman-sms-panel > textarea');
});

test('selectorFromPath: empty path returns null', () => {
  assert.strictEqual(selectorFromPath([]), null);
  assert.strictEqual(selectorFromPath(null), null);
});
