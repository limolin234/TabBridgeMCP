'use strict';

// Unit tests for the semantic status module. Run: node --test "tests/*.test.js"
//
// Regression guard for the IEEE false positive: a visible "Sign In to Save Your
// Search" upsell modal tripped attentionRequired on every search read, so the
// old userscript-side verdict reported 'blocked' even though the page had full
// content. The verdict now lives here, server-side — these cases must hold.

const { test } = require('node:test');
const assert = require('node:assert');
const { contentEmpty, semanticStatus, snapshotStale } = require('../status');

test('full content behind a visible upsell modal → completed (IEEE search)', () => {
  assert.strictEqual(semanticStatus({
    status: 'completed',
    type: 'extract',
    result: { attentionRequired: true, data: { text: 'Showing 1-25 of 145 results for wavelength locking microring ...' } },
  }), 'completed');
});

test('empty extraction behind a wall → blocked (captcha page with no content)', () => {
  assert.strictEqual(semanticStatus({
    status: 'completed',
    type: 'extract',
    result: { attentionRequired: true, data: { text: '' } },
  }), 'blocked');
});

test('no attention signal at all → completed', () => {
  assert.strictEqual(semanticStatus({
    status: 'completed',
    type: 'extract',
    result: { attentionRequired: false, data: { text: 'content' } },
  }), 'completed');
  assert.strictEqual(semanticStatus({ status: 'completed', type: 'extract', result: {} }), 'completed');
});

test('legacy transport "blocked" from a pre-1.0.3 userscript is recomputed, never relayed', () => {
  // Old script posted 'blocked' for the IEEE upsell; must now surface 'completed'.
  assert.strictEqual(semanticStatus({
    status: 'blocked',
    type: 'extract',
    result: { attentionRequired: true, data: { text: 'full results' } },
  }), 'completed');
  // But a real wall that left nothing still reports 'blocked'.
  assert.strictEqual(semanticStatus({
    status: 'blocked',
    type: 'extract',
    result: { attentionRequired: true, data: { text: '' } },
  }), 'blocked');
});

test('non-extract action with a wall in view → blocked (click landing on a login wall)', () => {
  assert.strictEqual(semanticStatus({
    status: 'completed',
    type: 'click',
    result: { attentionRequired: true },
  }), 'blocked');
  assert.strictEqual(semanticStatus({
    status: 'completed',
    type: 'click',
    result: { attentionRequired: false },
  }), 'completed');
});

test('non-terminal transport states relay as-is (background download monitor)', () => {
  assert.strictEqual(semanticStatus({ status: 'queued', type: 'download', result: {} }), 'queued');
  assert.strictEqual(semanticStatus({ status: 'claimed', type: 'download', result: {} }), 'claimed');
});

test('error relays as error', () => {
  assert.strictEqual(semanticStatus({ status: 'error', type: 'extract', result: {}, error: 'boom' }), 'error');
});

test('contentEmpty handles arrays and missing data', () => {
  assert.strictEqual(contentEmpty(undefined), true);
  assert.strictEqual(contentEmpty({}), true);
  assert.strictEqual(contentEmpty({ links: [] }), true);
  assert.strictEqual(contentEmpty({ links: ['a'] }), false);
  assert.strictEqual(contentEmpty({ text: '   ' }), true);
  assert.strictEqual(contentEmpty({ text: ' x ' }), false);
});

// ---- snapshotStale: interact-snapshot freshness guard -----------------------

function isoAgo(seconds) { return new Date(Date.now() - seconds * 1000).toISOString(); }
const freshSnapshot = (overrides = {}) => ({
  url: 'https://example.com/', capturedAt: isoAgo(1), items: [],
  ...overrides,
});

test('snapshotStale: fresh snapshot with matching URL passes', () => {
  assert.deepStrictEqual(snapshotStale(freshSnapshot(), 'https://example.com/', 60000), { ok: true });
});

test('snapshotStale: no snapshot → reject with re-read hint', () => {
  const r = snapshotStale(null, 'https://example.com/', 60000);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /interact/i);
});

test('snapshotStale: URL changed since capture → reject (page navigated)', () => {
  const r = snapshotStale(freshSnapshot(), 'https://other.example.com/', 60000);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /Page changed/i);
});

test('snapshotStale: snapshot older than maxAge → reject with age in the message', () => {
  const r = snapshotStale(freshSnapshot({ capturedAt: isoAgo(120) }), 'https://example.com/', 60000);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /stale/i);
  assert.match(r.reason, /120/);
});

test('snapshotStale: unparseable capture time → reject (defensive)', () => {
  const r = snapshotStale(freshSnapshot({ capturedAt: 'not-a-date' }), 'https://example.com/', 60000);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /capture time/i);
});
