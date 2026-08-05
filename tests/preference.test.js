'use strict';

// Unit tests for the site-memory / preference system. Run: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const analyzer = require('../analyzer');
const { presetsFor, hostnameOf } = require('../analyzer-presets');

// Point memory at a temp file.
const MEM = path.join(os.tmpdir(), `tabbridge-test-${process.pid}.json`);
process.env.TABBRIDGE_MEMORY_FILE = MEM;
const memory = require('../memory');

function rawButton(text, href, rect, selectorCls) {
  return { tag: 'button', text, type: 'submit', name: null, id: null, placeholder: null, 'aria-label': null, role: null, value: text, rect, isDisplayed: true, disabled: false, checked: false, path: [{ tag: 'button', id: null, class: [selectorCls], nth: null }] };
}
function rawLink(text, href, rect, selectorCls) {
  return { tag: 'a', text, href, type: null, name: null, id: null, placeholder: null, 'aria-label': null, role: null, value: null, rect, isDisplayed: true, disabled: false, checked: false, path: [{ tag: 'a', id: null, class: [selectorCls], nth: null }] };
}
const VP = { w: 1513, h: 810 };

test('presets for IEEE and arxiv', () => {
  const ieee = presetsFor('ieeexplore.ieee.org');
  assert.ok(ieee.length >= 3, 'IEEE presets exist');
  assert.ok(ieee.some((m) => m.label === 'PDF Download'));
  const arxiv = presetsFor('arxiv.org');
  assert.ok(arxiv.some((m) => m.label === 'PDF'));
  assert.strictEqual(presetsFor('example.com').length, 0);
});

test('hostnameOf strips www and protocol', () => {
  assert.strictEqual(hostnameOf('https://www.sciencedirect.com/abc'), 'sciencedirect.com');
  assert.strictEqual(hostnameOf('ieeexplore.ieee.org/document/1'), 'ieeexplore.ieee.org');
});

test('key stability across selector drift', () => {
  const a = analyzer.buildKey({ kind: 'button', text: 'Download PDF', href: 'https://x/document/123/stamp', ariaLabel: null, selector: '.btn-pdf' });
  const b = analyzer.buildKey({ kind: 'button', text: 'Download PDF', href: 'https://x/document/456/stamp', ariaLabel: null, selector: '.btn-new-pdf' });
  assert.strictEqual(a, b, 'same semantic key despite selector + id drift');
});

test('important manual mark biases salience into primary', () => {
  memory._resetForTests();
  memory.markElement('x.test', { kind: 'button', text: 'PDF', href: 'https://x/document/1/stamp', ariaLabel: null, selector: '.pdf' }, 'important', 'manual');
  const pref = memory.resolvePreference('x.test');
  const raw = [rawButton('PDF', 'https://x/document/1/stamp', { x: 10, y: 800, w: 40, h: 20 }, 'pdf'), rawButton('Search', 'https://x/search', { x: 500, y: 50, w: 300, h: 60 }, 'search')];
  const r = analyzer.analyzeInteract(raw, { viewport: VP, preference: pref, limit: 50 });
  const primaryTexts = r.zones.primary.map((p) => p.text);
  assert.ok(primaryTexts.includes('PDF'), 'marked PDF is in primary');
});

test('unimportant mark demotes and overrides preset', () => {
  memory._resetForTests();
  // Same element is important-by-preset (href /document/) but manual-unimportant wins.
  memory.markElement('x.test', { kind: 'link', text: 'Some Paper', href: 'https://x/document/1', ariaLabel: null, selector: '.doc' }, 'unimportant', 'manual');
  const pref = memory.resolvePreference('x.test');
  // preset important would match /document/ too
  const raw = [rawLink('Some Paper', 'https://x/document/1', { x: 100, y: 50, w: 200, h: 40 }, 'doc')];
  const r = analyzer.analyzeInteract(raw, { viewport: VP, preference: pref, limit: 50 });
  const inPrimary = r.zones.primary.some((p) => p.text === 'Some Paper');
  assert.ok(!inPrimary, 'unimportant mark keeps element out of primary despite preset');
});

test('click boost requires count >= 2 and decays', () => {
  const cues = { kind: 'button', text: 'Cite', href: 'https://x/document/1', ariaLabel: null, selector: '.cite' };
  assert.strictEqual(analyzer.clickBoost([{ key: 'k', cues, count: 1, lastAt: new Date().toISOString() }], cues), 0, 'single click no boost');
  const fresh = analyzer.clickBoost([{ key: 'k', cues, count: 2, lastAt: new Date().toISOString() }], cues);
  assert.ok(fresh >= 5 && fresh <= 20, `fresh boost ${fresh} in [5,20]`);
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  assert.strictEqual(analyzer.clickBoost([{ key: 'k', cues, count: 20, lastAt: old }], cues), 0, 'ancient clicks no boost');
  const huge = analyzer.clickBoost([{ key: 'k', cues, count: 100, lastAt: new Date().toISOString() }], cues);
  assert.ok(huge <= 20, 'boost capped at 20');
});

test('persistence round-trip', () => {
  memory._resetForTests();
  memory.markElement('persist.test', { kind: 'button', text: 'Save', href: 'https://x/save/1', ariaLabel: null, selector: '.save' }, 'important', 'manual');
  memory.saveNow();
  const fresh = require('../memory');
  const list = fresh.listMemory('persist.test');
  assert.strictEqual(list.marks.length, 1);
  assert.strictEqual(list.marks[0].kind, 'important');
});

test('corrupt file backs up and starts empty', () => {
  fs.writeFileSync(MEM, '{ not json !!!');
  delete require.cache[require.resolve('../memory')];
  const fresh = require('../memory');
  const list = fresh.listMemory('any.test');
  assert.ok(Array.isArray(list.marks));
  assert.ok(fs.existsSync(`${MEM}.bak`), 'backup written');
});

test('manual mark survives and preset baseline appears on IEEE-like domain', () => {
  memory._resetForTests();
  memory.markElement('ieeexplore.ieee.org', { kind: 'button', text: 'Download PDF', href: 'https://ieeexplore.ieee.org/document/1/stamp', ariaLabel: null, selector: '.pdf' }, 'important', 'manual');
  const pref = memory.resolvePreference('ieeexplore.ieee.org');
  assert.ok(pref.preset === true, 'preset flag set');
  const presetCount = pref.marks.filter((m) => m.source === 'preset').length;
  assert.ok(presetCount >= 3);
  const manualCount = pref.marks.filter((m) => m.source === 'manual').length;
  assert.strictEqual(manualCount, 1);
});
