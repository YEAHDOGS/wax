/**
 * Smoke/regression check for `packages/core/src/billing.js`.
 *
 * Run: `node --test packages/core/test-billing.mjs`
 * No dependencies beyond the Node standard library. It runs against a fresh
 * in-memory store seeded with one free, one trialed, and one subscribed user,
 * so it never touches the module store or the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS,
  SERIES_PRICE_CENTS,
  TRIAL_DAYS,
  activateSeries,
  checkoutSession,
  createStore,
  expireTrials,
  getCheckoutSession,
  startTrial,
} from './src/index.js';

const DAY = 24 * 60 * 60 * 1000;

function freshStore() {
  const store = createStore();
  store.users.insert({
    id: 'usr_free', email: 'free@example.com', handle: 'freebird',
    display_name: 'Free Bird', avatar_url: null,
    plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  });
  return store;
}

test('the money sentence holds: $10/mo series, 30-day trial', () => {
  assert.equal(SERIES_PRICE_CENTS, 1000);
  assert.equal(TRIAL_DAYS, 30);
  assert.equal(PLANS.series.priceCents, 1000);
  assert.equal(PLANS.series.interval, 'month');
  assert.equal(PLANS.free.priceCents, 0);
});

test('free -> trial stamps exactly 30 days out', () => {
  const store = freshStore();
  const freeToken = store.createSession('usr_free').token;
  const before = Date.now();
  const updated = startTrial(freeToken, { store });
  assert.equal(updated.plan, 'trial');
  const ends = Date.parse(updated.trial_ends_at);
  assert.ok(ends - before >= 30 * DAY - 60_000, 'trial ends ~30 days out');
  assert.ok(ends - before <= 30 * DAY + 60_000, 'trial does not overshoot');
});

test('a second trial is refused', () => {
  const store = freshStore();
  const token = store.createSession('usr_free').token;
  startTrial(token, { store });
  assert.throws(() => startTrial(token, { store }), (e) => e.code === 'trial_already_used');
});

test('expireTrials sweeps only past-due trials', () => {
  const store = freshStore();
  store.users.insert({
    id: 'usr_late', email: 'late@example.com', handle: 'late',
    display_name: 'Late', avatar_url: null,
    plan: 'trial', trial_ends_at: new Date(Date.now() - DAY).toISOString(),
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  });
  const swept = expireTrials({ store });
  assert.equal(swept, 1);
  assert.equal(store.users.find((u) => u.id === 'usr_late').plan, 'free');
  assert.equal(store.users.find((u) => u.id === 'usr_late').trial_ends_at, null);
  // A fresh trial must not be swept.
  const token = store.createSession('usr_free').token;
  startTrial(token, { store });
  assert.equal(expireTrials({ store }), 0);
});

test('test-mode checkout returns a stub shaped like a real session', () => {
  const store = freshStore();
  const token = store.createSession('usr_free').token;
  const session = checkoutSession(token, { store });
  assert.equal(session.mode, 'test');
  assert.equal(session.plan, 'series');
  assert.equal(session.amount_cents, 1000);
  assert.equal(session.currency, 'usd');
  assert.equal(session.user_id, 'usr_free');
  assert.ok(session.id.startsWith('testcs_'));
  assert.ok(session.url.includes(session.id));
  // The stub is retrievable by id, like a provider dashboard lookup.
  const lookedUp = getCheckoutSession(session.id);
  assert.equal(lookedUp.id, session.id);
});

test('live mode refuses loudly until a provider is wired', () => {
  const store = freshStore();
  const token = store.createSession('usr_free').token;
  assert.throws(
    () => checkoutSession(token, { mode: 'live', store }),
    (e) => e.code === 'billing_not_configured' && e.status === 501,
  );
});

test('checkout is refused for already-subscribed accounts', () => {
  const store = freshStore();
  const token = store.createSession('usr_kestrel').token; // seeded `series` user
  assert.throws(
    () => checkoutSession(token, { store }),
    (e) => e.code === 'already_subscribed',
  );
});

test('activateSeries moves trial -> series and records the provider id', () => {
  const store = freshStore();
  const token = store.createSession('usr_free').token;
  startTrial(token, { store });
  const updated = activateSeries(token, 'sub_test_123', { store });
  assert.equal(updated.plan, 'series');
  assert.equal(updated.external_subscription_id, 'sub_test_123');
  assert.equal(updated.trial_ends_at, null);
});

test('unknown or missing bearer is 401, not a crash', () => {
  const store = freshStore();
  assert.throws(() => startTrial('bogus', { store }), (e) => e.status === 401);
  assert.throws(() => checkoutSession(null, { store }), (e) => e.status === 401);
});
