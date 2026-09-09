/**
 * Regression checks for the alert-subscription rate-limit guards
 * (src/subscriptions.js): per-address subscribe throttling and per-token
 * confirm-attempt caps (ALERT-ENGINE-PLAN.md §3, the "per-address
 * subscribe throttle counters" checkbox).
 *
 * Run: `node --test packages/core/test-subscription-throttle.mjs`
 *
 * No dependencies beyond the Node standard library. Clock-injectable:
 * `subscribeAlertChannel` and `confirmAlertSubscription` take `now`, so
 * the sliding window is pinned without timers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  MAX_CONFIRM_ATTEMPTS_PER_WINDOW,
  MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW,
  SUBSCRIBE_WINDOW_MS,
  confirmAlertSubscription,
  createStore,
  subscribeAlertChannel,
} from './src/index.js';

function freshStore() {
  return createStore({ users: [], profiles: [], follows: [], artists: [], releases: [], tracks: [], watches: [], alerts: [], crateItems: [], wantlistItems: [], pricePoints: [], activity: [] });
}

const T0 = Date.parse('2026-09-09T12:00:00.000Z');

/** Each subscribe needs a distinct filter so the idempotency dedupe doesn't fold them together. */
function distinctSubscribe(i) {
  return {
    email: `buyer${i}@example.com`,
    channel: 'email',
    filter: { title_contains: `pressing-${i}` },
  };
}

test('subscribe: MAX new subscribes per window pass, the next is a 429', async () => {
  const store = freshStore();
  const address = 'fan@example.com';
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW; i += 1) {
    const res = await subscribeAlertChannel(
      { email: address, channel: 'email', filter: { title_contains: `pressing-${i}` } },
      { store, now: T0 + i * 1000 },
    );
    assert.equal(res.subscription.email, address);
  }
  await assert.rejects(
    subscribeAlertChannel(
      { email: address, channel: 'email', filter: { title_contains: 'one-too-many' } },
      { store, now: T0 + MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW * 1000 },
    ),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      return true;
    },
  );
  // A different address is untouched by the first one's budget.
  const other = await subscribeAlertChannel(
    { email: 'someoneelse@example.com', channel: 'email', filter: { title_contains: 'one-too-many' } },
    { store, now: T0 + MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW * 1000 },
  );
  assert.equal(other.subscription.state, 'pending');
});

test('subscribe: throttling is per channel+address, SMS has its own budget', async () => {
  const store = freshStore();
  const email = 'multi@example.com';
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW; i += 1) {
    await subscribeAlertChannel(
      { email, channel: 'email', filter: { title_contains: `e-${i}` } },
      { store, now: T0 + i * 1000 },
    );
  }
  await assert.rejects(
    subscribeAlertChannel({ email, channel: 'email', filter: { title_contains: 'e-late' } }, { store, now: T0 + 9000 }),
    (err) => err instanceof ApiError && err.status === 429,
  );
  const sms = await subscribeAlertChannel(
    { phone: '+13125550123', channel: 'sms', filter: { title_contains: 'e-late' } },
    { store, now: T0 + 9000 },
  );
  assert.equal(sms.subscription.state, 'pending');
});

test('subscribe: idempotent duplicates do not burn budget', async () => {
  const store = freshStore();
  const input = { email: 'repeat@example.com', channel: 'email', filter: { title_contains: 'same' } };
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW + 5; i += 1) {
    const res = await subscribeAlertChannel(input, { store, now: T0 + i * 1000 });
    assert.equal(res.subscription.duplicate, i > 0);
  }
  assert.equal(store.subscriptions.count(), 1);
  // And no attempt rows were recorded at all — duplicates never reach the guard.
  assert.equal(store.subscribeAttempts.count(), 1);
});

test('subscribe: the window slides — old attempts age out', async () => {
  const store = freshStore();
  const email = 'patient@example.com';
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW; i += 1) {
    await subscribeAlertChannel(
      { email, channel: 'email', filter: { title_contains: `p-${i}` } },
      { store, now: T0 + i * 1000 },
    );
  }
  // Just past the window, the oldest attempt has aged out: budget is back.
  const later = T0 + SUBSCRIBE_WINDOW_MS + 1000;
  const res = await subscribeAlertChannel(
    { email, channel: 'email', filter: { title_contains: 'p-return' } },
    { store, now: later },
  );
  assert.equal(res.subscription.state, 'pending');
});

test('confirm: unknown-token probes are capped per token, then 429', async () => {
  const store = freshStore();
  const token = 'nope-not-a-real-token';
  for (let i = 0; i < MAX_CONFIRM_ATTEMPTS_PER_WINDOW; i += 1) {
    await assert.rejects(
      async () => await confirmAlertSubscription(token, { store, now: T0 + i * 1000 }),
      (err) => err instanceof ApiError && err.status === 404 && err.code === 'bad_token',
    );
  }
  await assert.rejects(
    async () => await confirmAlertSubscription(token, { store, now: T0 + MAX_CONFIRM_ATTEMPTS_PER_WINDOW * 1000 }),
    (err) => err instanceof ApiError && err.status === 429 && err.code === 'rate_limited',
  );
  // A different token gets its own budget.
  await assert.rejects(
    async () => await confirmAlertSubscription('a-different-nope', { store, now: T0 + 60000 }),
    (err) => err instanceof ApiError && err.status === 404,
  );
});

test('confirm: valid confirms never count against anyone', async () => {
  const store = freshStore();
  const { confirm_token } = await subscribeAlertChannel(
    { email: 'real@example.com', channel: 'email' },
    { store, now: T0 },
  );
  // Confirm, then re-click the link many times (idempotent 200s) — none burn budget.
  for (let i = 0; i < MAX_CONFIRM_ATTEMPTS_PER_WINDOW + 5; i += 1) {
    const sub = await confirmAlertSubscription(confirm_token, { store, now: T0 + i * 1000 });
    assert.equal(sub.state, 'active');
  }
  // No confirm-attempt rows were recorded for the valid token.
  assert.equal(
    store.subscribeAttempts.filter((a) => a.kind === 'confirm').length,
    0,
  );
});

test('subscribe: 429 refuses without creating a subscription row', async () => {
  const store = freshStore();
  const email = 'capped@example.com';
  const before = store.subscriptions.count();
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW; i += 1) {
    await subscribeAlertChannel(
      { email, channel: 'email', filter: { title_contains: `c-${i}` } },
      { store, now: T0 + i * 1000 },
    );
  }
  await assert.rejects(
    subscribeAlertChannel({ email, channel: 'email', filter: { title_contains: 'c-refused' } }, { store, now: T0 + 9000 }),
    (err) => err instanceof ApiError && err.status === 429,
  );
  assert.equal(store.subscriptions.count(), before + MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW);
});

test('subscribe: email addresses are normalized before the throttle key (case/whitespace)', async () => {
  const store = freshStore();
  for (let i = 0; i < MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW; i += 1) {
    await subscribeAlertChannel(
      { email: '  MixedCase@Example.COM ', channel: 'email', filter: { title_contains: `m-${i}` } },
      { store, now: T0 + i * 1000 },
    );
  }
  // The same address in a different casing hits the same budget, not a fresh one.
  await assert.rejects(
    subscribeAlertChannel(
      { email: 'mixedcase@example.com', channel: 'email', filter: { title_contains: 'm-refused' } },
      { store, now: T0 + 9000 },
    ),
    (err) => err instanceof ApiError && err.status === 429,
  );
});
