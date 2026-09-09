/**
 * Smoke/regression check for `packages/core/src/digest.js` — the digest
 * queue, the "held for digest" half of alert delivery (ALERT-ENGINE-PLAN.md
 * §3, the rest of `notify.js`'s rate-limit contract).
 *
 * Run: `node --test packages/core/test-digest.mjs`
 * No dependencies beyond the Node standard library. These tests pin the
 * properties the digest queue exists for:
 *
 * 1. Only held-back deliveries get queued — alerts whose deliveries all
 *    left are never touched.
 * 2. Queueing is idempotent: the same pass queued twice queues once.
 * 3. Quiet hours gate the flush: nothing leaves while the user sleeps;
 *    the digest lands after the window ends.
 * 4. Verified email only; one digest per user per hour; stale rows expire.
 * 5. A failing channel keeps the queue — a dead channel loses nothing.
 *
 * If any of them fail, the notify gate's "folds into the next digest
 * instead of being dropped" promise is broken, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  queueHeldAlerts,
  flushDigestQueue,
  DIGEST_MIN_INTERVAL_MS,
  DIGEST_MAX_AGE_MS,
  DIGEST_MAX_ITEMS,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** 02:00 UTC — inside the 22:00–07:00 quiet window. */
const QUIET_NOW = Date.parse('2026-01-02T02:00:00Z');
/** 12:00 UTC — well outside the quiet window. */
const AWAKE_NOW = Date.parse('2026-01-02T12:00:00Z');

function user(overrides = {}) {
  return {
    id: 'usr_digest',
    email: 'digest@example.com',
    handle: 'digester',
    display_name: 'Digest User',
    avatar_url: null,
    plan: 'free',
    trial_ends_at: null,
    phone: null,
    phone_verified: false,
    email_verified: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * A persisted alert row as `dispatchScanAlerts` leaves it: one held
 * delivery (verdict refused) and one that went out.
 */
function heldAlert(overrides = {}) {
  return {
    id: 'alr_held1',
    user_id: 'usr_digest',
    kind: 'drop',
    artist_name: 'MF DOOM',
    title: 'Madvillainy Reissue',
    price_cents: 3499,
    listing_url: 'https://shop.example.com/madvillainy',
    source_label: 'example-shop',
    source_id: 'src_shop',
    dispatched_at: '2026-01-02T01:00:00Z',
    channels: ['email'],
    dispatches: [
      {
        ok: true,
        channel: 'email',
        via: 'log',
        messageId: 'm1',
        sentAt: '2026-01-02T01:00:00Z',
      },
      {
        skipped: true,
        channel: 'sms',
        reason: 'sms is a $10/mo series feature — queued for the email digest instead',
        sentAt: '2026-01-02T01:00:00Z',
      },
    ],
    ...overrides,
  };
}

/** A channel double that records what it was asked to send. */
function fakeChannel(overrides = {}) {
  const sent = [];
  return {
    sent,
    name: 'fake-email',
    kind: 'email',
    async send(envelope) {
      sent.push(envelope);
      return { ok: true, channel: envelope.channel, messageId: `fake_${sent.length}`, sentAt: new Date().toISOString() };
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * queueHeldAlerts
 * ------------------------------------------------------------------ */

test('queueHeldAlerts queues only alerts with held-back deliveries', () => {
  const store = createStore();
  store.users.insert(user());
  const green = { ...heldAlert({ id: 'alr_green' }), dispatches: [{ ok: true, channel: 'email', sentAt: '2026-01-02T01:00:00Z' }] };

  const { queued, skipped } = queueHeldAlerts({ store, alerts: [heldAlert(), green], nowMs: AWAKE_NOW });

  assert.equal(queued, 1);
  assert.equal(skipped, 1);
  const rows = store.digestQueue.all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alert_id, 'alr_held1');
  assert.equal(rows[0].artist_name, 'MF DOOM');
  assert.equal(rows[0].title, 'Madvillainy Reissue');
  assert.ok(rows[0].reason.includes('sms is a $10/mo series feature'));
});

test('queueHeldAlerts is idempotent — same pass queued twice queues once', () => {
  const store = createStore();
  store.users.insert(user());
  const alerts = [heldAlert()];

  assert.equal(queueHeldAlerts({ store, alerts, nowMs: AWAKE_NOW }).queued, 1);
  assert.equal(queueHeldAlerts({ store, alerts, nowMs: AWAKE_NOW }).queued, 0);
  assert.equal(store.digestQueue.count(), 1);
});

test('queueHeldAlerts ignores alerts with no dispatch receipts at all', () => {
  const store = createStore();
  store.users.insert(user());
  const { queued } = queueHeldAlerts({ store, alerts: [{ ...heldAlert({ id: 'alr_bare' }), dispatches: undefined }], nowMs: AWAKE_NOW });
  assert.equal(queued, 0);
  assert.equal(store.digestQueue.count(), 0);
});

/* ------------------------------------------------------------------ *
 * flushDigestQueue
 * ------------------------------------------------------------------ */

test('flushDigestQueue holds the digest during quiet hours', async () => {
  const store = createStore();
  store.users.insert(user());
  queueHeldAlerts({ store, alerts: [heldAlert()], nowMs: QUIET_NOW });
  const email = fakeChannel();

  const { users } = await flushDigestQueue({ store, channels: { email }, nowMs: QUIET_NOW });

  assert.equal(users.length, 1);
  assert.equal(users[0].sent, false);
  assert.ok(users[0].reason.includes('quiet hours'));
  assert.equal(email.sent.length, 0);
  assert.equal(store.digestQueue.count(), 1, 'queue survives the hold');
});

test('flushDigestQueue sends one digest email after quiet hours end', async () => {
  const store = createStore();
  store.users.insert(user());
  queueHeldAlerts({ store, alerts: [heldAlert(), heldAlert({ id: 'alr_held2', title: 'Vaudeville Villain' })], nowMs: QUIET_NOW });
  const email = fakeChannel();

  const { users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });

  assert.equal(users.length, 1);
  assert.equal(users[0].sent, true);
  assert.equal(users[0].items, 2);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].to, 'digest@example.com');
  assert.ok(email.sent[0].message.subject.includes('2 alerts'));
  assert.ok(email.sent[0].message.text.includes('MF DOOM'));
  assert.ok(email.sent[0].message.text.includes('Madvillainy Reissue'));
  assert.ok(email.sent[0].message.text.includes('Vaudeville Villain'));
  assert.equal(store.digestQueue.count(), 0, 'queue clears on success');
  const logs = store.scanLogs.filter((l) => l.outcome === 'digest');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].delivered, 2);
  assert.equal(logs[0].user_id, 'usr_digest');
});

