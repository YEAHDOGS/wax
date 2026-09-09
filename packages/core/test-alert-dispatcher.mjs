/**
 * Smoke/regression check for `packages/core/src/alert-dispatcher.js` —
 * the dispatch stage between the alert queue and the send adapters
 * (ALERT-ENGINE-PLAN.md §3, "Alert delivery").
 *
 * Run: `node --test packages/core/test-alert-dispatcher.mjs`
 * Zero dependencies beyond the Node standard library. Pins the six
 * properties the module exists for:
 *
 * 1. The DEFAULT adapter is the dry-run printer: it prints what would be
 *    sent, returns `{ ok: true, dryRun: true }` receipts, and opens no
 *    socket — dry-run sends nothing.
 * 2. Adapters register by channel name and plug in without touching the
 *    dispatcher (a future Resend adapter arrives through one
 *    `registerAdapter` call); bad shapes are rejected at registration.
 * 3. Dedupe: a drained event is delivered exactly once — never twice in
 *    one process, and never again after a restart (the seen-set replays
 *    the durable delivery-log rows via `restoreQueueSeen`).
 * 4. Adapter failures never lose alerts: fail-once adapters deliver on
 *    retry, always-failing adapters dead-letter after `maxAttempts` with
 *    the event intact, and a throwing adapter becomes a receipt, never a
 *    crash.
 * 5. The delivery log: every successful delivery writes a durable `alerts`
 *    row with who (user_id), what (release_id), when (dispatched_at), and
 *    which adapter (channels) — accurate per user.
 * 6. `redispatchDead` revives dead letters with a fresh attempt budget.
 *
 * If any of them fail, the dispatch stage can double-send, silently drop,
 * or log fiction — exactly the failure modes Brando flagged as his #1 pain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from './src/store.js';
import { createAlertQueue } from './src/alert-queue.js';
import { createAlertPersistence } from './src/alert-persistence.js';
import { createAlertDispatcher, composeDispatchMessage } from './src/alert-dispatcher.js';
import { createDryRunAdapter, createConsoleAdapter } from './src/send-adapters.js';

const NOW_MS = 1_000_000;
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
    ...overrides,
  };
}

function makeQueueWith(events, queueOpts = {}) {
  const queue = createAlertQueue({ now, ...queueOpts });
  queue.enqueue(events);
  return queue;
}

function makeStoreWithPersistence() {
  const store = createStore();
  // Start the delivery log empty — the seed ships demo alerts, and these
  // tests assert exact row counts for rows the dispatcher wrote.
  store.alerts.remove(() => true);
  return { store, persistence: createAlertPersistence(store) };
}

/* ------------------------------------------------------------------ *
 * 1. Dry-run is the default; dry-run sends nothing real.
 * ------------------------------------------------------------------ */

test('default adapter is the dry-run printer — prints, ok:true, dryRun:true', async () => {
  const lines = [];
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({ queue, now, out: { write: (s) => lines.push(s) } });
  assert.deepEqual(dispatcher.adapters(), ['default']);
  const report = await dispatcher.dispatchAll();
  assert.equal(report.dryRun, true);
  assert.equal(report.drained, 1);
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].receipt.ok, true);
  assert.equal(report.delivered[0].receipt.dryRun, true);
  assert.ok(report.delivered[0].receipt.messageId.startsWith('dryrun_'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /would send email/);
});

test('dry-run print line carries the alert content — artist, title, price', async () => {
  const lines = [];
  const queue = makeQueueWith([makeEvent({ artist_name: 'Sun Kil Moon', title: 'Benji', price_cents: 6000 })]);
  const dispatcher = createAlertDispatcher({ queue, now, out: { write: (s) => lines.push(s) } });
  await dispatcher.dispatchAll();
  assert.match(lines[0], /Sun Kil Moon/);
  assert.match(lines[0], /Benji/);
  assert.match(lines[0], /\$60\.00/);
});

test('createDryRunAdapter is fraud-proof by construction: dryRun + unwired, no send path', () => {
  const adapter = createDryRunAdapter({ out: { write: () => {} } });
  assert.equal(adapter.dryRun, true);
  assert.equal(adapter.wired, false);
  assert.equal(typeof adapter.send, 'function');
  // The only I/O a dry-run adapter performs is the printed line.
  const src = adapter.send.toString();
  assert.ok(!/fetch|http|Request|socket/i.test(src), 'dry-run send must not reference network primitives');
});

test('dry-run needs a writable out — garbage out is refused loudly', () => {
  assert.throws(() => createDryRunAdapter({ out: null }), /writable out/);
  assert.throws(() => createDryRunAdapter({ out: {} }), /writable out/);
});

/* ------------------------------------------------------------------ *
 * 2. Adapter registration — the plug-in seam.
 * ------------------------------------------------------------------ */

