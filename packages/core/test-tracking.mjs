/**
 * Smoke/regression check for `packages/core/src/tracking.js`.
 *
 * Run: `node --test packages/core/test-tracking.mjs`
 * No dependencies beyond the Node standard library. Every probe input is a
 * hand-written fixture string — there is no live fetching here, ever. The
 * contract under test: adding a site stores the probe verdict; unscannable
 * sites are never silently accepted; per-site config (pause, interval floor)
 * behaves; free-tier caps hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  addSource,
  updateSource,
  removeSource,
  listSources,
  FREE_SOURCE_LIMIT,
  MIN_SCAN_INTERVAL_SECS,
  probeScannability,
} from './src/index.js';

/* ---------------------------------------------------------------- fixtures */

const SHOP_WITH_FEED = `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" title="New Arrivals" href="/feeds/new-arrivals.xml">
<title>Vinyl Den — New Arrivals</title></head>
<body><main class="products"><article><h2>Mingus Ah Um</h2><span>$34.99</span></article></main></body></html>`;

const SHOPIFY_STOREFRONT = `<!doctype html><html><head><title>Corner Records</title></head>
<body><script src="https://cdn.shopify.com/s/files/1/0000/t/1/assets/app.js"></script>
<main class="products"><article><h2>Kind of Blue</h2><span>$29.99</span></article></main></body></html>`;

const EMPTY_DOC = `<!doctype html><html><head><title>Nothing</title></head><body><p>hello</p></body></html>`;

function freshStore(plan = 'free') {
  const store = createStore();
  store.users.insert({
    id: 'usr_tracker', email: 'tracker@example.com', handle: 'tracker',
    display_name: 'Tracker', avatar_url: null,
    plan, trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  });
  const session = store.createSession('usr_tracker');
  return { store, token: session.token };
}

/* ------------------------------------------------------------------ tests */

test('adding a scannable site stores the probe verdict', () => {
  const { store, token } = freshStore();
  const src = addSource(token, { url: 'https://vinyl-den.example/new', label: 'Vinyl Den', html: SHOP_WITH_FEED }, { store });
  assert.equal(src.scannable, true);
  assert.equal(src.scan_method, 'feed');
  assert.equal(src.paused, false);
  assert.equal(src.scan_interval_secs, 60);
  assert.equal(src.consecutive_failures, 0);
  assert.ok(src.scannable_reason.includes('high confidence'));
});

test('adding the same URL twice returns the existing row', () => {
  const { store, token } = freshStore();
  const a = addSource(token, { url: 'https://vinyl-den.example/new', html: SHOP_WITH_FEED }, { store });
  const b = addSource(token, { url: 'https://vinyl-den.example/new', html: SHOP_WITH_FEED }, { store });
  assert.equal(a.id, b.id);
  assert.equal(listSources(token, { store }).length, 1);
});

test('an unscannable site is rejected unless the user explicitly opts in', () => {
  const { store, token } = freshStore();
  assert.equal(probeScannability({ url: 'https://flat.example/', html: EMPTY_DOC }).scannable, false);
  assert.throws(
    () => addSource(token, { url: 'https://flat.example/', html: EMPTY_DOC }, { store }),
    (err) => err.code === 'not_scannable' && err.status === 422,
  );
  // Explicit opt-in stores the verdict, visible on the dashboard.
  const kept = addSource(token, { url: 'https://flat.example/', html: EMPTY_DOC, accept_unscannable: true }, { store });
  assert.equal(kept.scannable, false);
  assert.equal(kept.scan_method, null);
  assert.ok(kept.scannable_reason.includes('no-product-structure'));
});

test('a site added without HTML is parked as not-probed-yet', () => {
  const { store, token } = freshStore();
  const src = addSource(token, { url: 'https://pending.example/' }, { store });
  assert.equal(src.scannable, false);
  assert.ok(src.scannable_reason.startsWith('not-probed-yet'));
});

test('junk URLs are rejected before any probe runs', () => {
  const { store, token } = freshStore();
  for (const bad of ['not a url', 'ftp://files.example/x', 'file:///etc/passwd', '']) {
    assert.throws(() => addSource(token, { url: bad, html: SHOP_WITH_FEED }, { store }),
      (err) => err.code === 'invalid_url');
  }
});

test('updateSource: pause, interval floor, method override', () => {
  const { store, token } = freshStore();
  const src = addSource(token, { url: 'https://vinyl-den.example/new', html: SHOP_WITH_FEED }, { store });

  const paused = updateSource(token, src.id, { paused: true }, { store });
  assert.equal(paused.paused, true);

  const fast = updateSource(token, src.id, { scan_interval_secs: 5 }, { store });
  assert.equal(fast.scan_interval_secs, MIN_SCAN_INTERVAL_SECS);

  const slow = updateSource(token, src.id, { scan_interval_secs: 3600 }, { store });
  assert.equal(slow.scan_interval_secs, 3600);

  const overridden = updateSource(token, src.id, { scan_method: 'sitemap' }, { store });
  assert.equal(overridden.scan_method, 'sitemap');

  assert.throws(() => updateSource(token, src.id, { scan_method: 'smoke-signals' }, { store }),
    (err) => err.code === 'invalid_scan_method');
  assert.throws(() => updateSource(token, 'src_nope', { paused: true }, { store }),
    (err) => err.status === 404);
});

test('removeSource is idempotent and scoped to the owner', () => {
  const { store, token } = freshStore();
  const src = addSource(token, { url: 'https://vinyl-den.example/new', html: SHOP_WITH_FEED }, { store });
  assert.equal(removeSource(token, src.id, { store }).removed, 1);
  assert.equal(removeSource(token, src.id, { store }).removed, 0);
  assert.equal(listSources(token, { store }).length, 0);
});

test('free tier caps tracked sites; series tier does not', () => {
  const { store, token } = freshStore('free');
  for (let i = 0; i < FREE_SOURCE_LIMIT; i += 1) {
    addSource(token, { url: `https://shop${i}.example/`, html: SHOPIFY_STOREFRONT }, { store });
  }
  assert.throws(
    () => addSource(token, { url: 'https://one-too-many.example/', html: SHOPIFY_STOREFRONT }, { store }),
    (err) => err.code === 'source_limit' && err.status === 402,
  );

  const paid = freshStore('series');
  for (let i = 0; i < FREE_SOURCE_LIMIT + 2; i += 1) {
    addSource(paid.token, { url: `https://shop${i}.example/`, html: SHOPIFY_STOREFRONT }, { store: paid.store });
  }
  assert.equal(listSources(paid.token, { store: paid.store }).length, FREE_SOURCE_LIMIT + 2);
});

test('sites are isolated between users', () => {
  const { store, token } = freshStore();
  const other = store.createSession(store.users.insert({
    id: 'usr_other', email: 'other@example.com', handle: 'other',
    display_name: 'Other', avatar_url: null,
    plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  }).id);
  const src = addSource(token, { url: 'https://vinyl-den.example/new', html: SHOP_WITH_FEED }, { store });
  assert.equal(listSources(other.token, { store }).length, 0);
  assert.equal(removeSource(other.token, src.id, { store }).removed, 0);
  assert.equal(store.sources.count(), 1);
});
