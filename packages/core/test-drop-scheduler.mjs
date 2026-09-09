/**
 * Regression check for `packages/core/src/drop-scheduler.js` — the
 * drop-alert scheduler between tracked releases and the DISPATCH
 * boundary (ALERT-ENGINE-PLAN.md §3, "Alert delivery").
 *
 * Run: `node --test packages/core/test-drop-scheduler.mjs`
 * Zero dependencies beyond the Node standard library. Pins the five
 * properties the scheduler exists for:
 *
 * 1. `schedule` matches releases against user alert rules with the same
 *    rule engine the scan path uses (`evaluateWatchRule`): a matching
 *    release is due, a non-matching one is not.
 * 2. In-batch dedupe: two rules from the same user matching the same
 *    release in one pass produce ONE due alert; the loser is a
 *    suppressed duplicate — the user is never double-told.
 * 3. Cooldown: after a successful dispatch marks a (user, release) pair
 *    sent, the same pass suppresses it (`cooldown`); after the window
 *    expires the pair becomes due again (a genuine restock re-alerts).
 *    `restoreSent` replays durable `alerts` rows so a restart keeps the
 *    cooldown memory.
 * 4. Dispatch failures never lose alerts: an `{ ok: false }` receipt or
 *    a throw leaves the pair unmarked, so the next pass retries.
 * 5. The TEST-MODE stub (`createTestDispatch`) records exactly what it
 *    would have sent and returns test-mode receipts — no socket is
 *    ever opened, so network sends are structurally impossible.
 *
 * If any of them fail, the decide-which-alerts-are-due contract the
 * drop path sits on changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DROP_DEFAULT_COOLDOWN_MS,
  dropDedupeKey,
  dropReleaseProduct,
  createTestDispatch,
  createDropScheduler,
} from './src/drop-scheduler.js';

const NOW = 1_000_000_000_000;

function rule(over = {}) {
  return {
    id: 'w_1',
    user_id: 'u_1',
    artist_id: 'a_1',
    artist: { name: 'MF DOOM', aliases: ['Doom'] },
    title_contains: null,
    label_contains: null,
    target_price_cents: null,
    channels: ['email'],
    ...over,
  };
}

function release(over = {}) {
  return {
    id: 'r_1',
    artist_name: 'MF DOOM',
    title: 'Mm..Food repress',
    label: 'Rhymesayers',
    price_cents: 2999,
    listing_url: 'https://shop.example/mm-food',
    ...over,
  };
}

test('matching release is due; non-matching release is not', () => {
  const sched = createDropScheduler({ now: () => NOW });
  const { due, suppressed } = sched.schedule({
    releases: [release(), release({ id: 'r_2', artist_name: 'Chappell Roan', title: 'The Rise and Fall LP' })],
    rules: [rule()],
    nowMs: NOW,
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].release_id, 'r_1');
  assert.equal(due[0].user_id, 'u_1');
  assert.equal(due[0].rule_id, 'w_1');
  assert.equal(due[0].artist_name, 'MF DOOM');
  assert.equal(due[0].title, 'Mm..Food repress');
  assert.equal(due[0].price_cents, 2999);
  assert.equal(due[0].listing_url, 'https://shop.example/mm-food');
  assert.deepEqual(suppressed, []);
});

test('price target gates the alert', () => {
  const sched = createDropScheduler({ now: () => NOW });
  const cheap = rule({ target_price_cents: 2000 });
  const { due } = sched.schedule({ releases: [release({ price_cents: 2999 })], rules: [cheap], nowMs: NOW });
  assert.equal(due.length, 0, 'price above target must not alert');
  const ok = rule({ target_price_cents: 5000 });
  const again = sched.schedule({ releases: [release({ price_cents: 2999 })], rules: [ok], nowMs: NOW });
  assert.equal(again.due.length, 1, 'price at/below target must alert');
});

test('two rules from the same user on the same release dedupe in-batch', () => {
  const sched = createDropScheduler({ now: () => NOW });
  const r1 = rule({ id: 'w_1', title_contains: 'food' });
  const r2 = rule({ id: 'w_2', title_contains: null });
  const { due, suppressed } = sched.schedule({
    releases: [release()],
    rules: [r1, r2],
    nowMs: NOW,
  });
  assert.equal(due.length, 1, 'one due alert, not two');
  assert.equal(suppressed.length, 1);
  assert.match(suppressed[0].reason, /duplicate in batch/);
  assert.equal(due[0].key, dropDedupeKey({ user_id: 'u_1', release_id: 'r_1' }));
});

test('two different users on the same release both alert', () => {
  const sched = createDropScheduler({ now: () => NOW });
  const { due } = sched.schedule({
    releases: [release()],
    rules: [rule({ id: 'w_1', user_id: 'u_1' }), rule({ id: 'w_2', user_id: 'u_2' })],
    nowMs: NOW,
  });
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((d) => d.user_id).sort(), ['u_1', 'u_2']);
});

test('cooldown suppresses a re-alert inside the window, allows it after', () => {
  const cooldownMs = 60_000;
  const sched = createDropScheduler({ cooldownMs, now: () => NOW });
  const input = { releases: [release()], rules: [rule()] };

  // First pass: due.
  const first = sched.schedule({ ...input, nowMs: NOW });
  assert.equal(first.due.length, 1);

  // Successful dispatch marks the pair sent.
  return sched
    .dispatchDue({ due: first.due, dispatch: createTestDispatch().dispatch, nowMs: NOW })
    .then(({ delivered, failed }) => {
      assert.equal(delivered.length, 1);
      assert.deepEqual(failed, []);
      assert.equal(sched.lastSentAt({ user_id: 'u_1', release_id: 'r_1' }), NOW);

      // Second pass inside the window: suppressed.
      const second = sched.schedule({ ...input, nowMs: NOW + 30_000 });
      assert.equal(second.due.length, 0);
      assert.equal(second.suppressed.length, 1);
      assert.match(second.suppressed[0].reason, /cooldown/);

      // After the window: due again (a restock re-alerts).
      const third = sched.schedule({ ...input, nowMs: NOW + cooldownMs });
      assert.equal(third.due.length, 1, 'window expiry boundary is inclusive');
    });
});

test('failed dispatches are not marked sent and retry on the next pass', async () => {
  const sched = createDropScheduler({ cooldownMs: 60_000, now: () => NOW });
  const input = { releases: [release()], rules: [rule()] };
  const { due } = sched.schedule({ ...input, nowMs: NOW });

  const failing = createTestDispatch({ failOn: () => true });
  const bad = await sched.dispatchDue({ due, dispatch: failing.dispatch, nowMs: NOW });
  assert.equal(bad.delivered.length, 0);
  assert.equal(bad.failed.length, 1);
  assert.match(bad.failed[0].reason, /refused/);
  assert.equal(sched.lastSentAt({ user_id: 'u_1', release_id: 'r_1' }), undefined);

  // A throwing dispatch is a failure too, not a crash of the scheduler.
  const throwing = await sched.dispatchDue({ due, dispatch: async () => { throw new Error('boom'); }, nowMs: NOW });
  assert.equal(throwing.failed.length, 1);
  assert.match(throwing.failed[0].reason, /threw/);

  // Next pass: still due — the alert was never lost.
  const retry = sched.schedule({ ...input, nowMs: NOW + 10_000 });
  assert.equal(retry.due.length, 1);
});

test('runPass runs schedule + dispatch in one call', async () => {
  const stub = createTestDispatch();
  const sched = createDropScheduler({ now: () => NOW });
  const report = await sched.runPass({
    releases: [release()],
    rules: [rule()],
    dispatch: stub.dispatch,
    nowMs: NOW,
  });
  assert.equal(report.due.length, 1);
  assert.equal(report.delivered.length, 1);
  assert.deepEqual(report.failed, []);
  assert.equal(report.receipts.length, 1);
  assert.equal(stub.sent().length, 1);
});

test('restoreSent replays durable rows so a restart keeps cooldown memory', () => {
  const sched = createDropScheduler({ cooldownMs: 60_000, now: () => NOW });
  const restored = sched.restoreSent([
    { user_id: 'u_1', release_id: 'r_1', dispatched_at: new Date(NOW - 10_000).toISOString() },
    { user_id: 'u_1', release_id: 'r_9', dispatched_at: null }, // failed row: not a marker
    { user_id: 'u_1', release_id: 'r_bad', dispatched_at: 'not-a-date' }, // garbage: skipped
  ]);
  assert.equal(restored, 1);

  const { due, suppressed } = sched.schedule({
    releases: [release()],
    rules: [rule()],
    nowMs: NOW,
  });
  assert.equal(due.length, 0, 'restart must not re-alert a sent pair inside the window');
  assert.match(suppressed[0].reason, /cooldown/);
});

test('test-mode stub records what it would have sent, opens no socket', async () => {
  const stub = createTestDispatch();
  const alert = { key: 'k', user_id: 'u_1', release_id: 'r_1', artist_name: 'MF DOOM', title: 'T' };
  const receipt = await stub.dispatch(alert);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.testMode, true);

  const sent = stub.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].alert.release_id, 'r_1');
  assert.ok(sent[0].at, 'record carries an ISO timestamp');

  // The stub is pure in-memory: the envelope it recorded is not the
  // caller's mutable object, and reset() clears the log.
  alert.title = 'MUTATED';
  assert.equal(stub.sent()[0].alert.title, 'T', 'recorded envelope must not alias caller state');
  stub.reset();
  assert.deepEqual(stub.sent(), []);
});

test('constructor guards: positive cooldown, dispatch function required', async () => {
  assert.throws(() => createDropScheduler({ cooldownMs: 0 }), TypeError);
  assert.throws(() => createDropScheduler({ cooldownMs: -5 }), TypeError);
  const sched = createDropScheduler({ now: () => NOW });
  await assert.rejects(
    () => sched.dispatchDue({ due: [], dispatch: 'not-a-function' }),
    TypeError,
  );
});

test('dropReleaseProduct speaks both release shapes', () => {
  const a = dropReleaseProduct({ artist_name: 'MF DOOM', title: 'T', price: 1234 });
  assert.equal(a.artist, 'MF DOOM');
  assert.equal(a.price_cents, 1234);
  const b = dropReleaseProduct({ artist: 'Doom', title: 'T2', price_cents: 999 });
  assert.equal(b.artist, 'Doom');
  assert.equal(b.price_cents, 999);
  const c = dropReleaseProduct(null);
  assert.equal(c.artist, '');
});

test('default cooldown is one week', () => {
  assert.equal(DROP_DEFAULT_COOLDOWN_MS, 7 * 24 * 60 * 60 * 1000);
});
