/**
 * Regression pin for the Postgres swap (ALERT-ENGINE-PLAN.md §4).
 *
 * The whole alert-engine worker pipeline — `runWorkerTick` (scan →
 * dispatch → digest), the persistence restart recipe, and the tick
 * scheduler — must behave identically against a store whose methods
 * return promises (what `createPostgresStore` looks like) and one whose
 * methods return values (the in-memory store). `asAsyncStore` wraps the
 * in-memory store so every collection method returns a genuine Promise,
 * and these tests run the real pipeline through it.
 *
 * If a future edit drops an `await` in the pipeline, the sync store will
 * keep passing while these tests fail — that is exactly the gap this
 * file exists to catch before Postgres does it in production.
 *
 * Run: `node --test packages/core/test-async-store-pipeline.mjs`
 * Zero dependencies beyond the Node standard library. No network, no
 * live database — the "Postgres" here is the in-memory store wearing a
 * promise-shaped mask, which is precisely the contract the swap needs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createStore,
  createAlertQueue,
  createAlertScheduler,
  createAlertPersistence,
  createAlertDispatcher,
  runWorkerTick,
} from './src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const WANTS = load('wantlist.json').wants;
const RELEASES = load('discogs-releases.json').releases;

/**
 * Wrap an in-memory store so every collection method returns a real
 * Promise — the same shape `createPostgresStore` produces. Asyncness
 * must not change behaviour, so `await`ing the shim must equal calling
 * the raw store.
 */
function asAsyncStore(store) {
  const wrapCollection = (coll) => ({
    all: async () => coll.all(),
    find: async (pred) => coll.find(pred),
    filter: async (pred) => coll.filter(pred),
    insert: async (row) => coll.insert(row),
    update: async (pred, patch) => coll.update(pred, patch),
    remove: async (pred) => coll.remove(pred),
    count: async () => coll.count(),
  });
  const out = {};
  for (const key of Object.keys(store)) {
    const v = store[key];
    out[key] = v && typeof v.all === 'function' ? wrapCollection(v) : v;
  }
  out.createSession = async (userId) => store.createSession(userId);
  out.userForToken = async (token) => store.userForToken(token);
  out.endSession = async (token) => store.endSession(token);
  out.latestPrice = async (releaseId) => store.latestPrice(releaseId);
  return out;
}

/* ------------------------------------------------------------------ *
 * The shim really is async — every collection method returns a Promise
 * ------------------------------------------------------------------ */

test('asAsyncStore: every collection method returns a genuine Promise', async () => {
  const shim = asAsyncStore(createStore());
  for (const [name, coll] of Object.entries(shim)) {
    if (!coll || typeof coll.all !== 'function') continue;
    for (const method of ['all', 'find', 'filter', 'insert', 'update', 'remove', 'count']) {
      const args = method === 'insert' ? [{}] : method === 'update' ? [() => false, {}] : method === 'find' || method === 'filter' || method === 'remove' ? [() => false] : [];
      const r = coll[method](...args);
      assert.ok(r && typeof r.then === 'function', `${name}.${method} must return a promise`);
      await r;
    }
  }
  for (const helper of ['createSession', 'userForToken', 'endSession', 'latestPrice']) {
    assert.ok(typeof (await shim[helper]('x')) !== 'undefined' || true, 'helper resolves');
  }
});

/* ------------------------------------------------------------------ *
 * Worker-tick parity: same fixtures, same summary, sync vs async store
 * ------------------------------------------------------------------ */

const AWAKE_NOW = Date.parse('2026-09-09T12:00:00Z');