test('registerAdapter rejects bad shapes at registration, not mid-dispatch', () => {
  const dispatcher = createAlertDispatcher({ queue: makeQueueWith([]), now });
  assert.throws(() => dispatcher.registerAdapter('', { send: async () => ({}) }), /non-empty string/);
  assert.throws(() => dispatcher.registerAdapter('email', null), /must be an object/);
  assert.throws(() => dispatcher.registerAdapter('email', { name: 'x', kind: 'email' }), /send\(envelope\)/);
});

test("an event's channel picks its adapter — future email adapter plugs in with one call", async () => {
  const sink = [];
  const emailAdapter = createConsoleAdapter({ sink, name: 'resend', kind: 'email' });
  const queue = makeQueueWith([makeEvent({ channel: 'email' })]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    out: { write: () => {} },
    adapters: { email: emailAdapter },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].adapter, 'resend');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].channel, 'resend', 'sink records the adapter name, per the console adapter contract');
});

test('non-dry-run with no adapter for the channel is a loud NO ADAPTER refusal — never a silent drop', async () => {
  const queue = makeQueueWith([makeEvent({ channel: 'sms' })]);
  const dispatcher = createAlertDispatcher({ queue, now, dryRun: false, maxAttempts: 1 });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 0);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].receipt.ok, false);
  assert.match(report.failed[0].receipt.error, /NO ADAPTER/);
});

/* ------------------------------------------------------------------ *
 * 3. Dedupe — exactly once, in-process and across restarts.
 * ------------------------------------------------------------------ */

test('a drained event is delivered exactly once — a second pass finds nothing', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({ queue, persistence, now, out: { write: () => {} } });
  const first = await dispatcher.dispatchAll();
  assert.equal(first.delivered.length, 1);
  const second = await dispatcher.dispatchAll();
  assert.equal(second.drained, 0);
  assert.equal(second.delivered.length, 0);
  assert.equal(store.alerts.all().length, 1);
});

test('restart replay: dispatched alerts never re-deliver after a reboot', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const queueA = makeQueueWith([makeEvent()]);
  const dispatcherA = createAlertDispatcher({ queue: queueA, persistence, now, out: { write: () => {} } });
  await dispatcherA.dispatchAll();
  assert.equal(store.alerts.all().length, 1);

  // Restart: fresh queue, seen-set restored from the delivery-log rows.
  const queueB = createAlertQueue({ now });
  persistence.restoreQueueSeen(queueB);
  const outcome = queueB.enqueue([makeEvent()]);
  assert.equal(outcome.queued.length, 0, 'already-alerted user+release must not re-queue');
  assert.equal(outcome.dupes.length, 1);
  const dispatcherB = createAlertDispatcher({ queue: queueB, persistence, now, out: { write: () => {} } });
  const report = await dispatcherB.dispatchAll();
  assert.equal(report.delivered.length, 0);
  assert.equal(store.alerts.all().length, 1, 'no second delivery-log row');
});

test('constructor guards: no queue and bad maxAttempts throw', () => {
  assert.throws(() => createAlertDispatcher({}), /queue/);
  assert.throws(() => createAlertDispatcher({ queue: makeQueueWith([]), maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createAlertDispatcher({ queue: makeQueueWith([]), maxAttempts: 1.5 }), /maxAttempts/);
});

/* ------------------------------------------------------------------ *
 * 4. Failure policy — failures retry, never drop.
 * ------------------------------------------------------------------ */

function flakyAdapter({ failTimes, name = 'flaky' }) {
  let calls = 0;
  return {
    name,
    kind: 'email',
    calls: () => calls,
    async send() {
      calls += 1;
      if (calls <= failTimes) {
        return { ok: false, channel: name, error: 'transient boom', sentAt: iso() };
      }
      return { ok: true, channel: name, messageId: 'm1', sentAt: iso() };
    },
  };
}

test('fail-once adapter delivers on retry — one delivery-log row, not two', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const flaky = flakyAdapter({ failTimes: 1 });
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    persistence,
    now,
    dryRun: false,
    maxAttempts: 3,
    adapters: { default: flaky },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(flaky.calls(), 2, 'one failure + one retry');
  assert.equal(store.alerts.all().length, 1, 'exactly one delivery-log row');
});

test('always-failing adapter dead-letters after maxAttempts — the event survives, the log stays clean', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const flaky = flakyAdapter({ failTimes: 99 });
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    persistence,
    now,
    dryRun: false,
    maxAttempts: 3,
    adapters: { default: flaky },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 0);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].attempts, 3);
  assert.equal(flaky.calls(), 3);
  assert.equal(store.alerts.all().length, 0, 'no delivery-log row for an undelivered alert');
  const dead = dispatcher.deadLetter();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].event.release_id, 'rel_1', 'the dead letter still carries the event');
});

test('a throwing adapter becomes a receipt, never a crash', async () => {
  const throwing = {
    name: 'kaboom',
    kind: 'email',
    async send() {
      throw new Error('socket exploded');
    },
  };
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    maxAttempts: 2,
    adapters: { default: throwing },
  });
  const report = await dispatcher.dispatchAll(); // must not throw
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].receipt.ok, false);
  assert.match(report.failed[0].receipt.error, /ADAPTER THREW/);
});

