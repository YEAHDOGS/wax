/**
 * Smoke/regression check for the dispatcher's channel fallback chains
 * (`fallbackChannels`, ALERT-ENGINE-PLAN.md §3 "Alert delivery" —
 * "fallback handling").
 *
 * Run: `node --test packages/core/test-dispatch-fallback.mjs`
 * Zero dependencies beyond the Node standard library. Pins the contract
 * the fallback feature exists for:
 *
 * 1. A failing primary channel falls through to its fallback — the alert
 *    still reaches the user (sms down → email delivers), attempted with
 *    the primary's full retry budget first.
 * 2. The delivery log records the channel that actually delivered, once.
 * 3. Total failure dead-letters with the full channel trail, event intact.
 * 4. Configuration mistakes are loud at construction: self-loops, cycles,
 *    non-string names, non-array fallback lists.
 * 5. An explicit `channel` override bypasses fallbacks (forced is forced),
 *    and dry-run mode never triggers the chain.
 *
 * If any of them fail, an outage on one provider either loses alerts or
 * double-delivers them — exactly the failure modes Brando flagged as his
 * #1 pain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from './src/store.js';
import { createAlertQueue } from './src/alert-queue.js';
import { createAlertPersistence } from './src/alert-persistence.js';
import { createAlertDispatcher } from './src/alert-dispatcher.js';
import { createConsoleAdapter } from './src/send-adapters.js';

const NOW_MS = 2_000_000;
const now = () => NOW_MS;
const iso = (ms = NOW_MS) => new Date(ms).toISOString();

function makeEvent(overrides = {}) {
  return {
    kind: 'new',
    user_id: 'u_1',
    want_id: 'want_1',
    release_id: 'rel_1',
    artist_name: 'MF DOOM',
    title: 'Madvillainy',
    price_cents: 3499,
    prev_price_cents: null,
    currency: 'USD',
    in_stock: true,
    listing_url: 'https://shop.example/madvillainy',
    matched_at: iso(),
    channel: 'sms',
    phone: '+15551234567',
    email: 'user@example.com',
    ...overrides,
  };
}

function makeQueueWith(events, queueOpts = {}) {
  const queue = createAlertQueue({ now, ...queueOpts });
  queue.enqueue(events);
  return queue;
}

function failingAdapter(name, { kind = 'email', calls = null } = {}) {
  return {
    name,
    kind,
    async send() {
      if (calls) calls.push(name);
      return { ok: false, channel: name, error: `${name} refused`, sentAt: iso() };
    },
  };
}

function throwingAdapter(name, { kind = 'email' } = {}) {
  return {
    name,
    kind,
    async send() {
      throw new Error(`${name} exploded`);
    },
  };
}

/** Fails `failuresLeft` times, then delivers — a provider that recovers. */
function flakyAdapter(name, failuresLeft, { kind = 'email', calls = null } = {}) {
  return {
    name,
    kind,
    async send(envelope) {
      if (calls) calls.push(name);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, channel: name, error: `${name} flaked`, sentAt: iso() };
      }
      return { ok: true, channel: name, messageId: `${name}_ok`, sentAt: iso() };
    },
  };
}

