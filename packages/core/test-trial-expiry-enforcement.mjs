/**
 * Regression check for trial-expiry enforcement on the dispatch read path.
 *
 * Run: `node --test packages/core/test-trial-expiry-enforcement.mjs`
 * No dependencies beyond the Node standard library. Everything runs against
 * a fresh in-memory store, so it never touches the module store or the
 * network.
 *
 * The contract (docs/ALERT-ENGINE-PLAN.md §5): the hourly `expireTrials`
 * sweep is the writer, but dispatch runs between sweeps. A trial that
 * ended at 2:00 while the sweep next runs at 3:00 must not keep series
 * features (SMS sends, unlimited watches/sources) for that gap. The read
 * path enforces via `effectivePlan` (src/plan.js), wired into:
 *
 * - `poller.js` `buildAlerts` — the `plan` handed to `shouldDispatch`
 * - `handlers.js` `addWatch` — the FREE_WATCH_LIMIT gate
 * - `tracking.js` `addSource` — the FREE_SOURCE_LIMIT gate
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSource,
  addWatch,
  createStore,
  effectivePlan,
  expireTrials,
  FREE_SOURCE_LIMIT,
  FREE_WATCH_LIMIT,
  shouldDispatch,
} from './src/index.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** A user row shaped the way the store hands them to dispatch. */
function userRow(plan, trial_ends_at) {
  return {
    id: 'usr_trial',
    email: 'trial@example.com',
    handle: 'trialpressing',
    display_name: 'Trial Pressing',
    avatar_url: null,
    plan,
    trial_ends_at,
    phone: '+13125550123',
    phone_verified: true,
    email_verified: true,
    created_at: new Date(now - 31 * DAY).toISOString(),
  };
}

function storeWithUser(plan, trial_ends_at) {
  const store = createStore();
  store.users.insert(userRow(plan, trial_ends_at));
  return store;
}

function addArtist(store, i) {
  return store.artists.insert({
    id: `art_exp_${i}`, name: `Artist ${i}`, discogs_artist_id: null,
    image_url: null, genres: [], created_at: new Date(now).toISOString(),
  });
}

test('effectivePlan: a trial past its expiry reads as free, even before the sweep', () => {
  const past = new Date(now - 60_000).toISOString();
  assert.equal(effectivePlan(userRow('trial', past), { now }), 'free');
});

test('effectivePlan: a live trial keeps its plan, and the sweep agrees', () => {
  const future = new Date(now + 60_000).toISOString();
  assert.equal(effectivePlan(userRow('trial', future), { now }), 'trial');
  const store = storeWithUser('trial', future);
  assert.equal(expireTrials({ store }), 0, 'live trial is not swept');
  assert.equal(store.users.find((u) => u.id === 'usr_trial').plan, 'trial');
});

test('effectivePlan: expired trial matches exactly what the sweep will write', () => {
  const past = new Date(now - 2 * DAY).toISOString();
  const readPath = effectivePlan(userRow('trial', past), { now });
  const store = storeWithUser('trial', past);
  assert.equal(expireTrials({ store }), 1, 'sweep downgrades the expired trial');
  const written = store.users.find((u) => u.id === 'usr_trial');
  assert.equal(written.plan, 'free');
  assert.equal(written.trial_ends_at, null);
  assert.equal(readPath, written.plan, 'read path and sweep agree');
});

test('effectivePlan: series, free, unknown, and missing rows behave', () => {
  assert.equal(effectivePlan(userRow('series', null), { now }), 'series');
  assert.equal(effectivePlan(userRow('free', null), { now }), 'free');
  assert.equal(effectivePlan({ id: 'x', plan: 'not-a-plan', trial_ends_at: null }, { now }), 'free');
  assert.equal(effectivePlan(null, { now }), 'free');
  assert.equal(effectivePlan(undefined, { now }), 'free');
});

test('effectivePlan: a trial with no expiry date is not second-guessed', () => {
  assert.equal(effectivePlan(userRow('trial', null), { now }), 'trial');
});

test('dispatch: an expired trial loses SMS — shouldDispatch refuses it like a free plan', () => {
  const past = new Date(now - 60_000).toISOString();
  const verdict = shouldDispatch({
    channel: 'sms',
    plan: effectivePlan(userRow('trial', past), { now }),
    sentThisWindow: [],
    now,
  });
  assert.equal(verdict.dispatch, false);
  assert.match(verdict.reason, /series feature/);
});

test('dispatch: the same expired trial still gets email alerts', () => {
  const past = new Date(now - 60_000).toISOString();
  const verdict = shouldDispatch({
    channel: 'email',
    plan: effectivePlan(userRow('trial', past), { now }),
    sentThisWindow: [],
    now,
  });
  assert.equal(verdict.dispatch, true);
});

test('watch gate: an expired-but-unswept trial hits the free watch limit', () => {
  const past = new Date(now - 60_000).toISOString();
  const store = storeWithUser('trial', past);
  const token = store.createSession('usr_trial').token;
  for (let i = 0; i < FREE_WATCH_LIMIT; i++) {
    addWatch(token, { artist_id: addArtist(store, i).id }, { store });
  }
  assert.throws(
    () => addWatch(token, { artist_id: addArtist(store, 99).id }, { store }),
    (err) => err.status === 402 && err.code === 'watch_limit',
    '4th watch on an expired trial is 402 watch_limit',
  );
});

test('source gate: an expired-but-unswept trial hits the free source limit', () => {
  const past = new Date(now - 60_000).toISOString();
  const store = storeWithUser('trial', past);
  const token = store.createSession('usr_trial').token;
  for (let i = 0; i < FREE_SOURCE_LIMIT; i++) {
    addSource(
      token,
      { url: `https://example-shop-${i}.com/`, accept_unscannable: true },
      { store },
    );
  }
  assert.throws(
    () => addSource(token, { url: 'https://one-more-shop.example.com/' }, { store }),
    (err) => err.status === 402 && err.code === 'source_limit',
    'extra source on an expired trial is 402 source_limit',
  );
});

test('watch gate: a live trial is NOT capped', () => {
  const future = new Date(now + DAY).toISOString();
  const store = storeWithUser('trial', future);
  const token = store.createSession('usr_trial').token;
  for (let i = 0; i < FREE_WATCH_LIMIT + 1; i++) {
    addWatch(token, { artist_id: addArtist(store, i).id }, { store });
  }
  const count = store.watches.filter((w) => w.user_id === 'usr_trial').length;
  assert.equal(count, FREE_WATCH_LIMIT + 1);
});
