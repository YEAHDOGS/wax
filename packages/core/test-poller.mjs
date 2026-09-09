/**
 * Smoke/regression check for `packages/core/src/poller.js` — the scan worker
 * (ALERT-ENGINE-PLAN.md §2).
 *
 * Run: `node --test packages/core/test-poller.mjs`
 * No dependencies beyond the Node standard library. The fetcher is an
 * injected fixture — there is no live HTTP here, ever. These tests pin the
 * worker's contract: which sources are due, how a baseline is stored, how
 * new drops become alerts, how failures back off, and how the rate gate
 * folds a flood into the digest. If any of them fail, the scan contract
 * with the alert engine has changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  USER_AGENT,
  BASE_SCAN_INTERVAL_SECS,
  MAX_SCAN_INTERVAL_SECS,
  canFetch,
  selectDueSources,
  escalateIntervalSecs,
  scanOneSource,
  runScanPass,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures: a user watching Miles Davis, two merch sites.
 * ------------------------------------------------------------------ */

const T0 = Date.parse('2026-09-09T11:00:00.000Z');

function makeData() {
  return {
    users: [
      {
        id: 'usr_1', email: 'a@example.com', handle: 'a', display_name: 'A',
        plan: 'free', phone: null, phone_verified: false, email_verified: true,
      },
      {
        id: 'usr_series', email: 's@example.com', handle: 's', display_name: 'S',
        plan: 'series', phone: '+15550123456', phone_verified: true, email_verified: true,
      },
    ],
    profiles: [],
    follows: [],
    artists: [
      { id: 'art_miles', name: 'Miles Davis', discogs_artist_id: 1, image_url: null, genres: [] },
      { id: 'art_coltrane', name: 'John Coltrane', discogs_artist_id: 2, image_url: null, genres: [] },
    ],
    releases: [],
    tracks: [],
    sources: [
      {
        id: 'src_den', user_id: 'usr_1', url: 'https://vinylden.example/new',
        label: 'Vinyl Den', platform: 'shopify', scan_method: 'platform-api',
        scannable: true, scannable_reason: 'Shopify /products.json',
        snapshot_hash: null, scan_interval_secs: 60, paused: false,
        last_scan_at: null, consecutive_failures: 0,
      },
      {
        id: 'src_corner', user_id: 'usr_1', url: 'https://corner.example/feed.xml',
        label: 'Jazz Corner', platform: 'unknown', scan_method: 'feed',
        scannable: true, scannable_reason: 'RSS new-arrivals feed',
        snapshot_hash: null, scan_interval_secs: 60, paused: false,
        last_scan_at: null, consecutive_failures: 0,
      },
      {
        id: 'src_series', user_id: 'usr_series', url: 'https://serieshop.example/new',
        label: 'Serie Shop', platform: 'shopify', scan_method: 'platform-api',
        scannable: true, scannable_reason: 'Shopify /products.json',
        snapshot_hash: null, scan_interval_secs: 60, paused: false,
        last_scan_at: null, consecutive_failures: 0,
      },
    ],
    watches: [
      { id: 'wtc_1', user_id: 'usr_1', artist_id: 'art_miles', watch_vinyl: true, merch_types: [], target_price_cents: null, channels: ['email'] },
      { id: 'wtc_s', user_id: 'usr_series', artist_id: 'art_miles', watch_vinyl: true, merch_types: [], target_price_cents: null, channels: ['email', 'sms'] },
    ],
    alerts: [],
    crateItems: [],
    wantlistItems: [],
    pricePoints: [],
    activity: [],
  };
}

/** Shopify-shaped raw records, one per scan-method fixture. */
const SHOPIFY_LIST = [
  { title: 'Kind of Blue — 180g Vinyl LP', vendor: 'Miles Davis', url: '/products/kind-of-blue', image: { src: 'https://cdn/x.jpg' }, price: '$29.99' },
  { title: 'Bitches Brew Limited Edition', vendor: 'Miles Davis', url: '/products/bitches-brew', image: { src: 'https://cdn/y.jpg' }, price: '$44.99' },
];

