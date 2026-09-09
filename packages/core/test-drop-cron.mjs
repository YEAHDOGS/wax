/**
 * Regression check for `packages/core/src/drop-cron.js` — the
 * board-path cron hookup (ALERT-ENGINE-PLAN.md §3, "Alert delivery":
 * "wire the scheduler's cooldown map to the durable `alerts` rows at
 * boot ... and hang the per-minute cron's `runPass({ releases, rules,
 * dispatch })` off the board path so tracked-release drops flow
 * through the same dispatch receipts as the scan path").
 *
 * Run: `node --test packages/core/test-drop-cron.mjs`
 * Zero dependencies beyond the Node standard library. Pins the four
 * properties the board path exists for:
 *
 * 1. The board join works: store `releases` (artist_id) and `watches`
 *    (artist_id) are hydrated through the `artists` collection into the
 *    shapes the scheduler's `evaluateWatchRule` speaks, so a matching
 *    release + watch becomes a due alert — the scheduler can never
 *    disagree with the scan path about what a rule means.
 * 2. Delivered alerts land durably: `persistence.recordAlert` writes
 *    the `alerts` row on `{ ok: true }` receipts, and a fresh cron's
 *    `boot()` replays it into the cooldown map — a restart never
 *    re-alerts (exact recipe the plan prescribes).
 * 3. Refusals and throws leave no durable row and no cooldown mark —
 *    the next pass retries instead of going silent.
 * 4. Watches whose artist_id resolves to nothing are reported in
 *    `skipped`, never silently dropped; a cron with no dispatch
 *    boundary refuses loudly instead of pretending it sent.
 *
 * If any of them fail, the per-minute board tick is broken, and that
 * is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from './src/store.js';
import { createAlertPersistence } from './src/alert-persistence.js';
import { createTestDispatch } from './src/drop-scheduler.js';
import { createDropCron } from './src/drop-cron.js';

const now = () => Date.now();

/** A store seeded with ONLY one artist, one release, one watch that match. */
async function seedBoard() {
  const store = createStore({
    users: [],
    profiles: [],
    follows: [],
    artists: [],
    releases: [],
    tracks: [],
    watches: [],
    alerts: [],
    subscriptions: [],
    subscribeAttempts: [],
    engineStates: [],
  });
  const persistence = createAlertPersistence(store);
  await store.artists.insert({ id: 'art_doom', name: 'MF DOOM', aliases: ['Metal Fingers'] });
  await store.releases.insert({
    id: 'rel_mmfood',
    artist_id: 'art_doom',
    title: 'MM..FOOD — 20th Anniversary Repress',
    label: 'Rhymesayers',
    price_cents: 4200,
    listing_url: 'https://shop.example/mmfood',
  });
  await store.watches.insert({
    id: 'wch_doom',
    user_id: 'usr_doom',
    artist_id: 'art_doom',
    title_contains: 'mm..food',
    target_price_cents: 5000,
    channels: ['email'],
  });
  return { store, persistence };
}

test('constructor guards: store and persistence are required', () => {
  assert.throws(() => createDropCron({ persistence: {} }), /store/);
  assert.throws(() => createDropCron({ store: createStore(), persistence: {} }), /recordAlert/);
});

test('loadBoard hydrates releases and rules through the artists join', async () => {
  const { store, persistence } = await seedBoard();
  await store.watches.insert({ id: 'wch_orphan', user_id: 'usr_x', artist_id: 'art_missing' });

  const cron = createDropCron({ store, persistence, now });
  const board = await cron.loadBoard();

  assert.equal(board.releases.length, 1);
  assert.equal(board.releases[0].artist_name, 'MF DOOM');

  const rule = board.rules.find((r) => r.id === 'wch_doom');
  assert.ok(rule, 'matching watch is hydrated into a rule');
  assert.deepEqual(rule.artist, { name: 'MF DOOM', aliases: ['Metal Fingers'] });

  assert.equal(board.skipped.length, 1, 'orphan watch is reported, not silently dropped');
  assert.match(board.skipped[0].reason, /art_missing/);
  assert.ok(!board.rules.some((r) => r.id === 'wch_orphan'), 'orphan watch never becomes a rule');
});