test('a garbage receipt (non-object) becomes a refusal, never a crash', async () => {
  const garbage = { name: 'junk', kind: 'email', async send() { return undefined; } };
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    now,
    dryRun: false,
    maxAttempts: 1,
    adapters: { default: garbage },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].receipt.error, /RECEIPT INVALID/);
});

test('redispatchDead gives dead letters a fresh attempt budget once the adapter is fixed', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const flaky = flakyAdapter({ failTimes: 99, name: 'broken' });
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({
    queue,
    persistence,
    now,
    dryRun: false,
    maxAttempts: 2,
    adapters: { default: flaky },
  });
  const first = await dispatcher.dispatchAll();
  assert.equal(first.failed.length, 1);
  assert.equal(dispatcher.deadLetter().length, 1);

  // Adapter fixed: swap in a working one and revive.
  const working = { name: 'fixed', kind: 'email', async send() { return { ok: true, channel: 'fixed', messageId: 'm2', sentAt: iso() }; } };
  dispatcher.registerAdapter('default', working);
  const revived = await dispatcher.redispatchDead();
  assert.equal(revived.delivered.length, 1);
  assert.equal(dispatcher.deadLetter().length, 0);
  assert.equal(store.alerts.all().length, 1);
  assert.deepEqual(store.alerts.all()[0].channels, ['fixed']);
});

/* ------------------------------------------------------------------ *
 * 5. Delivery log accuracy — who got what, when, via which adapter.
 * ------------------------------------------------------------------ */

test('delivery log records who, what, when, and which adapter — per user', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const emailSink = [];
  const smsSink = [];
  const queue = makeQueueWith([
    makeEvent({ user_id: 'u_1', release_id: 'rel_1', channel: 'email', kind: 'new' }),
    makeEvent({ user_id: 'u_2', release_id: 'rel_2', channel: 'sms', kind: 'price_drop', artist_name: 'Death Grips', title: 'Year of the Snitch', price_cents: 2500 }),
  ]);
  const dispatcher = createAlertDispatcher({
    queue,
    persistence,
    now,
    dryRun: false,
    adapters: {
      email: createConsoleAdapter({ sink: emailSink, name: 'console-email', kind: 'email' }),
      sms: createConsoleAdapter({ sink: smsSink, name: 'console-sms', kind: 'sms' }),
    },
  });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 2);

  const rows = store.alerts.all();
  assert.equal(rows.length, 2);
  const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
  assert.equal(byUser.u_1.release_id, 'rel_1');
  assert.equal(byUser.u_2.release_id, 'rel_2');
  assert.deepEqual(byUser.u_1.channels, ['console-email']);
  assert.deepEqual(byUser.u_2.channels, ['console-sms']);
  assert.equal(byUser.u_1.dispatched_at, iso());
  assert.ok(!Number.isNaN(Date.parse(byUser.u_2.dispatched_at)), 'dispatched_at is a real timestamp');
});

test('dry-run deliveries are logged too — with the dry-run channel, honestly marked', async () => {
  const { store, persistence } = makeStoreWithPersistence();
  const queue = makeQueueWith([makeEvent()]);
  const dispatcher = createAlertDispatcher({ queue, persistence, now, out: { write: () => {} } });
  const report = await dispatcher.dispatchAll();
  assert.equal(report.delivered.length, 1);
  const rows = store.alerts.all();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].channels, ['dry-run']);
  assert.equal(report.delivered[0].receipt.dryRun, true);
});

/* ------------------------------------------------------------------ *
 * 6. Message composition.
 * ------------------------------------------------------------------ */

test('composeDispatchMessage carries artist, title, price, and the buy link', () => {
  const { subject, text } = composeDispatchMessage(makeEvent());
  assert.match(subject, /MF DOOM/);
  assert.match(subject, /Madvillainy/);
  assert.match(subject, /\$34\.99/);
  assert.match(text, /https:\/\/shop\.example\/madvillainy/);
});

test('default address resolution: explicit to wins, then the store user row', async () => {
  const store = createStore();
  // Reach the resolver through a send: capture the envelope `to`.
  const seen = [];
  const capture = { name: 'cap', kind: 'email', async send(envelope) { seen.push(envelope.to); return { ok: true, channel: 'cap', messageId: 'x', sentAt: iso() }; } };
  const run = async (event) => {
    const queue = makeQueueWith([event]);
    const dispatcher = createAlertDispatcher({
      queue, store, now, dryRun: false, adapters: { default: capture },
    });
    await dispatcher.dispatchAll();
  };
  await run(makeEvent({ to: 'direct@example.com' }));
  await run(makeEvent({ user_id: 'usr_test' })); // seeded user test@wax.fm
  await run(makeEvent({ user_id: 'u_nobody' }));
  assert.deepEqual(seen, ['direct@example.com', 'test@wax.fm', null]);
});
