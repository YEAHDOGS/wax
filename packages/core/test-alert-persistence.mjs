/**
 * Smoke/regression check for `packages/core/src/alert-persistence.js` —
 * the durable memory behind the tick loop (ALERT-ENGINE-PLAN.md §4, the
 * "persist prevStates + the queue's seen-set in Postgres with the `alerts`
 * table" step).
 *
 * Run: `node --test packages/core/test-alert-persistence.mjs`
 * Zero dependencies beyond the Node standard library. Pins the four
 * properties the module exists for:
 *
 * 1. `savePrevStates`/`loadPrevStates` round-trip engine state through the
 *    store, keyed exactly like `prevStateKey` — including the no-id
 *    artist::title fallback form.
 * 2. Malformed state keys are never persisted — a garbage key in must not
 *    become a corrupt row out.
 * 3. `restoreQueueSeen` replays `alerts` rows into the queue so an
 *    already-alerted user+release is never queued again (the restart
 *    contract); rows without a release are skipped, not keyed as garbage.
 * 4. `recordAlert` writes durable `alerts` rows with the engine→board kind
 *    mapping (new→drop, price_drop→price, restock→restock), and an
 *    end-to-end restart — scheduler A ticks, scheduler B resumes from the
 *    same store — stays quiet on an unchanged batch.
 *
 * If any of them fail, the restart contract is broken and a deploy restart
 * would re-alert every user.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './src/store.js';
import { createAlertQueue } from './src/alert-queue.js';
import { createAlertScheduler } from './src/alert-scheduler.js';
import {
  ENGINE_STATE_KEY_SEP,
  splitEngineKey,
  ENGINE_TO_ALERT_KIND,
  createAlertPersistence,
} from './src/alert-persistence.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const WANTS = load('wantlist.json').wants;
const RELEASES = load('discogs-releases.json').releases;

function makePersistence() {
  const store = createStore({ users: [], alerts: [], engineStates: [] });
  return { store, persistence: createAlertPersistence(store) };
}

test('save/load round-trips engine state through the store', async () => {
  const { persistence } = makePersistence();
  const states = {
    [`usr_1${ENGINE_STATE_KEY_SEP}9900210`]: {
      price_cents: 4500,
      in_stock: true,
      seen_at: '2026-09-09T10:00:00.000Z',
    },
    // no-id fallback key form: artist::title as the state_key
    [`usr_1${ENGINE_STATE_KEY_SEP}benji::madvillainy`]: {
      price_cents: null,
      in_stock: false,
      seen_at: '2026-09-09T10:00:00.000Z',
    },
  };
  const upserted = await persistence.savePrevStates(states);
  assert.equal(upserted, 2);
  const loaded = await persistence.loadPrevStates();
  assert.deepEqual(loaded, states);
});

test('save is an upsert: second save updates rows, does not duplicate', async () => {
  const { store, persistence } = makePersistence();
  const key = `usr_1${ENGINE_STATE_KEY_SEP}9900210`;
  await persistence.savePrevStates({ [key]: { price_cents: 4500, in_stock: true, seen_at: 'x' } });
  await persistence.savePrevStates({ [key]: { price_cents: 3000, in_stock: true, seen_at: 'y' } });
  assert.equal(store.engineStates.count(), 1);
  assert.equal((await persistence.loadPrevStates())[key].price_cents, 3000);
});

test('malformed keys are skipped, never persisted', async () => {
  const { store, persistence } = makePersistence();
  const upserted = await persistence.savePrevStates({
    'no-separator-here': { price_cents: 1, in_stock: true, seen_at: 'x' },
    [`${ENGINE_STATE_KEY_SEP}`]: { price_cents: 1, in_stock: true, seen_at: 'x' },
    [`usr_1${ENGINE_STATE_KEY_SEP}ok`]: { price_cents: 1, in_stock: true, seen_at: 'x' },
    [`usr_1${ENGINE_STATE_KEY_SEP}bad-state`]: null,
  });
  assert.equal(upserted, 1);
  assert.equal(store.engineStates.count(), 1);
  assert.deepEqual(splitEngineKey('no-separator-here'), { user_id: 'no-separator-here', state_key: '' });
});

test('restoreQueueSeen replays alerts rows so re-enqueue reports dupes', async () => {
  const { store, persistence } = makePersistence();
  store.alerts.insert({ user_id: 'usr_1', release_id: 9900210 });
  store.alerts.insert({ user_id: 'usr_1', release_id: 15236781 });
  store.alerts.insert({ user_id: 'usr_2', release_id: null }); // skipped, not garbage-keyed
  const queue = createAlertQueue();
  const restored = await persistence.restoreQueueSeen(queue);
  assert.equal(restored, 2);
  const { queued, dupes } = queue.enqueue([
    { kind: 'new', user_id: 'usr_1', release_id: 9900210 },
    { kind: 'new', user_id: 'usr_1', release_id: 99999999 },
  ]);
  assert.equal(queued.length, 1, 'only the never-alerted release should queue');
  assert.equal(dupes.length, 1, 'the replayed alert must come back as a dupe');
});

test('restoreQueueSeen requires a real queue', async () => {
  const { persistence } = makePersistence();
  await assert.rejects(() => persistence.restoreQueueSeen(null), TypeError);
  await assert.rejects(() => persistence.restoreQueueSeen({}), TypeError);
});

test('recordAlert maps engine kinds to board kinds and writes durable rows', async () => {
  const { store, persistence } = makePersistence();
  assert.deepEqual(ENGINE_TO_ALERT_KIND, { new: 'drop', price_drop: 'price', restock: 'restock' });
  const row = await persistence.recordAlert(
    {
      kind: 'price_drop',
      user_id: 'usr_1',
      want_id: 'w_1',
      release_id: 9900210,
      price_cents: 3000,
      matched_at: '2026-09-09T10:00:00.000Z',
      listing_url: 'https://discogs.com/release/9900210',
    },
    { channels: ['email'], now: () => 1_788_948_000_000 },
  );
  assert.ok(row.id.startsWith('alr_'), 'alert ids carry the alr_ prefix');
  assert.equal(row.kind, 'price');
  assert.equal(row.state, 'live');
  assert.equal(row.user_id, 'usr_1');
  assert.equal(row.watch_id, 'w_1');
  assert.equal(row.dispatched_at, '2026-09-09T10:00:00.000Z');
  assert.deepEqual(row.channels, ['email']);
  assert.equal(store.alerts.count(), 1);
  // unknown engine kind falls back to 'drop', never throws
  const fallback = await persistence.recordAlert({ kind: 'weird', user_id: 'u', release_id: 'r' });
  assert.equal(fallback.kind, 'drop');
});

test('restart contract: scheduler B resumes from scheduler A without re-alerting', async () => {
  const store = createStore({ users: [], alerts: [], engineStates: [] });
  const persistence = createAlertPersistence(store);
  const now = () => 1_788_948_000_000;

  // Instance A: first tick fires, queue dedupes, alerts recorded, states saved.
  const queueA = createAlertQueue({ now });
  const schedulerA = createAlertScheduler({
    getReleases: () => RELEASES,
    getWantlist: () => WANTS,
    queue: queueA,
    now,
    persistence,
  });
  const first = await schedulerA.tick();
  assert.ok(first.queued.length > 0, 'first tick should queue alerts');
  for (const event of first.queued) await persistence.recordAlert(event, { channels: ['email'], now });
  await persistence.restoreQueueSeen(queueA);

  // Instance B (a "restart"): fresh queue + scheduler, same store.
  const queueB = createAlertQueue({ now });
  await persistence.restoreQueueSeen(queueB);
  const schedulerB = createAlertScheduler({
    getReleases: () => RELEASES,
    getWantlist: () => WANTS,
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

test('restart contract holds for price-drop transitions too', async () => {
  const store = createStore({ users: [], alerts: [], engineStates: [] });
  const persistence = createAlertPersistence(store);
  const now = () => 1_788_948_000_000;

  const base = RELEASES.map((r) => (r.id === 9900210 ? { ...r, price_cents: 4500 } : r));
  const schedulerA = createAlertScheduler({
    getReleases: () => base,
    getWantlist: () => WANTS,
    queue: createAlertQueue({ now }),
    now,
    persistence,
  });
  await schedulerA.tick();

  // Restart, then the batch changes: the price drop must still fire exactly once.
  const cheaper = base.map((r) => (r.id === 9900210 ? { ...r, price_cents: 3000 } : r));
  const queueB = createAlertQueue({ now });
  await persistence.restoreQueueSeen(queueB);
  const schedulerB = createAlertScheduler({
    getReleases: () => cheaper,
    getWantlist: () => WANTS,
    queue: queueB,
    now,
    persistence,
  });
  const report = await schedulerB.tick();
  assert.ok(
    report.events.some((e) => e.kind === 'price_drop' && e.release_id === 9900210),
    'price drop across a restart must still fire',
  );
});

test('constructor guards: persistence needs a real store', () => {
  assert.throws(() => createAlertPersistence(null), TypeError);
  assert.throws(() => createAlertPersistence({}), TypeError);
  assert.throws(() => createAlertPersistence({ engineStates: { all: () => [] } }), TypeError);
});

test('scheduler rejects a persistence object missing load/save', () => {
  const queue = createAlertQueue();
  const base = {
    getReleases: () => [],
    getWantlist: () => [],
    queue,
  };
  assert.throws(() => createAlertScheduler({ ...base, persistence: {} }), TypeError);
  assert.throws(
    () => createAlertScheduler({ ...base, persistence: { loadPrevStates: () => ({}) } }),
    TypeError,
  );
});

test('scheduler without persistence ignores nothing: prevStates seed still works', async () => {
  // Regression pin: adding the option must not change the no-persistence path.
  const { persistence } = makePersistence();
  const seeded = { 'usr_x\x1f1': { price_cents: 100, in_stock: true, seen_at: 'x' } };
  const queue = createAlertQueue();
  const scheduler = createAlertScheduler({
    getReleases: () => [],
    getWantlist: () => [],
    queue,
    prevStates: seeded,
    persistence: null,
  });
  await scheduler.tick();
  assert.deepEqual(scheduler.prevStates(), seeded);
  void persistence;
});

test('a failed state save throws out of tick — loud, never swallowed', async () => {
  const store = createStore({ users: [], alerts: [], engineStates: [] });
  const persistence = createAlertPersistence(store);
  const broken = {
    ...persistence,
    savePrevStates: () => {
      throw new Error('disk is on fire');
    },
  };
  const scheduler = createAlertScheduler({
    getReleases: () => RELEASES,
    getWantlist: () => WANTS,
    queue: createAlertQueue(),
    persistence: broken,
  });
  await assert.rejects(() => scheduler.tick(), /disk is on fire/);
});