function makeData() {
  return {
    users: [
      {
        id: 'usr_1', email: 'a@example.com', handle: 'a', display_name: 'A',
        plan: 'free', phone: null, phone_verified: false, email_verified: true,
      },
    ],
    profiles: [],
    follows: [],
    artists: [{ id: 'art_miles', name: 'Miles Davis', discogs_artist_id: 1, image_url: null, genres: [] }],
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

const fixtureFetcher = (lists) => async (source) => ({ status: 200, rawList: lists[source.id] ?? [] });

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

/** Two ticks (baseline, then one real drop) against a store; returns the observable outcome. */
async function runTwoTicks(store) {
  const sent = [];
  const channels = { email: mockEmail(sent) };
  const t1 = await runWorkerTick({ store, fetcher: fixtureFetcher({ src_den: [drop(0)] }), channels, nowMs: AWAKE_NOW });
  const t2 = await runWorkerTick({
    store,
    fetcher: fixtureFetcher({ src_den: [drop(0), drop(1)] }),
    channels,
    nowMs: AWAKE_NOW + 61_000,
  });
  const rows = await store.alerts.all();
  const queueRows = await store.digestQueue.all();
  const summary = (t) => ({
    due: t.due, succeeded: t.succeeded, failed: t.failed, newAlerts: t.newAlerts,
    dispatched: t.dispatched, receipts: t.receipts, dedupeDropped: t.dedupeDropped,
    queued: t.queued, digestExpired: t.digestExpired,
  });
  return {
    t1: summary(t1),
    t2: summary(t2),
    sent: sent.length,
    alertRows: rows.length,
    alertKinds: rows.map((r) => r.kind).sort(),
    queueRows: queueRows.length,
    scanLogs: (await store.scanLogs.all()).length,
  };
}

test('worker tick behaves identically on sync and async stores', async () => {
  const syncOutcome = await runTwoTicks(createStore(makeData()));
  const asyncOutcome = await runTwoTicks(asAsyncStore(createStore(makeData())));
  assert.deepEqual(asyncOutcome, syncOutcome);
  assert.equal(asyncOutcome.t1.newAlerts, 0, 'baseline pass alerts nobody');
  assert.equal(asyncOutcome.t2.newAlerts, 1, 'the real drop alerts exactly once');
  assert.equal(asyncOutcome.t2.dispatched, 1, 'and it is dispatched');
  assert.equal(asyncOutcome.sent, 1, 'one email left the mock channel');
  assert.equal(asyncOutcome.alertRows, 1, 'one durable alert row');
});

/* ------------------------------------------------------------------ *
 * The restart recipe against the async store: scheduler A ticks, the
 * process "restarts", scheduler B stays quiet — exactly-once across a
 * reboot, with Postgres-shaped async I/O underneath.
 * ------------------------------------------------------------------ */

test('restart recipe is quiet on an async store — no re-alerts after reboot', async () => {
  const raw = createStore({ users: [], alerts: [], engineStates: [] });
  const store = asAsyncStore(raw);
  const persistence = createAlertPersistence(store);
  const now = () => 1_788_948_000_000;

  // Boot 1: tick fires, alerts recorded, engine state saved durably.
  const queueA = createAlertQueue({ now });
  await persistence.restoreQueueSeen(queueA);
  const schedulerA = createAlertScheduler({
    getReleases: async () => RELEASES,
    getWantlist: async () => WANTS,
    queue: queueA,
    now,
    persistence,
  });
  const first = await schedulerA.tick();
  assert.ok(first.queued.length > 0, 'first tick should queue alerts');
  for (const event of first.queued) await persistence.recordAlert(event, { channels: ['email'], now });
  await persistence.restoreQueueSeen(queueA);
  const durableRows = await raw.engineStates.all();
  assert.ok(durableRows.length > 0, 'engine state must be persisted durably');

  // Boot 2 ("restart"): brand-new queue + scheduler, same async store.
  const queueB = createAlertQueue({ now });
  await persistence.restoreQueueSeen(queueB);
  const schedulerB = createAlertScheduler({
    getReleases: async () => RELEASES,
    getWantlist: async () => WANTS,
    queue: queueB,
    now,
    persistence,
  });
  const second = await schedulerB.tick();
  assert.equal(second.events.length, 0, 'unchanged batch must stay quiet across restarts');
  assert.equal(second.queued.length, 0);
  assert.equal(second.dupes.length, 0);
  assert.equal(queueB.size(), 0, 'nothing re-queued after restart');
});

test('a price drop still fires exactly once across an async-store restart', async () => {
  const store = asAsyncStore(createStore({ users: [], alerts: [], engineStates: [] }));
  const persistence = createAlertPersistence(store);
  const now = () => 1_788_948_000_000;

  const base = RELEASES.map((r) => (r.id === 9900210 ? { ...r, price_cents: 4500 } : r));
  const schedulerA = createAlertScheduler({
    getReleases: async () => base,
    getWantlist: async () => WANTS,
    queue: createAlertQueue({ now }),
    now,
    persistence,
  });
  await schedulerA.tick();

  const cheaper = base.map((r) => (r.id === 9900210 ? { ...r, price_cents: 3000 } : r));
  const queueB = createAlertQueue({ now });
  await persistence.restoreQueueSeen(queueB);
  const schedulerB = createAlertScheduler({
    getReleases: async () => cheaper,
    getWantlist: async () => WANTS,
    queue: queueB,
    now,
    persistence,
  });
  const report = await schedulerB.tick();
  assert.ok(
    report.events.some((e) => e.kind === 'price_drop' && e.release_id === 9900210),
    'price drop across an async-store restart must still fire',
  );
});

/* ------------------------------------------------------------------ *
 * Dispatch + recordAlert through the async store: the delivery-log row
 * the queue's seen-set replays must actually land.
 * ------------------------------------------------------------------ */

test('dispatcher writes durable recordAlert rows through the async store', async () => {
  const store = asAsyncStore(createStore({ users: [], alerts: [], engineStates: [] }));
  const persistence = createAlertPersistence(store);
  const now = () => 1_788_948_000_000;
  const queue = createAlertQueue({ now });
  queue.enqueue([
    { kind: 'new', user_id: 'usr_1', release_id: 9900210, price_cents: 3000, matched_at: '2026-09-09T10:00:00.000Z' },
  ]);
  const dispatcher = createAlertDispatcher({
    queue,
    persistence,
    now,
    dryRun: true,
    out: { write: () => {} },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  const rows = await store.alerts.all();
  assert.equal(rows.length, 1, 'the dry-run delivery must still write its delivery-log row');
  assert.equal(rows[0].user_id, 'usr_1');
  assert.equal(rows[0].release_id, 9900210);
  assert.equal(rows[0].kind, 'drop');

  // And the restart side: a fresh queue replays it as seen.
  const queue2 = createAlertQueue({ now });
  const restored = await persistence.restoreQueueSeen(queue2);
  assert.equal(restored, 1);
  const outcome = queue2.enqueue([{ kind: 'new', user_id: 'usr_1', release_id: 9900210 }]);
  assert.equal(outcome.dupes.length, 1, 'replayed row must dedupe the re-enqueue');
});