const FEED_LIST = [
  { name: 'A Love Supreme LP', brand: 'Miles Davis', link: 'https://corner.example/lp/als', thumbnail: 'https://corner.example/t.jpg', price_cents: 2799 },
];

/** An injected fetcher over fixture lists. Rejects or 429s when told to. */
function fixtureFetcher({ lists = {}, failWith = null } = {}) {
  return async (source) => {
    if (failWith === 'throw') throw new Error('connection reset');
    if (failWith === '429') return { status: 429, rawList: [] };
    if (failWith === '500') return { status: 500, rawList: [] };
    return { status: 200, rawList: lists[source.id] ?? [] };
  };
}

/* ------------------------------------------------------------------ *
 * The queue: who is due.
 * ------------------------------------------------------------------ */

test('selectDueSources: unscannable, paused, and not-yet-due sources are skipped', () => {
  const due = selectDueSources([
    { id: 'a', scannable: true, paused: false, scan_method: 'feed', url: 'https://a.example/', scan_interval_secs: 60, last_scan_at: null },
    { id: 'b', scannable: false, paused: false, scan_method: null, url: 'https://b.example/', scan_interval_secs: 60, last_scan_at: null },
    { id: 'c', scannable: true, paused: true, scan_method: 'feed', url: 'https://c.example/', scan_interval_secs: 60, last_scan_at: null },
    { id: 'd', scannable: true, paused: false, scan_method: 'feed', url: 'https://d.example/', scan_interval_secs: 3600, last_scan_at: new Date(T0 - 60_000).toISOString() },
    { id: 'e', scannable: true, paused: false, scan_method: 'feed', url: 'file:///etc/passwd', scan_interval_secs: 60, last_scan_at: null },
    { id: 'f', scannable: true, paused: false, scan_method: 'feed', url: 'https://f.example/', scan_interval_secs: 60, last_scan_at: new Date(T0 - 61_000).toISOString() },
  ], T0);
  assert.deepEqual(due.map((s) => s.id), ['a', 'f']);
});

test('selectDueSources: never-scanned sources sort before scanned ones', () => {
  const due = selectDueSources([
    { id: 'old', scannable: true, paused: false, scan_method: 'feed', url: 'https://o.example/', scan_interval_secs: 60, last_scan_at: new Date(T0 - 3600_000).toISOString() },
    { id: 'new', scannable: true, paused: false, scan_method: 'feed', url: 'https://n.example/', scan_interval_secs: 60, last_scan_at: null },
  ], T0);
  assert.equal(due[0].id, 'new');
});

test('canFetch: only http(s) URLs are fetchable', () => {
  assert.equal(canFetch('https://shop.example/new'), true);
  assert.equal(canFetch('http://shop.example/new'), true);
  assert.equal(canFetch('file:///etc/passwd'), false);
  assert.equal(canFetch('ftp://shop.example/x'), false);
  assert.equal(canFetch('not a url'), false);
  assert.equal(canFetch(null), false);
});

test('escalateIntervalSecs: doubles, floored at the polite minimum, capped at one day', () => {
  assert.equal(escalateIntervalSecs(60), 120);
  assert.equal(escalateIntervalSecs(3600), 7200);
  assert.equal(escalateIntervalSecs(0), BASE_SCAN_INTERVAL_SECS * 2);
  assert.equal(escalateIntervalSecs(MAX_SCAN_INTERVAL_SECS), MAX_SCAN_INTERVAL_SECS);
  assert.equal(escalateIntervalSecs(MAX_SCAN_INTERVAL_SECS * 4), MAX_SCAN_INTERVAL_SECS);
});

test('USER_AGENT identifies the bot per the plan', () => {
  assert.match(USER_AGENT, /^WaxBot\/1\.0/);
  assert.match(USER_AGENT, /wax\.wearedogs\.net/);
});

