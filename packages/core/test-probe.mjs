/**
 * Smoke/regression check for `packages/core/src/probe.js`.
 *
 * Run: `node --test packages/core/test-probe.mjs`
 * No dependencies beyond the Node standard library. Every probe input is a
 * hand-written fixture string — there is no live fetching here, ever. If
 * these fixtures stop matching the probe's verdicts, the probe's contract
 * with the alert engine has changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeScannability, PROBE_METHODS, PROBE_FAILURE_REASONS } from './src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures: minimal hand-written pages, one signal each.
 * ------------------------------------------------------------------ */

const FIXTURES = {
  /** 1. Feed discovery — cheapest reliable signal. */
  feed: `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" title="New Arrivals" href="/feeds/new-arrivals.xml">
</head><body><p>welcome</p></body></html>`,

  /** 2. Shopify storefront — platform marker in the page. */
  shopify: `<!doctype html><html><head><title>Vinyl Den</title></head>
<body><script src="https://cdn.shopify.com/shopifycloud/shop.js"></script>
<div id="app"><div class="product">$29.99</div></div></body></html>`,

  /** 3. Bandcamp — platform marker. */
  bandcamp: `<!doctype html><html><head><title>Artist Merch</title></head>
<body><script>var BandData = { url: "https://label.bandcamp.com" };</script></body></html>`,

  /** 4. JSON-LD structured data — Product blocks. */
  jsonld: `<!doctype html><html><head><title>Record Shop</title></head><body>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Mingus Ah Um LP","offers":{"price":"34.99"}}
</script><p>Buy vinyl.</p></body></html>`,

  /** 5. Sitemap reference. */
  sitemap: `<!doctype html><html><head>
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
</head><body><p>Shop our vinyl.</p></body></html>`,

  /** 6. Plain product grid — heuristic only. */
  grid: `<!doctype html><html><body><div class="grid">
${Array.from({ length: 5 }, (_, i) => `
<article class="product-card"><img src="/covers/a${i}.jpg" alt="cover">
<h3>Kind of Blue ${i}</h3><span class="price">$${24.99 + i}</span></article>`).join('')}
</div></body></html>`,

  /** 7. Cloudflare bot wall. */
  botwall: `<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><div id="cf-wrapper">why did this happen? Cloudflare</div>
<div id="cf-challenge" class="cf-challenge"></div></body></html>`,

  /** 8. Login wall — sign-in form, no products. */
  login: `<!doctype html><html><body><form action="/login" method="post">
<input name="email" type="email"><input name="password" type="password">
<button>Sign in</button></form></body></html>`,

  /** 9. JS-SPA shell — mount div, no rendered content. */
  spa: `<!doctype html><html><body>
<div id="root"></div>
<script src="/assets/app-abc123.js"></script>
</body></html>`,

  /** 10. Plain blog page — no product structure at all. */
  blog: `<!doctype html><html><body>
<article><h1>My week in music</h1><p>Listening to lots of jazz lately, friends.</p></article>
</body></html>`,

  /** Both feed and platform marker — feed should win (probe order). */
  feedPlusShopify: `<!doctype html><html><head>
<link rel="alternate" type="application/atom+xml" href="/atom.xml">
</head><body><script src="https://cdn.shopify.com/x.js"></script></body></html>`,
};

const url = 'https://example-shop.test';

/* ------------------------------------------------------------------ *
 * Probe-order wins.
 * ------------------------------------------------------------------ */

test('feed discovery outranks everything else (cheapest signal first)', () => {
  const v = probeScannability({ url, html: FIXTURES.feed });
  assert.equal(v.scannable, true);
  assert.equal(v.method, 'feed');
  assert.equal(v.confidence, 'high');
  assert.match(v.detail, /\/feeds\/new-arrivals\.xml/);
});

test('probe order: feed wins when a page has both a feed and a platform marker', () => {
  const v = probeScannability({ url, html: FIXTURES.feedPlusShopify });
  assert.equal(v.method, 'feed');
});

