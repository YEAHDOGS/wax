/**
 * Smoke/regression check for `packages/core/src/alert-queue.js` — the
 * ordered, deduped, per-user-capped staging layer between the matching
 * engine and dispatch (ALERT-ENGINE-PLAN.md §3, the rate-limit rule).
 *
 * Run: `node --test packages/core/test-alert-queue.mjs`
 * Zero dependencies beyond the Node standard library. Pins the three
 * properties the queue exists for:
 *
 * 1. Dedupe: the same user+release never enqueues twice — not in one
 *    batch, not across batches, not after a drain.
 * 2. Rate cap: enqueueing past the per-user hourly cap refuses the excess
 *    and reports it (capped, never silently dropped).
 * 3. Priority ordering: `drain` yields price_drop → restock → new, with
 *    oldest-first inside a priority; `drain(limit)` takes the head only.
 *
 * If any of them fail, the engine-to-dispatch contract changed, and that
 * is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  queueDedupeKey,
  createAlertQueue,
  EVENT_PRIORITY,
  QUEUE_DEFAULT_MAX_PER_USER_PER_HOUR,
} from './src/alert-queue.js';

function event(overrides = {}) {
  return {
    kind: 'new',
    user_id: 'u_brando',
    want_id: 'want_1',
    release_id: 15236781,
    artist_name: 'MF DOOM',
    title: 'Operation: Doomsday',
    price_cents: 3499,
    prev_price_cents: null,
    currency: 'USD',
    in_stock: true,
    listing_url: 'https://www.discogs.com/release/15236781',
    matched_at: '2026-09-09T09:00:00.000Z',
    ...overrides,
  };
}

test('queueDedupeKey is stable and user-scoped', () => {
  const a = queueDedupeKey(event());
  const b = queueDedupeKey(event({ price_cents: 2999 })); // price change ≠ new alert
  assert.equal(a, b);
  assert.notEqual(a, queueDedupeKey(event({ user_id: 'u_other' })));
  assert.notEqual(a, queueDedupeKey(event({ release_id: 9900210 })));
});

test('dedupe: same user+release never enqueues twice', () => {
  const q = createAlertQueue();
  const first = q.enqueue([event()]);
  assert.equal(first.queued.length, 1);
  assert.equal(first.dupes.length, 0);

  const again = q.enqueue([event(), event({ release_id: 9900210 })]);
  assert.equal(again.queued.length, 1); // only the new release
  assert.equal(again.dupes.length, 1); // the repeat is reported, not queued
  assert.equal(q.size(), 2);
});

test('dedupe holds across drain: already-sent releases never re-enter', () => {
  const q = createAlertQueue();
  q.enqueue([event()]);
  q.drain();
  const again = q.enqueue([event()]);
  assert.equal(again.queued.length, 0);
  assert.equal(again.dupes.length, 1);
  assert.equal(q.size(), 0);
});

test('rate cap: excess events are refused and reported, never dropped silently', () => {
  let t = 1786275600000;
  const q = createAlertQueue({ maxPerUserPerHour: 2, now: () => t });
  const batch = [event({ release_id: 1 }), event({ release_id: 2 }), event({ release_id: 3 })];
  const result = q.enqueue(batch);
  assert.equal(result.queued.length, 2);
  assert.equal(result.capped.length, 1);
  assert.equal(result.capped[0].release_id, 3);
  assert.equal(q.size(), 2);
  // a different user has their own cap
  const other = q.enqueue([event({ user_id: 'u_other', release_id: 9 })]);
  assert.equal(other.queued.length, 1);
});

test('rate cap resets as the window slides', () => {
  let t = 1786275600000;
  const q = createAlertQueue({ maxPerUserPerHour: 1, now: () => t });
  q.enqueue([event({ release_id: 1 })]);
  assert.equal(q.enqueue([event({ release_id: 2 })]).capped.length, 1);
  t += 3600_000 + 1; // an hour passes
  const after = q.enqueue([event({ release_id: 2 })]);
  assert.equal(after.capped.length, 0);
  assert.equal(after.queued.length, 1);
});

test('priority ordering: price_drop → restock → new, oldest-first within a kind', () => {
  const q = createAlertQueue();
  q.enqueue([
    event({ release_id: 1, kind: 'new', matched_at: '2026-09-09T09:00:01.000Z' }),
    event({ release_id: 2, kind: 'price_drop', matched_at: '2026-09-09T09:00:05.000Z' }),
    event({ release_id: 3, kind: 'restock', matched_at: '2026-09-09T09:00:03.000Z' }),
    event({ release_id: 4, kind: 'new', matched_at: '2026-09-09T09:00:00.000Z' }),
  ]);
  const drained = q.drain().map((e) => e.release_id);
  assert.deepEqual(drained, [2, 3, 4, 1]);
  assert.equal(q.size(), 0);
});

test('drain(limit) takes the priority head only', () => {
  const q = createAlertQueue();
  q.enqueue([
    event({ release_id: 1, kind: 'new' }),
    event({ release_id: 2, kind: 'price_drop' }),
    event({ release_id: 3, kind: 'restock' }),
  ]);
  const head = q.drain(2).map((e) => e.release_id);
  assert.deepEqual(head, [2, 3]);
  assert.equal(q.size(), 1);
});

test('peek does not consume; stats exposes the ledger', () => {
  const q = createAlertQueue();
  q.enqueue([event({ release_id: 1 }), event({ release_id: 2 })]);
  assert.equal(q.peek().length, 2);
  assert.equal(q.size(), 2);
  assert.equal(q.queuedForUser('u_brando'), 2);
  assert.equal(q.queuedForUser('u_other'), 0);
  const s = q.stats();
  assert.equal(s.pending, 2);
  assert.equal(s.seen, 2);
  assert.equal(s.perUser[0].enqueuedThisHour, 2);
});

test('constructor rejects a non-positive cap', () => {
  assert.throws(() => createAlertQueue({ maxPerUserPerHour: 0 }), TypeError);
  assert.throws(() => createAlertQueue({ maxPerUserPerHour: -5 }), TypeError);
});

test('defaults are sane and documented', () => {
  assert.equal(QUEUE_DEFAULT_MAX_PER_USER_PER_HOUR, 10);
  assert.deepEqual(EVENT_PRIORITY, { price_drop: 3, restock: 2, new: 1 });
});