test('flushDigestQueue refuses a second digest within the hour', async () => {
  const store = createStore();
  store.users.insert(user());
  const email = fakeChannel();

  queueHeldAlerts({ store, alerts: [heldAlert()], nowMs: AWAKE_NOW });
  const first = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });
  assert.equal(first.users[0].sent, true);

  queueHeldAlerts({ store, alerts: [heldAlert({ id: 'alr_held2' })], nowMs: AWAKE_NOW + 30 * 60 * 1000 });
  const second = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW + 30 * 60 * 1000 });
  assert.equal(second.users[0].sent, false);
  assert.ok(second.users[0].reason.includes('within the last hour'));
  assert.equal(email.sent.length, 1, 'only the first digest left');
});

test('flushDigestQueue holds the digest when the email is unverified', async () => {
  const store = createStore();
  store.users.insert(user({ email_verified: false }));
  queueHeldAlerts({ store, alerts: [heldAlert()], nowMs: AWAKE_NOW });
  const email = fakeChannel();

  const { users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });

  assert.equal(users[0].sent, false);
  assert.ok(users[0].reason.includes('not verified'));
  assert.equal(email.sent.length, 0);
  assert.equal(store.digestQueue.count(), 1);
});

test('flushDigestQueue expires rows older than a week', async () => {
  const store = createStore();
  store.users.insert(user());
  store.digestQueue.insert({
    id: 'dgq_old',
    user_id: 'usr_digest',
    alert_id: 'alr_old',
    kind: 'drop',
    artist_name: 'MF DOOM',
    title: 'Ancient Drop',
    price_cents: null,
    listing_url: null,
    source_label: null,
    reason: 'rate cap hit',
    queued_at: new Date(AWAKE_NOW - DIGEST_MAX_AGE_MS - 1000).toISOString(),
  });
  const email = fakeChannel();

  const { expired, users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });

  assert.equal(expired, 1);
  assert.equal(users.length, 0);
  assert.equal(email.sent.length, 0);
});

test('flushDigestQueue keeps the queue when the channel throws', async () => {
  const store = createStore();
  store.users.insert(user());
  queueHeldAlerts({ store, alerts: [heldAlert()], nowMs: AWAKE_NOW });
  const email = fakeChannel({
    async send() {
      throw new Error('provider down');
    },
  });

  const { users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });

  assert.equal(users[0].sent, false);
  assert.ok(users[0].reason.includes('provider down'));
  assert.equal(store.digestQueue.count(), 1, 'nothing is lost when the channel dies');
});

test('flushDigestQueue caps one digest at DIGEST_MAX_ITEMS, overflow stays queued', async () => {
  const store = createStore();
  store.users.insert(user());
  for (let i = 0; i < DIGEST_MAX_ITEMS + 3; i += 1) {
    queueHeldAlerts({ store, alerts: [heldAlert({ id: `alr_${i}`, title: `Drop ${i}` })], nowMs: AWAKE_NOW });
  }
  const email = fakeChannel();

  const { users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });

  assert.equal(users[0].sent, true);
  assert.equal(users[0].items, DIGEST_MAX_ITEMS);
  assert.equal(store.digestQueue.count(), 3);
});

test('flushDigestQueue is quiet when there is nothing queued', async () => {
  const store = createStore();
  store.users.insert(user());
  const email = fakeChannel();
  const { expired, users } = await flushDigestQueue({ store, channels: { email }, nowMs: AWAKE_NOW });
  assert.equal(expired, 0);
  assert.deepEqual(users, []);
  assert.equal(email.sent.length, 0);
});