function recordingPersistence() {
  const rows = [];
  return {
    rows,
    async recordAlert(event, { channels }) {
      rows.push({ user_id: event.user_id, release_id: event.release_id, channels });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Constructor guards — bad fallback maps fail loudly, never silently.
 * ------------------------------------------------------------------ */

test('constructor rejects a self-loop fallback', () => {
  const queue = makeQueueWith([makeEvent()]);
  assert.throws(
    () => createAlertDispatcher({ queue, now, dryRun: false, fallbackChannels: { sms: ['sms'] } }),
    /self-loop/,
  );
});

test('constructor rejects a two-channel cycle', () => {
  const queue = makeQueueWith([makeEvent()]);
  assert.throws(
    () => createAlertDispatcher({ queue, now, dryRun: false, fallbackChannels: { sms: ['email'], email: ['sms'] } }),
    /cycle/,
  );
});

test('constructor rejects a longer cycle', () => {
  const queue = makeQueueWith([makeEvent()]);
  assert.throws(
    () =>
      createAlertDispatcher({
        queue,
        now,
        dryRun: false,
        fallbackChannels: { sms: ['email'], email: ['push'], push: ['sms'] },
      }),
    /cycle/,
  );
});

test('constructor rejects non-array fallback lists and non-string names', () => {
  const queue = makeQueueWith([makeEvent()]);
  assert.throws(
    () => createAlertDispatcher({ queue, now, dryRun: false, fallbackChannels: { sms: 'email' } }),
    /non-empty array/,
  );
  assert.throws(
    () => createAlertDispatcher({ queue, now, dryRun: false, fallbackChannels: { sms: [42] } }),
    /non-empty string/,
  );
  assert.throws(
    () => createAlertDispatcher({ queue, now, dryRun: false, fallbackChannels: 'nope' }),
    /must be an object/,
  );
});

test('duplicate fallbacks are deduped, not double-attempted', async () => {
  const calls = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email', 'email'] },
    adapters: {
      sms: failingAdapter('sms', { calls }),
      email: failingAdapter('email', { calls }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.failed.length, 1);
  assert.deepEqual(report.failed[0].attemptedChannels, ['sms', 'email']);
  // 3 attempts on sms + 3 on email — no doubled email budget.
  assert.equal(report.failed[0].attempts, 6);
  assert.equal(calls.filter((c) => c === 'email').length, 3);
});

/* ------------------------------------------------------------------ *
 * Failover behavior.
 * ------------------------------------------------------------------ */

test('failing primary falls through to email — alert still delivered', async () => {
  const smsCalls = [];
  const emailSink = [];
  const persistence = recordingPersistence();
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    persistence,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms', { calls: smsCalls }),
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.failed.length, 0);
  const result = report.delivered[0];
  // Primary got its full retry budget before the chain moved on.
  assert.equal(smsCalls.length, 3);
  assert.deepEqual(result.attemptedChannels, ['sms', 'email']);
  assert.equal(result.adapter, 'email');
  assert.equal(result.to, 'user@example.com');
  // Delivery log names the channel that actually delivered, once.
  assert.equal(persistence.rows.length, 1);
  assert.deepEqual(persistence.rows[0].channels, ['email']);
  assert.equal(emailSink.length, 1);
});

test('throwing primary is caught and falls through — never a crash', async () => {
  const emailSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: throwingAdapter('sms'),
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].adapter, 'email');
  assert.deepEqual(report.delivered[0].attemptedChannels, ['sms', 'email']);
  assert.match(report.delivered[0].attempted[0].receipt.error, /ADAPTER THREW/);
});

test('missing primary adapter is a loud refusal, then the fallback delivers', async () => {
  const emailSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.match(report.delivered[0].attempted[0].receipt.error, /NO ADAPTER/);
  assert.deepEqual(report.delivered[0].attemptedChannels, ['sms', 'email']);
});

test('primary recovering on retry never touches the fallback', async () => {
  const emailSink = [];
  const smsCalls = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: flakyAdapter('sms', 2, { calls: smsCalls }),
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].adapter, 'sms');
  assert.deepEqual(report.delivered[0].attemptedChannels, ['sms']);
  assert.equal(emailSink.length, 0);
});

test('transitive chains walk in order: sms → email → push', async () => {
  const pushSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'], email: ['push'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: failingAdapter('email'),
      push: createConsoleAdapter({ sink: pushSink, name: 'push' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].adapter, 'push');
  assert.deepEqual(report.delivered[0].attemptedChannels, ['sms', 'email', 'push']);
  assert.equal(pushSink.length, 1);
});