/* ------------------------------------------------------------------ *
 * One pass: baseline, diffing, alerts.
 * ------------------------------------------------------------------ */

test('first scan is a baseline: snapshot stored, nothing alerts', async () => {
  const store = createStore(makeData());
  const pass = await runScanPass({
    store,
    fetcher: fixtureFetcher({ lists: { src_den: SHOPIFY_LIST, src_corner: FEED_LIST } }),
    nowMs: T0,
  });
  assert.equal(pass.due, 3);
  assert.equal(pass.succeeded, 3);
  assert.equal(pass.newAlerts, 0);

  const src = store.sources.find((s) => s.id === 'src_den');
  assert.ok(src.snapshot_hash, 'snapshot_hash persisted');
  assert.equal(src.consecutive_failures, 0);
  assert.ok(src.last_scan_at, 'last_scan_at stamped');

  const snap = store.scanSnapshots.find((s) => s.source_id === 'src_den');
  assert.equal(snap.products.length, 2);
  assert.equal(snap.hash, src.snapshot_hash);

  const log = store.scanLogs.find((l) => l.source_id === 'src_den');
  assert.equal(log.outcome, 'ok');
  assert.equal(log.baseline, true);
  assert.equal(log.parsed, 2);
  assert.equal(log.added, 2); // scanSnapshot sees everything as new on a baseline…
  // …but the worker queues no alerts for it.
});

test('unchanged second scan: no alerts, added=0', async () => {
  const store = createStore(makeData());
  const fetcher = fixtureFetcher({ lists: { src_den: SHOPIFY_LIST, src_corner: FEED_LIST } });
  await runScanPass({ store, fetcher, nowMs: T0 });
  const pass = await runScanPass({ store, fetcher, nowMs: T0 + 61_000 });
  assert.equal(pass.newAlerts, 0);
  const log = store.scanLogs.filter((l) => l.source_id === 'src_den').at(-1);
  assert.equal(log.baseline, false);
  assert.equal(log.hash_changed, false);
  assert.equal(log.added, 0);
  assert.equal(log.unchanged, 2);
});

test('new item on a rescan becomes one alert with email content and a dispatch verdict', async () => {
  const store = createStore(makeData());
  const fetcher = fixtureFetcher({ lists: { src_den: SHOPIFY_LIST, src_corner: FEED_LIST } });
  await runScanPass({ store, fetcher, nowMs: T0 });

  const restock = [...SHOPIFY_LIST, { title: 'Time Out LP', vendor: 'Miles Davis', url: '/products/time-out', price: '$24.99' }];
  const fetcher2 = fixtureFetcher({ lists: { src_den: restock, src_corner: FEED_LIST } });
  const pass = await runScanPass({ store, fetcher: fetcher2, nowMs: T0 + 61_000 });

  assert.equal(pass.newAlerts, 1);
  const [alert] = pass.alerts;
  assert.equal(alert.kind, 'drop');
  assert.equal(alert.artist_name, 'Miles Davis');
  assert.equal(alert.title, 'Time Out LP');
  assert.equal(alert.price_cents, 2499);
  assert.deepEqual(alert.sources_seen, ['src_den']);

  const email = alert.deliveries.find((d) => d.channel === 'email');
  assert.ok(email, 'email delivery present for the default channel');
  assert.match(email.message.subject, /Miles Davis/);
  assert.match(email.message.text, /Time Out LP/);
  assert.match(email.message.text, /\$24\.99/);
  assert.equal(email.verdict.dispatch, true);
  assert.equal(alert.deliveries.some((d) => d.channel === 'sms'), false);
});

