/**
 * Smoke/regression check for `packages/core/src/alert-scheduler.js` —
 * the tick loop wiring the wantlist batch path together
 * (ALERT-ENGINE-PLAN.md §4 item 4, the "hook runEngine into the batch
 * path" NEXT step).
 *
 * Run: `node --test packages/core/test-alert-scheduler.mjs`
 * Zero dependencies beyond the Node standard library. Pins the four
 * properties the scheduler exists for:
 *
 * 1. Scheduled ticks process fixture release batches into the queue —
 *    tick 1 on the fixtures queues `new` events; tick 2 on the same
 *    batch goes quiet (state survives between ticks, an alert fires
 *    once); a changed batch (price drop) fires again.
 * 2. The queue's rate cap still holds under a tick flood — over-cap
 *    events are reported as `capped`, never silently dropped.
 * 3. Disabled adapters never send — draining a tick's queued events
 *    through the NOT-WIRED stubs yields only `{ ok: false }` NOT WIRED
 *    receipts; no socket is ever opened.
 * 4. `start`/`stop` run ticks on an interval and halt cleanly.
 *
 * If any of them fail, the engine→queue contract the scheduler sits on
 * changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAlertScheduler } from './src/alert-scheduler.js';
import { createAlertQueue } from './src/alert-queue.js';
import {
  createDisabledResendAdapter,
  createDisabledTwilioAdapter,
  createConsoleAdapter,
} from './src/send-adapters.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const WANTS = load('wantlist.json').wants;
const RELEASES = load('discogs-releases.json').releases;

function makeScheduler({ releases = RELEASES, wantlist = WANTS, queueOpts = {}, now = () => 1_000_000 } = {}) {
  const queue = createAlertQueue({ ...queueOpts, now });
  return { scheduler: createAlertScheduler({ getReleases: () => releases, getWantlist: () => wantlist, queue, now }), queue };
}

test('tick 1 processes fixture releases into the queue', async () => {
  const { scheduler, queue } = makeScheduler();
  const report = await scheduler.tick();
  assert.equal(report.tick, 1);
  assert.ok(report.events.length > 0, 'fixture batch should match some wants');
  assert.equal(report.queued.length, report.events.length, 'every event should enqueue on a fresh queue');
  assert.deepEqual(report.capped, []);
  assert.ok(queue.size() > 0, 'queue should hold the tick\'s events');
});

test('steady-state tick on the same batch goes quiet — alerts fire once', async () => {
  const { scheduler, queue } = makeScheduler();
  const first = await scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.queued.length, 0, 'no new events on an unchanged batch');
  assert.equal(second.events.length, 0, 'engine fires nothing twice');
  assert.equal(queue.size(), first.queued.length, 'queue holds only the first tick\'s events');
  assert.equal(scheduler.ticks(), 2);
});

test('a changed batch fires again (price drop on a seen release)', async () => {
  const base = RELEASES.map((r) =>
    r.id === 9900210 ? { ...r, price_cents: 4500 } : r,
  );
  const cheaper = RELEASES.map((r) =>
    r.id === 9900210 ? { ...r, price_cents: 3000 } : r,
  );
  const batches = [base, cheaper, cheaper];
  let i = 0;
  const queue = createAlertQueue();
  const scheduler = createAlertScheduler({
    getReleases: () => batches[Math.min(i++, batches.length - 1)],
    getWantlist: () => WANTS,
    queue,
  });
  const first = await scheduler.tick(); // Benji seen at 4500 → 'new'
  assert.equal(first.events.length > 0, true);
  const second = await scheduler.tick(); // Benji now 3000 → 'price_drop'
  assert.ok(
    second.events.some((e) => e.kind === 'price_drop' && e.release_id === 9900210),
    `expected a price_drop for release 9900210, got ${JSON.stringify(second.events.map((e) => [e.kind, e.release_id]))}`,
  );
  const third = await scheduler.tick(); // same cheaper batch → quiet
  assert.equal(third.events.length, 0);
  assert.equal(scheduler.ticks(), 3);
});

test('price-drop tick enqueues a price_drop event', async () => {
  const base = RELEASES.map((r) => (r.id === 15236781 ? { ...r, price_cents: 3000 } : r));
  const drops = base.map((r) => (r.id === 15236781 ? { ...r, price_cents: 2500 } : r));
  let batches = [base, drops];
  let i = 0;
  const queue = createAlertQueue();
  const scheduler = createAlertScheduler({
    getReleases: () => batches[Math.min(i++, batches.length - 1)],
    getWantlist: () => WANTS,
    queue,
  });
  await scheduler.tick();
  const report = await scheduler.tick();
  const kinds = report.events.map((e) => e.kind);
  assert.ok(kinds.includes('price_drop'), `expected a price_drop event, got ${kinds.join(',')}`);
  // The queue dedupes user+release (pinned contract): the release already
  // alerted as 'new' in tick 1, so the price_drop lands in `dupes` —
  // reported, never silently dropped.
  assert.equal(report.queued.length + report.dupes.length, report.events.length);
  assert.equal(report.dupes.length, 1);
});

test('rate caps still hold under a tick flood — capped events reported, never dropped', async () => {
  // twenty distinct releases each matching one user's watch → twenty
  // first-sight events, but the per-user cap only admits three.
  const floods = Array.from({ length: 20 }, (_, n) => ({
    id: `want_flood_${n}`,
    user_id: 'u_flood',
    artist: 'MF DOOM',
    format: 'Vinyl',
  }));
  const releases = Array.from({ length: 20 }, (_, n) => ({
    id: 500000 + n,
    artists: [{ name: 'MF DOOM' }],
    title: `Flood Pressing ${n}`,
    formats: [{ name: 'Vinyl', descriptions: ['LP'] }],
    price_cents: 3000,
    in_stock: true,
    currency: 'USD',
  }));
  const { scheduler, queue } = makeScheduler({
    releases,
    wantlist: floods,
    queueOpts: { maxPerUserPerHour: 3 },
  });
  const report = await scheduler.tick();
  assert.equal(report.events.length, 20, `flood should produce 20 events, got ${report.events.length}`);
  assert.equal(report.queued.length, 3, 'cap refuses everything past 3');
  assert.equal(report.queued.length + report.capped.length, report.events.length, 'every event is accounted for');
  assert.equal(queue.queuedForUser('u_flood'), 3);
});

test('disabled adapters never send — drained tick events get NOT-WIRED receipts only', async () => {
  const { scheduler, queue } = makeScheduler();
  await scheduler.tick();
  const drained = queue.drain();
  assert.ok(drained.length > 0, 'needs drained events to attempt sends with');

  const resend = createDisabledResendAdapter();
  const twilio = createDisabledTwilioAdapter();
  for (const event of drained) {
    const emailReceipt = await resend.send({ to: 'devnull@example.com', message: 'alert', nowMs: 1_000_000 });
    const smsReceipt = await twilio.send({ to: '+15551234567', message: 'alert', nowMs: 1_000_000 });
    assert.equal(emailReceipt.ok, false);
    assert.equal(smsReceipt.ok, false);
    assert.match(emailReceipt.error, /NOT WIRED/);
    assert.match(smsReceipt.error, /NOT WIRED/);
  }
  assert.equal(resend.wired, false);
  assert.equal(twilio.wired, false);
});

test('console adapter records sends in-memory without touching the network', async () => {
  const { scheduler, queue } = makeScheduler();
  await scheduler.tick();
  const drained = queue.drain();
  const sink = [];
  const consoleAdapter = createConsoleAdapter({ sink });
  for (const event of drained) {
    const receipt = await consoleAdapter.send({ to: 'test@example.com', message: event.title, nowMs: 1_000_000 });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.dev, true, 'dev receipt must never be mistaken for a real delivery');
  }
  assert.equal(sink.length, drained.length);
});

test('start ticks on an interval and stop halts it', async () => {
  const { scheduler } = makeScheduler();
  assert.equal(scheduler.running(), false);
  scheduler.start(10);
  assert.equal(scheduler.running(), true);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(scheduler.ticks() >= 2, `expected at least 2 ticks, got ${scheduler.ticks()}`);
  scheduler.stop();
  assert.equal(scheduler.running(), false);
  const frozen = scheduler.ticks();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scheduler.ticks(), frozen, 'no ticks after stop');
});

test('constructor rejects missing providers and bad intervals', () => {
  const queue = createAlertQueue();
  assert.throws(() => createAlertScheduler({ getWantlist: () => [], queue }), TypeError);
  assert.throws(() => createAlertScheduler({ getReleases: () => [], queue }), TypeError);
  assert.throws(() => createAlertScheduler({ getReleases: () => [], getWantlist: () => [] }), TypeError);
  const s = createAlertScheduler({ getReleases: () => [], getWantlist: () => [], queue });
  assert.throws(() => s.start(0), TypeError);
  assert.throws(() => s.start(-5), TypeError);
});

test('tick reports flow through onTick', async () => {
  const seen = [];
  const queue = createAlertQueue();
  const scheduler = createAlertScheduler({
    getReleases: () => RELEASES,
    getWantlist: () => WANTS,
    queue,
    now: () => 1_000_000,
    onTick: (report) => seen.push(report),
  });
  const report = await scheduler.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tick, 1);
  assert.deepEqual(seen[0], report);
});