test('runDropPass delivers matching pair and records it durably', async () => {
  const { store, persistence } = await seedBoard();
  const stub = createTestDispatch();
  const cron = createDropCron({ store, persistence, dispatch: stub.dispatch, now });

  const report = await cron.runDropPass();

  assert.equal(report.restored, 0, 'first boot restores nothing');
  assert.equal(report.due.length, 1, 'the matching release+watch is due');
  assert.equal(report.due[0].user_id, 'usr_doom');
  assert.equal(report.due[0].release_id, 'rel_mmfood');
  assert.equal(report.delivered.length, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(report.recorded.length, 1, 'delivered alert lands as a durable alerts row');

  const row = report.recorded[0];
  assert.equal(row.user_id, 'usr_doom');
  assert.equal(row.release_id, 'rel_mmfood');
  assert.equal(row.kind, 'drop');
  assert.deepEqual(row.channels, ['email'], 'channels come from the watch rule');
  assert.ok(row.dispatched_at, 'row carries dispatched_at');

  assert.equal(stub.sent().length, 1, 'exactly one envelope was handed to the dispatch boundary');
});

test('boot() replays durable alerts rows — a restart never re-alerts', async () => {
  const { store, persistence } = await seedBoard();
  const stub = createTestDispatch();
  const first = createDropCron({ store, persistence, dispatch: stub.dispatch, now });
  const firstPass = await first.runDropPass();
  assert.equal(firstPass.delivered.length, 1, 'first pass delivers');

  // New process, same store: the restart recipe.
  const second = createDropCron({ store, persistence, dispatch: stub.dispatch, now });
  const restored = await second.boot();
  assert.equal(restored, 1, 'the durable row replays into the cooldown map');

  const report = await second.runDropPass();
  assert.equal(report.due.length, 0, 'nothing is due — the pair is in cooldown');
  assert.equal(report.suppressed.length, 1);
  assert.match(report.suppressed[0].reason, /cooldown/);
  assert.equal(report.recorded.length, 0, 'no second durable row');
  assert.equal(stub.sent().length, 1, 'no second envelope was dispatched');
});

test('rows without dispatched_at are not cooldown markers — failed sends retry', async () => {
  const { store, persistence } = await seedBoard();
  const failing = createTestDispatch({ failOn: () => true });
  const cron = createDropCron({ store, persistence, dispatch: failing.dispatch, now });

  const report = await cron.runDropPass();
  assert.equal(report.delivered.length, 0, 'nothing delivered');
  assert.equal(report.failed.length, 1, 'the refusal is reported, not swallowed');
  assert.equal(report.recorded.length, 0, 'no durable row for a failed send');
  assert.equal((await store.alerts.all()).length, 0);

  // Next pass retries: the pair was never marked sent.
  const stub = createTestDispatch();
  const retry = await cron.runDropPass({ dispatch: stub.dispatch });
  assert.equal(retry.delivered.length, 1, 'the pair retries on the next pass');
  assert.equal(retry.recorded.length, 1);
});

test('no dispatch boundary configured: loud refusal, never a silent drop', async () => {
  const { store, persistence } = await seedBoard();
  const cron = createDropCron({ store, persistence, now });

  const report = await cron.runDropPass();
  assert.equal(report.due.length, 1, 'the alert is still decided due');
  assert.equal(report.failed.length, 1, 'the missing boundary refuses');
  assert.match(report.failed[0].reason, /no dispatch boundary/);
  assert.equal(report.recorded.length, 0, 'nothing recorded for a refused alert');
});

test('non-matching release stays quiet; price above target does not fire', async () => {
  const { store, persistence } = await seedBoard();
  await store.releases.insert({
    id: 'rel_pricey',
    artist_id: 'art_doom',
    title: 'MM..FOOD test pressing',
    price_cents: 99900, // above the watch's 5000c target
  });
  const stub = createTestDispatch();
  const cron = createDropCron({ store, persistence, dispatch: stub.dispatch, now });

  const report = await cron.runDropPass();
  assert.equal(report.due.length, 1, 'only the in-target release is due');
  assert.equal(report.due[0].release_id, 'rel_mmfood');
});