test('same drop on two sources is one alert with sources_seen=[both]', async () => {
  const store = createStore(makeData());
  const both = fixtureFetcher({ lists: { src_den: [], src_corner: [] } });
  await runScanPass({ store, fetcher: both, nowMs: T0 });

  const drop = { title: 'Kind of Blue — 180g Vinyl LP', vendor: 'Miles Davis', url: '/x', price: '$29.99' };
  const cornerDrop = { name: 'Kind of Blue LP', brand: 'Miles Davis', link: 'https://corner.example/kob', price_cents: 2999 };
  const fetcher3 = fixtureFetcher({ lists: { src_den: [drop], src_corner: [cornerDrop] } });
  const pass = await runScanPass({ store, fetcher: fetcher3, nowMs: T0 + 61_000 });

  assert.equal(pass.newAlerts, 1);
  assert.deepEqual(pass.alerts[0].sources_seen, ['src_den', 'src_corner']);
});

test('drops by unwatched artists never alert', async () => {
  const store = createStore(makeData());
  await runScanPass({ store, fetcher: fixtureFetcher({ lists: {} }), nowMs: T0 });
  const coltraneDrop = [{ title: 'Giant Steps LP', vendor: 'John Coltrane', url: '/x', price: '$30.00' }];
  // NOTE: Coltrane IS an artist row but has no watch — still no alert.
  const pass = await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_den: coltraneDrop } }), nowMs: T0 + 61_000 });
  assert.equal(pass.newAlerts, 0);
});

/* ------------------------------------------------------------------ *
 * Failures: backoff, scan log, recovery.
 * ------------------------------------------------------------------ */

test('fetch failure: backoff doubles, failure counted, scan logged, no alerts', async () => {
  const store = createStore(makeData());
  const r1 = await scanOneSource({ store, source: store.sources.find((s) => s.id === 'src_den'), fetcher: fixtureFetcher({ failWith: 'throw' }), nowMs: T0 });
  assert.equal(r1.ok, false);
  assert.equal(r1.matches.length, 0);
  assert.equal(r1.log.outcome, 'fetch_failed');

  let src = store.sources.find((s) => s.id === 'src_den');
  assert.equal(src.consecutive_failures, 1);
  assert.equal(src.scan_interval_secs, 120);
  assert.ok(src.last_scan_at);

  const r2 = await scanOneSource({ store, source: src, fetcher: fixtureFetcher({ failWith: '429' }), nowMs: T0 + 61_000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.log.outcome, 'fetch_failed');
  src = store.sources.find((s) => s.id === 'src_den');
  assert.equal(src.consecutive_failures, 2);
  assert.equal(src.scan_interval_secs, 240);
});

test('a 5xx is a failure for backoff; a 404 is not retried as one', async () => {
  const store = createStore(makeData());
  const r = await scanOneSource({ store, source: store.sources.find((s) => s.id === 'src_den'), fetcher: fixtureFetcher({ failWith: '500' }), nowMs: T0 });
  assert.equal(r.ok, false);
  assert.equal(store.sources.find((s) => s.id === 'src_den').consecutive_failures, 1);
});

test('success after failures clears the counter but leaves the interval alone', async () => {
  const store = createStore(makeData());
  await scanOneSource({ store, source: store.sources.find((s) => s.id === 'src_den'), fetcher: fixtureFetcher({ failWith: 'throw' }), nowMs: T0 });
  let src = store.sources.find((s) => s.id === 'src_den');
  assert.equal(src.scan_interval_secs, 120);

  const r = await scanOneSource({ store, source: src, fetcher: fixtureFetcher({ lists: { src_den: SHOPIFY_LIST } }), nowMs: T0 + 61_000 });
  assert.equal(r.ok, true);
  src = store.sources.find((s) => s.id === 'src_den');
  assert.equal(src.consecutive_failures, 0);
  assert.equal(src.scan_interval_secs, 120, 'engine never silently re-arms the fast lane');
});

test('scanOneSource never throws: a broken fetcher is a logged failure', async () => {
  const store = createStore(makeData());
  const bad = async () => { throw new Error('kaboom'); };
  const r = await scanOneSource({ store, source: store.sources.find((s) => s.id === 'src_den'), fetcher: bad, nowMs: T0 });
  assert.equal(r.ok, false);
  assert.match(r.log.error, /kaboom/);
});

/* ------------------------------------------------------------------ *
 * The notify path: rate gate and tier rules.
 * ------------------------------------------------------------------ */

test('rate cap hit: the alert still returns, folded into the digest', async () => {
  const data = makeData();
  // Sixty dispatches in the last hour — the email cap.
  for (let i = 0; i < 60; i += 1) {
    data.alerts.push({
      id: `alr_old_${i}`, user_id: 'usr_1', release_id: 'rel_x', kind: 'drop',
      state: 'live', detected_at: new Date(T0 - 30 * 60_000).toISOString(),
      dispatched_at: new Date(T0 - 30 * 60_000).toISOString(),
      channels: ['email'], listing_url: 'https://x.example/', price_cents: 1000,
    });
  }
  const store = createStore(data);
  await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_den: SHOPIFY_LIST } }), nowMs: T0 });

  const restock = [...SHOPIFY_LIST, { title: 'Time Out LP', vendor: 'Miles Davis', url: '/products/time-out', price: '$24.99' }];
  const pass = await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_den: restock } }), nowMs: T0 + 61_000 });
  assert.equal(pass.newAlerts, 1);
  const email = pass.alerts[0].deliveries.find((d) => d.channel === 'email');
  assert.equal(email.verdict.dispatch, false);
  assert.match(email.verdict.reason, /digest/);
  assert.ok(email.message, 'content is composed even when dispatch is deferred');
});

