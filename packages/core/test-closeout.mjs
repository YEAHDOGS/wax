/**
 * Smoke/regression check for `packages/core/src/closeout.js` — the
 * worker's per-pass pipeline after `runScanPass` (ALERT-ENGINE-PLAN.md §3,
 * the wiring between the scan worker and the digest queue).
 *
 * Run: `node --test packages/core/test-closeout.mjs`
 * No dependencies beyond the Node standard library. The fetcher and the
 * channels are injected fixtures — there is no live HTTP and no real
 * provider here, ever. These tests pin the properties the close-out
 * exists for:
 *
 * 1. One tick end to end: scan → dispatch → persisted alert rows with
 *    receipts. A held-back flood lands in the digest queue, and the flush
 *    folds it into one digest email — nothing held is ever silently
 *    dropped.
 * 2. Quiet hours: the digest never leaves while the user sleeps; the
 *    queued rows survive for the next flush.
 * 3. Retry safety: re-feeding the same pass's items never double-sends —
 *    the persisted alert row is the exactly-once marker.
 * 4. The tick never throws: a missing channel is a failed receipt, not a
 *    crash, and a failed send may retry on a later pass.
 *
 * If any of them fail, the scan→dispatch→digest pipeline has a gap, and
 * that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  runWorkerTick,
  runAlertCloseout,
  filterAlreadyAlerted,
  EMAIL_PER_HOUR_CAP,
} from './src/index.js';

/* ------------------------------------------------------------------ * Fixtures: one free user watching Miles Davis, one merch site. * ------------------------------------------------------------------ */

/** 12:00 UTC — well outside any quiet window. */
const AWAKE_NOW = Date.parse('2026-09-09T12:00:00Z');

function makeData(quiet = false) {
  return {
    users: [
      {
        id: 'usr_1', email: 'a@example.com', handle: 'a', display_name: 'A',
        plan: 'free', phone: null, phone_verified: false, email_verified: true,
        ...(quiet ? { quiet_hours_start: '22:00', quiet_hours_end: '07:00' } : {}),
      },
    ],
    profiles: [],
    follows: [],
    artists: [
      { id: 'art_miles', name: 'Miles Davis', discogs_artist_id: 1, image_url: null, genres: [] },
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
    ],
    watches: [
      { id: 'wtc_1', user_id: 'usr_1', artist_id: 'art_miles', watch_vinyl: true, merch_types: [], target_price_cents: null, channels: ['email'] },
    ],
    alerts: [],
    crateItems: [],
    wantlistItems: [],
    pricePoints: [],
    activity: [],
  };
}

const drop = (i) => ({
  title: `Kind of Blue — 180g Vinyl LP #${i}`,
  vendor: 'Miles Davis',
  url: `/products/kind-of-blue-${i}`,
  image: { src: 'https://cdn/x.jpg' },
  price: '$29.99',
});

/** Fetcher fixture: tick N sees `lists[N]`. */
function fixtureFetcher(lists) {
  return async (source) => ({ status: 200, rawList: lists[source.id] ?? [] });
}

/** Email channel fixture: records sends, never touches a network. */
function mockEmail(sent) {
  return {
    name: 'mock-email',
    kind: 'email',
    async send({ to, message, nowMs }) {
      sent.push({ to, message, at: nowMs });
      return { ok: true, channel: 'email', messageId: `mock_${sent.length}`, sentAt: new Date(nowMs).toISOString() };
    },
  };
}

/* ------------------------------------------------------------------ * The full tick: scan → dispatch → persisted rows with receipts. * ------------------------------------------------------------------ */