test('Shopify storefront -> platform-api, high confidence', () => {
  const v = probeScannability({ url, html: FIXTURES.shopify });
  assert.equal(v.scannable, true);
  assert.equal(v.method, 'platform-api');
  assert.equal(v.confidence, 'high');
  assert.match(v.detail, /\/products\.json/);
});

test('Bandcamp page -> platform-api, high confidence', () => {
  const v = probeScannability({ url, html: FIXTURES.bandcamp });
  assert.equal(v.method, 'platform-api');
  assert.equal(v.confidence, 'high');
});

test('JSON-LD Product block -> structured-data, medium confidence', () => {
  const v = probeScannability({ url, html: FIXTURES.jsonld });
  assert.equal(v.scannable, true);
  assert.equal(v.method, 'structured-data');
  assert.equal(v.confidence, 'medium');
});

test('sitemap link -> sitemap, medium confidence', () => {
  const v = probeScannability({ url, html: FIXTURES.sitemap });
  assert.equal(v.method, 'sitemap');
  assert.equal(v.confidence, 'medium');
});

test('product grid with no structured signals -> heuristic, low, flagged fragile', () => {
  const v = probeScannability({ url, html: FIXTURES.grid });
  assert.equal(v.scannable, true);
  assert.equal(v.method, 'heuristic');
  assert.equal(v.confidence, 'low');
  assert.match(v.detail, /fragile/i);
});

/* ------------------------------------------------------------------ *
 * Hard rejections.
 * ------------------------------------------------------------------ */

test('Cloudflare challenge page -> NOT SCANNABLE, reason bot-wall', () => {
  const v = probeScannability({ url, html: FIXTURES.botwall });
  assert.equal(v.scannable, false);
  assert.equal(v.method, null);
  assert.equal(v.reason, 'bot-wall');
  assert.ok(v.detail.length > 0, 'verdict must carry a user-readable reason');
});

test('sign-in form with no products -> NOT SCANNABLE, reason login-required', () => {
  const v = probeScannability({ url, html: FIXTURES.login });
  assert.equal(v.scannable, false);
  assert.equal(v.reason, 'login-required');
});

test('empty JS mount div -> NOT SCANNABLE, reason js-spa', () => {
  const v = probeScannability({ url, html: FIXTURES.spa });
  assert.equal(v.scannable, false);
  assert.equal(v.reason, 'js-spa');
});

test('content page with no product structure -> NOT SCANNABLE, reason no-product-structure', () => {
  const v = probeScannability({ url, html: FIXTURES.blog });
  assert.equal(v.scannable, false);
  assert.equal(v.reason, 'no-product-structure');
});

test('empty document -> NOT SCANNABLE, reason no-product-structure', () => {
  const v = probeScannability({ url, html: '   ' });
  assert.equal(v.scannable, false);
  assert.equal(v.reason, 'no-product-structure');
});

/* ------------------------------------------------------------------ *
 * Contract shape.
 * ------------------------------------------------------------------ */

test('every verdict carries the full contract shape', () => {
  for (const html of Object.values(FIXTURES)) {
    const v = probeScannability({ url, html });
    assert.equal(typeof v.scannable, 'boolean');
    assert.ok(typeof v.detail === 'string' && v.detail.length > 0);
    if (v.scannable) {
      assert.ok(PROBE_METHODS.includes(v.method), `unknown method ${v.method}`);
      assert.ok(['high', 'medium', 'low'].includes(v.confidence));
      assert.equal(v.reason, null);
    } else {
      assert.equal(v.method, null);
      assert.ok(PROBE_FAILURE_REASONS.includes(v.reason), `unknown reason ${v.reason}`);
      assert.equal(v.confidence, 'none');
    }
  }
});

test('missing url throws — the verdict needs a page to talk about', () => {
  assert.throws(() => probeScannability({ html: FIXTURES.feed }), /url is required/);
});