test('total failure dead-letters with the channel trail, event intact', async () => {
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: failingAdapter('email'),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 0);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].attempts, 6);
  assert.deepEqual(report.failed[0].attemptedChannels, ['sms', 'email']);
  assert.equal(report.failed[0].event.release_id, 'rel_1');
  assert.equal(report.failed[0].receipt.error, 'email refused');
  const dead = dispatcher.deadLetter();
  assert.equal(dead.length, 1);
  assert.deepEqual(dead[0].attemptedChannels, ['sms', 'email']);
});

test('a channel with no fallbacks keeps the single-channel contract', async () => {
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    adapters: { sms: failingAdapter('sms') },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].attempts, 3);
  assert.deepEqual(report.failed[0].attemptedChannels, ['sms']);
});

/* ------------------------------------------------------------------ *
 * Operator override + dry-run semantics.
 * ------------------------------------------------------------------ */

test('explicit channel override bypasses fallbacks — forced is forced', async () => {
  const emailSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  const report = await dispatcher.dispatchAll({ channel: 'sms' });
  assert.equal(report.failed.length, 1);
  assert.deepEqual(report.failed[0].attemptedChannels, ['sms']);
  assert.equal(emailSink.length, 0);
});

test('dry-run never triggers the chain — the default printer delivers the primary', async () => {
  const lines = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    out: { write: (s) => lines.push(s) },
    fallbackChannels: { sms: ['email'] },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].receipt.dryRun, true);
  assert.deepEqual(report.delivered[0].attemptedChannels, ['sms']);
  assert.equal(lines.length, 1);
});

test('redispatchDead retries through the chain again with a fresh budget', async () => {
  const smsCalls = [];
  const emailSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const smsAdapter = {
    name: 'sms',
    kind: 'email',
    fail: true,
    async send() {
      smsCalls.push('sms');
      if (this.fail) return { ok: false, channel: 'sms', error: 'sms refused', sentAt: iso() };
      return { ok: true, channel: 'sms', messageId: 'sms_fixed', sentAt: iso() };
    },
  };
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: smsAdapter,
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  // First pass: sms down, email saves the alert.
  const first = await dispatcher.dispatchAll();
  assert.equal(first.delivered.length, 1);
  assert.equal(first.delivered[0].adapter, 'email');

  // Now a second event whose BOTH channels fail, then sms recovers.
  const queue2 = makeQueueWith([makeEvent({ release_id: 'rel_2' })]);
  const dispatcher2 = createAlertDispatcher({
    queue: queue2,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: failingAdapter('email'),
    },
  });
  const second = await dispatcher2.dispatchAll();
  assert.equal(second.failed.length, 1);
  assert.equal(dispatcher2.deadLetter().length, 1);
  // Operator fixes email, then redispatches — the chain walks again.
  dispatcher2.registerAdapter('email', createConsoleAdapter({ sink: [], name: 'email' }));
  const revived = await dispatcher2.redispatchDead();
  assert.equal(revived.delivered.length, 1);
  assert.equal(revived.delivered[0].adapter, 'email');
  assert.deepEqual(revived.delivered[0].attemptedChannels, ['sms', 'email']);
  assert.equal(dispatcher2.deadLetter().length, 0);
});

test('fallback delivery still dedupes — the event delivers exactly once', async () => {
  const emailSink = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: createConsoleAdapter({ sink: emailSink, name: 'email' }),
    },
  });
  await dispatcher.dispatchAll();
  const again = await dispatcher.dispatchAll();
  assert.equal(again.drained, 0);
  assert.equal(emailSink.length, 1);
});

test('end-to-end through the real persistence: one delivery-log row, email channel', async () => {
  const store = createStore();
  store.alerts.remove(() => true);
  const persistence = createAlertPersistence(store);
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    persistence,
    fallbackChannels: { sms: ['email'] },
    adapters: {
      sms: failingAdapter('sms'),
      email: createConsoleAdapter({ sink: [], name: 'email' }),
    },
  });
  await dispatcher.dispatchAll();
  const rows = store.alerts.all();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].channels, ['email']);
  assert.equal(rows[0].user_id, 'u_1');
  assert.equal(rows[0].release_id, 'rel_1');
});