test('runWorkerTick: a new drop is dispatched and persisted with receipts', async () => {
  const store = createStore(makeData());
  const sent = [];
  const channels = { email: mockEmail(sent) };
  const baseline = [drop(0)];

  const t1 = await runWorkerTick({ store, fetcher: fixtureFetcher({ src_den: baseline }), channels, nowMs: AWAKE_NOW });
  assert.equal(t1.newAlerts, 0, 'baseline pass alerts nobody');
  assert.equal(t1.dispatched, 0);
  assert.equal(sent.length, 0);

  // One minute later the site has one new item; the interval is 60s so it is due.
  const t2 = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [...baseline, drop(1)] }),
    channels,
    nowMs: AWAKE_NOW + 61_000,
  });
  assert.equal(t2.newAlerts, 1);
  assert.equal(t2.dispatched, 1);
  assert.equal(sent.length, 1, 'one drop email left');
  assert.equal(sent[0].to, 'a@example.com');
  assert.match(sent[0].message.subject, /Miles Davis/i);

  assert.equal(store.alerts.all().length, 1, 'alert row persisted');
  const row = store.alerts.all()[0];
  assert.ok(row.dispatched_at, 'row is stamped');
  assert.deepEqual(row.channels, ['email']);
  assert.ok((row.dispatches ?? []).some((r) => r.ok === true && r.channel === 'email'), 'receipt recorded');

  const dispatchLogs = store.scanLogs.all().filter((l) => l.outcome === 'dispatch');
  assert.equal(dispatchLogs.length, 1, 'scan log carries the dispatch receipt');
});

/* ------------------------------------------------------------------ * The flood: rate-held deliveries land in the digest queue, * then leave as one digest email. * ------------------------------------------------------------------ */

test('runWorkerTick: a restock flood folds into one digest email', async () => {
  const store = createStore(makeData());
  const sent = [];
  const channels = { email: mockEmail(sent) };
  const baseline = [drop(0)];

  await runWorkerTick({ store, fetcher: fixtureFetcher({ src_den: baseline }), channels, nowMs: AWAKE_NOW });

  const flood = Array.from({ length: EMAIL_PER_HOUR_CAP + 5 }, (_, i) => drop(100 + i));
  const tick = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [...baseline, ...flood] }),
    channels,
    nowMs: AWAKE_NOW + 61_000,
  });

  assert.equal(tick.newAlerts, flood.length);
  assert.equal(tick.queued, 5, 'the five over-cap deliveries queued for the digest');
  assert.equal(store.digestQueue.all().length, 0, 'queue was flushed by the same tick');

  const digests = tick.digestUsers;
  assert.equal(digests.length, 1);
  assert.equal(digests[0].sent, true);
  assert.equal(digests[0].items, 5);
  assert.equal(sent.length, EMAIL_PER_HOUR_CAP + 1, '60 sends + 1 digest email, nothing lost');

  const digestSend = sent.at(-1);
  assert.match(digestSend.message.subject, /digest/i);
  assert.match(digestSend.message.text, /Kind of Blue/i);
});

/* ------------------------------------------------------------------ * Quiet hours: the digest waits; the queue survives. * ------------------------------------------------------------------ */

test('runWorkerTick: quiet hours hold the digest, nothing leaves at 3am', async () => {
  const store = createStore(makeData(true));
  const sent = [];
  const channels = { email: mockEmail(sent) };
  const baseline = [drop(0)];

  // 02:00 UTC — inside the 22:00–07:00 quiet window.
  const QUIET_NOW = Date.parse('2026-09-09T02:00:00Z');

  await runWorkerTick({ store, fetcher: fixtureFetcher({ src_den: baseline }), channels, nowMs: QUIET_NOW });

  const flood = Array.from({ length: EMAIL_PER_HOUR_CAP + 2 }, (_, i) => drop(200 + i));
  const tick = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [...baseline, ...flood] }),
    channels,
    nowMs: QUIET_NOW + 61_000,
  });

  assert.equal(tick.queued, 2);
  assert.equal(tick.digestUsers[0].sent, false, 'digest held during quiet hours');
  assert.match(tick.digestUsers[0].reason, /quiet hours/i);
  assert.equal(store.digestQueue.all().length, 2, 'queue survives the held flush');
  assert.ok(sent.length <= EMAIL_PER_HOUR_CAP, 'only the rate-allowed sends left');
});

