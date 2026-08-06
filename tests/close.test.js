'use strict';

// Unit tests for close/return affordance recognition. "关闭 = 返回": a close
// control is a first-class page element (kind 'close') — findable so the AI can
// dismiss a dialog or step back — NOT modal chrome to delete as noise. Only
// consent/cookie machinery stays hidden. Run: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert');

const { analyzeInteract } = require('../analyzer');

const VW = { w: 1920, h: 1080 };
function raw(overrides) {
  const base = {
    tag: 'button', text: '', href: null, type: null, name: null, id: null,
    placeholder: null, 'aria-label': null, role: null, value: null,
    rect: { x: 100, y: 100, w: 80, h: 24 }, isDisplayed: true,
    path: [{ tag: 'body', id: null, class: [], nth: null }],
  };
  return { ...base, ...overrides };
}

test('bare × button is kind "close", not deleted as noise', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '×', rect: { x: 1700, y: 20, w: 30, h: 30 } }),
  ], { viewport: VW });
  const close = r.items.find((i) => i.kind === 'close');
  assert.ok(close, 'close button present in the item list');
  assert.equal(close.text, '×');
  assert.ok(!r.zones.hidden.some((h) => h.selector === close.selector), 'not hidden as noise');
});

test('aria-label "Close dialog" → kind "close"', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '', 'aria-label': 'Close dialog' }),
  ], { viewport: VW });
  assert.ok(r.items.some((i) => i.kind === 'close' && /Close dialog/.test(i.ariaLabel || '')), 'aria-labelled close control recognized');
});

test('modal-close class + × → kind "close", kept (regression: was surface-chrome noise)', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '×', 'aria-label': 'Close dialog', path: [{ tag: 'button', class: ['modal-close'] }, { tag: 'div', class: ['modal'] }, { tag: 'body' }] }),
  ], { viewport: VW });
  const close = r.items.find((i) => i.kind === 'close');
  assert.ok(close, 'modal close control kept as kind close');
  assert.ok(!r.zones.hidden.some((h) => h.kind === 'close'), 'not demoted to hidden');
});

test('text "返回" / "Back" → kind "close" (return affordance)', () => {
  const r = analyzeInteract([
    raw({ text: '返回', rect: { x: 200, y: 90, w: 80, h: 32 } }),
    raw({ tag: 'a', text: 'Back', href: '/prev', rect: { x: 300, y: 90, w: 70, h: 32 } }),
  ], { viewport: VW });
  assert.equal(r.items.filter((i) => i.kind === 'close').length, 2, 'both return controls are kind close');
});

test('cookie banner × stays noise (consent machinery, even though it is a close control)', () => {
  const r = analyzeInteract([
    raw({ text: '×', path: [{ tag: 'button', class: ['close'] }, { tag: 'div', class: ['cookie-consent'] }, { tag: 'body' }] }),
  ], { viewport: VW });
  assert.ok(r.zones.hidden.some((h) => h.reason === 'noise' && h.kind === 'close'), 'consent close hidden as noise');
  assert.ok(!r.items.some((i) => i.kind === 'close'), 'not surfaced in the interactive list');
});

test('ordinary buttons are not mislabeled close', () => {
  const r = analyzeInteract([
    raw({ text: 'Submit', type: 'submit' }),
    raw({ text: 'Download PDF' }),
    raw({ text: 'About Us', tag: 'a', href: '/about' }),
  ], { viewport: VW });
  assert.ok(!r.items.some((i) => i.kind === 'close'), 'no close kind for ordinary controls');
  assert.ok(r.items.some((i) => i.text === 'Submit' && i.kind === 'button'));
});

test('"Back to top" aria is NOT a close/return control', () => {
  const r = analyzeInteract([
    raw({ 'aria-label': 'Back to top', text: 'Back to top', tag: 'a', href: '#top' }),
  ], { viewport: VW });
  assert.ok(!r.items.some((i) => i.kind === 'close'), 'Back-to-top is a scroll affordance, not a close control');
});

test('role=dialog shell stays noise (unchanged)', () => {
  const r = analyzeInteract([
    raw({ tag: 'div', role: 'dialog', text: 'Settings' }),
  ], { viewport: VW });
  assert.ok(r.zones.hidden.some((h) => h.kind === 'dialog' && h.reason === 'noise'), 'dialog shell hidden');
});

test('close control of a modal is findable but does not steal primary from the real CTA', () => {
  const r = analyzeInteract([
    raw({ text: '×', 'aria-label': 'Close dialog', rect: { x: 1700, y: 20, w: 30, h: 30 } }),
    raw({ text: 'Confirm', type: 'submit', rect: { x: 900, y: 620, w: 120, h: 40 } }),
    raw({ text: 'Main Content', tag: 'a', href: '/main', rect: { x: 200, y: 300, w: 260, h: 32 } }),
  ], { viewport: VW });
  const primaryKinds = r.zones.primary.map((i) => i.kind);
  assert.ok(primaryKinds.includes('button'), 'confirm CTA is primary');
  const close = r.items.find((i) => i.kind === 'close');
  assert.ok(close, 'close control findable in the item list');
  assert.ok(r.items.some((i) => (i.text || '').includes('Main Content')), 'modal content visible');
});

test('bare close glyph contributes salience (was textness 0 for ×)', () => {
  const { salience } = require('../analyzer');
  const rect = { x: 1700, y: 20, w: 30, h: 30 };
  const withGlyph = salience({ kind: 'close', rect, text: '×', ariaLabel: '', inViewport: true }, VW);
  const noText = salience({ kind: 'close', rect, text: '', ariaLabel: '', inViewport: true }, VW);
  assert.ok(withGlyph > noText, `bare × scores above empty text (${withGlyph} > ${noText})`);
});
