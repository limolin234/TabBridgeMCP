'use strict';

// Unit tests for the analyzer's cleaning layer: code-text filtering, consent/
// cookie banner noise, and nav/footer chrome demotion. Run: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');

const { analyzeInteract } = require('../analyzer');

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

test('CSS-rule text (Google) is cleaned out of control labels', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '.O35uA{width:28px;height:18px}', path: [{ tag: 'button', class: ['O35uA'] }, { tag: 'body', class: [] }] }),
    raw({ tag: 'a', text: 'Real Link', href: '/real' }),
  ], { viewport: VW });
  assert.ok(!r.items.some((i) => /O35uA/.test(i.text || '')), 'no CSS-rule text in the zone items');
  assert.ok(r.zones.hidden.some((h) => h.reason === 'noise'), 'CSS-rule control hidden as noise');
});

test('script/style remnants are hidden as noise', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: '<script>var x=1;</script>', path: [{ tag: 'button' }, { tag: 'body', class: [] }] }),
  ], { viewport: VW });
  assert.ok(r.zones.hidden.some((h) => h.kind === 'button' && h.reason === 'noise'));
});

test('consent banner copy is hidden, real content survives', () => {
  const r = analyzeInteract([
    raw({ tag: 'button', text: 'Accept all cookies', path: [{ tag: 'button', class: ['cookie-banner-accept'] }, { tag: 'div', class: ['cookie-banner'] }, { tag: 'body', class: [] }] }),
    raw({ tag: 'a', text: 'Your privacy, your choice', href: '/privacy', path: [{ tag: 'a' }, { tag: 'div', class: ['privacy-banner'] }, { tag: 'body' }] }),
    raw({ tag: 'a', text: 'Paper title here', href: '/document/1', path: [{ tag: 'a' }, { tag: 'body' }] }),
  ], { viewport: VW });
  assert.ok(r.zones.hidden.filter((h) => h.reason === 'noise').length >= 2, 'both banner controls hidden');
  assert.ok(r.zones.primary.some((i) => (i.text || '').includes('Paper title')), 'content still primary');
});

test('nav/footer chrome never reaches primary but stays reachable', () => {
  const navPath = [{ tag: 'a', class: ['nav-link'] }, { tag: 'nav', class: ['main-nav'] }, { tag: 'body', class: [] }];
  const footPath = [{ tag: 'a', class: ['foot-link'] }, { tag: 'footer', class: ['site-footer'] }, { tag: 'body', class: [] }];
  const r = analyzeInteract([
    raw({ tag: 'a', text: 'About Us', href: '/about', rect: { x: 800, y: 80, w: 90, h: 24 }, path: navPath }),
    raw({ tag: 'a', text: 'Privacy Policy', href: '/privacy', rect: { x: 800, y: 1000, w: 120, h: 24 }, path: footPath }),
    raw({ tag: 'a', text: 'Main Headline', href: '/news/1', rect: { x: 200, y: 200, w: 300, h: 30 }, path: [{ tag: 'a' }, { tag: 'body' }] }),
  ], { viewport: VW });
  const pri = r.zones.primary.map((i) => i.text || i.label || '');
  assert.ok(!pri.some((t) => t.includes('About Us')), 'nav link not primary');
  assert.ok(!pri.some((t) => t.includes('Privacy Policy')), 'footer link not primary');
  assert.ok(pri.some((t) => t.includes('Main Headline')), 'content primary');
  assert.ok(r.zones.secondary.some((i) => (i.text || '').includes('About Us')), 'chrome link reachable in secondary');
});

test('search box in header still promotes (chrome must not kill the action)', () => {
  const headerPath = [{ tag: 'input', class: ['search-input'] }, { tag: 'header', class: ['site-header'] }, { tag: 'body' }];
  const r = analyzeInteract([
    raw({ tag: 'input', text: '', type: 'text', placeholder: 'Search…', rect: { x: 300, y: 50, w: 400, h: 36 }, path: headerPath }),
  ], { viewport: VW });
  assert.ok(r.zones.primary.some((i) => i.tag === 'input'), 'header search box is primary');
});