/* ------------------------------------------------------------------ * Retry safety: the same pass twice never double-sends. * ------------------------------------------------------------------ */

test('runAlertCloseout: re-feeding the same items is a no-op, not a duplicate', async () => {
  const store = createStore(makeData());
  const sent = [];
  const channels = { email: mockEmail(sent) };
  const fetcher = fixtureFetcher({ src_den: [drop(0), drop(1)] });

  await runWorkerTick({ store, fetcher, channels, nowMs: AWAKE_NOW }); // baseline
  const tick = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [drop(0), drop(1), drop(2)] }),
    channels,
    nowMs: AWAKE_NOW + 61_000,
  });
  assert.equal(tick.dispatched, 1);

  // The worker crashed between dispatch and flush; the same feed is fed again.
  // (A fresh title the tick never saw, so the first closeout really dispatches.)
  const item = {
    user_id: 'usr_1', artist_id: 'art_miles', artist_name: 'Miles Davis',
    title: 'Kind of Blue — 180g Vinyl LP #3', price_cents: 2999,
    listing_url: 'https://vinylden.example/products/kind-of-blue-3',
    deliveries: [
      { channel: 'email', message: { subject: 'x', text: 'y' }, verdict: { dispatch: true } },
    ],
  };
  const first = await runAlertCloseout({ store, alerts: [item], channels, nowMs: AWAKE_NOW + 62_000 });
  assert.equal(first.dispatched, 1);

  const retry = await runAlertCloseout({ store, alerts: [item], channels, nowMs: AWAKE_NOW + 63_000 });
  assert.equal(retry.dispatched, 0);
  assert.equal(retry.dedupeDropped, 1, 'already-told item dropped, not re-sent');
});

/* ------------------------------------------------------------------ * filterAlreadyAlerted: failed sends are retryable, not swallowed. * ------------------------------------------------------------------ */

test('filterAlreadyAlerted: a failed send may retry; a sent one never doubles', () => {
  const store = createStore(makeData());
  const item = (title) => ({ user_id: 'usr_1', artist_name: 'Miles Davis', title });

  store.alerts.insert({
    id: 'alr_sent', user_id: 'usr_1', artist_name: 'Miles Davis', title: 'Sent LP',
    dispatched_at: new Date(AWAKE_NOW).toISOString(), channels: ['email'], dispatches: [],
  });
  store.alerts.insert({
    id: 'alr_failed', user_id: 'usr_1', artist_name: 'Miles Davis', title: 'Failed LP',
    dispatched_at: new Date(AWAKE_NOW).toISOString(), channels: [], dispatches: [{ ok: false }],
  });

  const { fresh, dedupeDropped } = filterAlreadyAlerted(store, [item('Sent LP'), item('Failed LP'), item('New LP')]);
  assert.deepEqual(fresh.map((a) => a.title), ['Failed LP', 'New LP'], 'failed send retries, sent one drops');
  assert.equal(dedupeDropped, 1);
});

/* ------------------------------------------------------------------ * The tick never throws. * ------------------------------------------------------------------ */

test('runWorkerTick: no channels configured is a failed receipt, not a crash', async () => {
  const store = createStore(makeData());
  await runWorkerTick({ store, fetcher: fixtureFetcher({ src_den: [drop(0)] }), channels: {}, nowMs: AWAKE_NOW });

  const tick = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [drop(0), drop(1)] }),
    channels: {},
    nowMs: AWAKE_NOW + 61_000,
  });
  assert.equal(tick.dispatched, 1);
  assert.equal(tick.receipts, 1);
  const row = store.alerts.all()[0];
  assert.ok((row.dispatches ?? []).some((r) => r.ok === false && String(r.error ?? '').includes('no channel')), 'missing channel recorded as a failed receipt');
  assert.equal(tick.queued, 0, 'failed (not held) deliveries are not digest-queued');
});