test('a flood inside one pass folds into the digest instead of slipping past the gate', async () => {
  const store = createStore(makeData());
  await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_den: [] } }), nowMs: T0 });

  const flood = Array.from({ length: 70 }, (_, i) => ({
    title: `Miles Bootleg Vol ${i} LP`, vendor: 'Miles Davis', url: `/products/boot-${i}`, price: '$19.99',
  }));
  const pass = await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_den: flood } }), nowMs: T0 + 61_000 });
  assert.equal(pass.newAlerts, 70);
  const dispatched = pass.alerts.flatMap((a) => a.deliveries).filter((d) => d.verdict.dispatch);
  const folded = pass.alerts.flatMap((a) => a.deliveries).filter((d) => !d.verdict.dispatch);
  assert.equal(dispatched.length, 60, 'the email hourly cap holds inside a single pass');
  assert.equal(folded.length, 10);
  assert.ok(folded.every((d) => /digest/.test(d.verdict.reason)));
});

test('series user gets SMS; free user never does', async () => {
  const store = createStore(makeData());
  await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_series: [] } }), nowMs: T0 });
  const drop = [{ title: 'Sketches of Spain LP', vendor: 'Miles Davis', url: '/products/sos', price: '$32.99' }];
  const pass = await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_series: drop } }), nowMs: T0 + 61_000 });
  assert.equal(pass.newAlerts, 1);
  const sms = pass.alerts[0].deliveries.find((d) => d.channel === 'sms');
  assert.ok(sms, 'sms delivery present for a verified series user watching sms');
  assert.equal(sms.verdict.dispatch, true);
  assert.ok(sms.message.length <= 160, 'single-segment SMS');
});

test('unverified phone: sms delivery explains itself instead of sending', async () => {
  const data = makeData();
  data.users.find((u) => u.id === 'usr_series').phone_verified = false;
  const store = createStore(data);
  await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_series: [] } }), nowMs: T0 });
  const drop = [{ title: 'Sketches of Spain LP', vendor: 'Miles Davis', url: '/products/sos', price: '$32.99' }];
  const pass = await runScanPass({ store, fetcher: fixtureFetcher({ lists: { src_series: drop } }), nowMs: T0 + 61_000 });
  const sms = pass.alerts[0].deliveries.find((d) => d.channel === 'sms');
  assert.equal(sms.verdict.dispatch, false);
  assert.match(sms.verdict.reason, /not verified/);
});
