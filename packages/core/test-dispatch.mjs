/**
 * Smoke/regression check for `packages/core/src/dispatch.js` — the alert
 * dispatch layer (ALERT-ENGINE-PLAN.md §3, after fetch + scan).
 *
 * Run: `node --test packages/core/test-dispatch.mjs`
 * No dependencies beyond the Node standard library. The webhook channel is
 * tested against a local stub server on 127.0.0.1 — there is no outbound
 * network here, ever. These tests pin the dispatch contract: the channel
 * interface, the guards, the loud provider stubs, and exactly-once
 * dispatch of a deduped alert with receipts recorded in the scan log. If
 * any of them fail, the delivery contract with the alert engine changed,
 * and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStore,
  runScanPass,
  WEBHOOK_TIMEOUT_MS,
  canPost,
  assertChannel,
  createWebhookChannel,
  createLogChannel,
  createResendChannel,
  createTwilioChannel,
  dispatchAlert,
  dispatchScanAlerts,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Local stub webhook server (loopback only — never the open internet)
 * ------------------------------------------------------------------ */

const T0 = Date.parse('2026-09-09T11:00:00.000Z');

function startStubServer({ statusCode = 200 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(statusCode, { 'content-type': 'application/json', 'x-request-id': `stub-${received.length}` });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, received, url: `http://127.0.0.1:${port}/hook` });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Guards + channel contract
 * ------------------------------------------------------------------ */

test('canPost: only http(s) URLs may be webhook targets', () => {
  assert.equal(canPost('https://hooks.example/x'), true);
  assert.equal(canPost('http://127.0.0.1:9/hook'), true);
  assert.equal(canPost('file:///etc/passwd'), false);
  assert.equal(canPost('ftp://x.example/'), false);
  assert.equal(canPost('not a url'), false);
  assert.equal(canPost(null), false);
});

test('createWebhookChannel: rejects non-http(s) targets at setup, loudly', () => {
  assert.throws(() => createWebhookChannel({ url: 'file:///etc/passwd' }), /http\(s\) url/);
  assert.throws(() => createWebhookChannel({}), /http\(s\) url/);
});

test('assertChannel: a channel missing name/kind/send fails at setup', () => {
  assert.throws(() => assertChannel(null), /must be an object/);
  assert.throws(() => assertChannel({ kind: 'x', send() {} }), /'name'/);
  assert.throws(() => assertChannel({ name: 'x', kind: 'y' }), /send\(envelope\)/);
});

test('createLogChannel: rejects a missing path at setup', () => {
  assert.throws(() => createLogChannel({}), /file path/);
});

/* ------------------------------------------------------------------ *
 * Provider stubs fail loudly — never a fake send as a real one
 * ------------------------------------------------------------------ */

test('createResendChannel: throws without a live key, names Brando as the source', () => {
  assert.throws(() => createResendChannel({}), /needs a live API key from Brando/);
  assert.throws(() => createResendChannel({ from: 'a@b.c' }), /needs a live API key from Brando/);
  assert.throws(() => createResendChannel({ apiKey: 're_x' }), /verified sender/);
});

test('createTwilioChannel: throws without live credentials, names Brando as the source', () => {
  assert.throws(() => createTwilioChannel({}), /needs live credentials from Brando/);
  assert.throws(() => createTwilioChannel({ accountSid: 'ACx' }), /needs live credentials from Brando/);
});

test('provider stubs: even WITH keys, send() refuses to fake a delivery', async () => {
  const resend = createResendChannel({ apiKey: 're_x', from: 'alerts@wax.wearedogs.net' });
  const twilio = createTwilioChannel({ accountSid: 'ACx', authToken: 'tok', from: '+15550123456' });
  await assert.rejects(() => resend.send({}), /documented stub/);
  await assert.rejects(() => twilio.send({}), /documented stub/);
});

/* ------------------------------------------------------------------ *
 * Webhook channel against the loopback stub server
 * ------------------------------------------------------------------ */

test('webhook channel: POSTs the alert JSON, resolves an ok receipt', async () => {
  const { server, received, url } = await startStubServer();
  try {
    const channel = createWebhookChannel({ url });
    const receipt = await channel.send({
      alert: { artist_name: 'Miles Davis', title: 'Kind of Blue LP', price_cents: 2999 },
      channel: 'email',
      to: 'a@example.com',
      message: { subject: 'Wax drop', text: 'hello' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.channel, 'webhook');
    assert.ok(receipt.messageId);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].body.event, 'wax.alert');
    assert.equal(received[0].body.channel, 'email');
    assert.equal(received[0].body.to, 'a@example.com');
    assert.equal(received[0].body.alert.artist_name, 'Miles Davis');
    assert.equal(received[0].body.message.subject, 'Wax drop');
  } finally {
    server.close();
  }
});

test('webhook channel: a 5xx receiver resolves { ok: false }, never throws', async () => {
  const { server, url } = await startStubServer({ statusCode: 500 });
  try {
    const channel = createWebhookChannel({ url });
    const receipt = await channel.send({ alert: {}, channel: 'email', to: 'a@example.com', message: null, nowMs: T0 });
    assert.equal(receipt.ok, false);
    assert.match(receipt.error, /HTTP 500/);
  } finally {
    server.close();
  }
});

test('webhook channel: an unreachable receiver resolves { ok: false }, never throws', async () => {
  const channel = createWebhookChannel({ url: 'http://127.0.0.1:1/hook', timeoutMs: 500 });
  const receipt = await channel.send({ alert: {}, channel: 'email', to: 'a@example.com', message: null, nowMs: T0 });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /webhook failed/);
});

/* ------------------------------------------------------------------ *
 * Log channel
 * ------------------------------------------------------------------ */

test('log channel: appends one JSONL line per send, receipt marked dev', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wax-dispatch-'));
  try {
    const path = join(dir, 'deliveries.jsonl');
    const channel = createLogChannel({ path });
    const receipt = await channel.send({
      alert: { artist_name: 'Miles Davis' },
      channel: 'email',
      to: 'a@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.dev, true);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.message_id, receipt.messageId);
    assert.equal(row.dev, true);
    assert.equal(row.to, 'a@example.com');
    assert.equal(row.message.subject, 's');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * dispatchAlert verdicts
 * ------------------------------------------------------------------ */

function dropAlert(overrides = {}) {
  return {
    kind: 'drop',
    user_id: 'usr_1',
    artist_name: 'Miles Davis',
    title: 'Kind of Blue LP',
    listing_url: 'https://shop.example/lp',
    detected_at: new Date(T0).toISOString(),
    recipient: { email: 'a@example.com', sms: '+15550123456' },
    deliveries: [
      { channel: 'email', message: { subject: 'Wax drop', text: 'hello' }, verdict: { dispatch: true } },
      { channel: 'sms', message: 'Wax: Miles Davis', verdict: { dispatch: false, reason: 'rate cap' } },
    ],
    ...overrides,
  };
}

test('dispatchAlert: green-lit delivery goes out, held-back delivery is a skipped receipt, never dropped', async () => {
  const sent = [];
  const email = { name: 'fake-email', kind: 'email', send: async (e) => { sent.push(e); return { ok: true, channel: 'email', messageId: 'm1', sentAt: new Date(T0).toISOString() }; } };
  const receipts = await dispatchAlert({ alert: dropAlert(), channels: { email }, nowMs: T0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@example.com');
  const ok = receipts.find((r) => r.channel === 'email');
  assert.equal(ok.ok, true);
  const skipped = receipts.find((r) => r.channel === 'sms');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'rate cap');
});

test('dispatchAlert: a channel with no configuration is a loud { ok: false } receipt, not a silent drop', async () => {
  const receipts = await dispatchAlert({ alert: dropAlert(), channels: {}, nowMs: T0 });
  const missing = receipts.find((r) => r.channel === 'email');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no channel configured/);
});

test('dispatchAlert: a throwing channel is caught into a receipt, the sibling delivery still goes out', async () => {
  const sent = [];
  const email = { name: 'ok-email', kind: 'email', send: async (e) => { sent.push(e); return { ok: true, channel: 'email', messageId: 'm1', sentAt: new Date(T0).toISOString() }; } };
  const boom = { name: 'boom', kind: 'email', send: async () => { throw new Error('kaput'); } };
  const receipts = await dispatchAlert({
    alert: dropAlert({
      deliveries: [
        { channel: 'email', message: { subject: 's', text: 't' }, verdict: { dispatch: true } },
        { channel: 'sms', message: 'x', verdict: { dispatch: true } },
      ],
    }),
    channels: { email: boom, sms: { name: 'ok-sms', kind: 'sms', send: async (e) => { sent.push(e); return { ok: true, channel: 'sms', messageId: 'm2', sentAt: new Date(T0).toISOString() }; } } },
    nowMs: T0,
  });
  assert.equal(receipts.find((r) => r.channel === 'email').ok, false);
  assert.equal(receipts.find((r) => r.channel === 'sms').ok, true);
  assert.equal(sent.length, 1);
});

test('dispatchAlert: unverified address is a loud { ok: false } receipt, not a send into the void', async () => {
  const sent = [];
  const email = { name: 'fake-email', kind: 'email', send: async (e) => { sent.push(e); return { ok: true, channel: 'email', messageId: 'm1', sentAt: new Date(T0).toISOString() }; } };
  const receipts = await dispatchAlert({
    alert: dropAlert({ recipient: { email: null, sms: null } }),
    channels: { email },
    nowMs: T0,
  });
  assert.equal(sent.length, 0);
  assert.match(receipts.find((r) => r.channel === 'email').error, /no recipient address/);
});

/* ------------------------------------------------------------------ *
 * End to end: scan pass -> dedupe -> dispatch exactly once, receipts in
 * the scan log, alert rows the rate ledger can count.
 * ------------------------------------------------------------------ */

function twoSourceData() {
  return {
    users: [
      { id: 'usr_1', email: 'a@example.com', handle: 'a', display_name: 'A', plan: 'free', phone: null, phone_verified: false, email_verified: true },
    ],
    profiles: [],
    follows: [],
    artists: [{ id: 'art_miles', name: 'Miles Davis', discogs_artist_id: 1, image_url: null, genres: [] }],
    releases: [],
    tracks: [],
    sources: [
      { id: 'src_a', user_id: 'usr_1', url: 'https://a.example/new', label: 'A', platform: 'shopify', scan_method: 'platform-api', scannable: true, scannable_reason: 'r', snapshot_hash: null, scan_interval_secs: 60, paused: false, last_scan_at: null, consecutive_failures: 0 },
      { id: 'src_b', user_id: 'usr_1', url: 'https://b.example/new', label: 'B', platform: 'shopify', scan_method: 'platform-api', scannable: true, scannable_reason: 'r', snapshot_hash: null, scan_interval_secs: 60, paused: false, last_scan_at: null, consecutive_failures: 0 },
    ],
    watches: [{ id: 'wtc_1', user_id: 'usr_1', artist_id: 'art_miles', watch_vinyl: true, merch_types: [], target_price_cents: null, channels: ['email'] }],
    alerts: [],
    crateItems: [],
    wantlistItems: [],
    pricePoints: [],
    activity: [],
  };
}

/** Baseline on the first scan per source, then a new drop appears — the
 * cross-source dedupe's job. */
function sameDropFetcher() {
  const baseline = [{ title: 'Kind of Blue — 180g Vinyl LP', vendor: 'Miles Davis', url: 'https://shop.example/lp/kob', image: { src: 'https://cdn/x.jpg' }, price: '$29.99' }];
  const withDrop = [...baseline, { title: 'Bitches Brew — 2xLP Reissue', vendor: 'Miles Davis', url: 'https://shop.example/lp/bb', image: { src: 'https://cdn/y.jpg' }, price: '$44.99' }];
  const calls = {};
  return async (source) => {
    calls[source.id] = (calls[source.id] ?? 0) + 1;
    return { status: 200, rawList: calls[source.id] === 1 ? baseline : withDrop };
  };
}

test('end to end: same drop on two sources dispatches exactly once, receipt lands in the scan log', async () => {
  const { server, received, url } = await startStubServer();
  try {
    const store = createStore(twoSourceData());

    // One fetcher instance across both passes: first scan per source
    // baselines, the second sees the new drop.
    const fetcher = sameDropFetcher();

    // Baseline pass: stores snapshots, never alerts.
    await runScanPass({ store, fetcher, nowMs: T0 });

    // Second pass: the drop is new relative to the baseline — one alert.
    const pass = await runScanPass({ store, fetcher, nowMs: T0 + 61_000 });
    assert.equal(pass.newAlerts, 1);

    const webhook = createWebhookChannel({ url });
    const result = await dispatchScanAlerts({ store, alerts: pass.alerts, channels: { email: webhook }, nowMs: T0 + 61_000 });

    assert.equal(result.dispatched, 1);
    assert.equal(received.length, 1, 'exactly one POST for the deduped alert');
    assert.equal(received[0].body.alert.artist_name, 'Miles Davis');
    assert.equal(received[0].body.to, 'a@example.com');

    const rows = store.alerts.all();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].dispatched_at);
    assert.deepEqual(rows[0].channels, ['email']);
    assert.equal(rows[0].dispatches.length, 1);
    assert.equal(rows[0].dispatches[0].ok, true);

    const dispatchLogs = store.scanLogs.all().filter((l) => l.outcome === 'dispatch');
    assert.equal(dispatchLogs.length, 1);
    assert.equal(dispatchLogs[0].delivered, 1);
    assert.equal(dispatchLogs[0].failures, 0);
    assert.equal(dispatchLogs[0].receipts[0].ok, true);
  } finally {
    server.close();
  }
});

test('end to end: rate-gated deliveries never reach a channel, but are recorded as skipped', async () => {
  const { server, received, url } = await startStubServer();
  try {
    const store = createStore(twoSourceData());
    const fetcher = sameDropFetcher();

    // Baseline pass: stores snapshots, never alerts.
    await runScanPass({ store, fetcher, nowMs: T0 });

    // Flood the user's email ledger past the hourly cap, so the worker's
    // rate gate folds the next drop into the digest instead of dispatching.
    for (let i = 0; i < 60; i += 1) {
      store.alerts.insert({
        id: `alr_seed_${i}`,
        user_id: 'usr_1',
        dispatched_at: new Date(T0 + i * 30_000).toISOString(),
        channels: ['email'],
        dispatches: [],
      });
    }

    const pass = await runScanPass({ store, fetcher, nowMs: T0 + 61_000 });
    assert.equal(pass.newAlerts, 1, 'the drop still becomes an alert item');
    assert.equal(pass.alerts[0].deliveries[0].verdict.dispatch, false, 'but the verdict holds it back');

    const webhook = createWebhookChannel({ url });
    const result = await dispatchScanAlerts({ store, alerts: pass.alerts, channels: { email: webhook }, nowMs: T0 + 61_000 });

    assert.equal(received.length, 0, 'no POST: the verdict held the delivery back');
    assert.equal(result.receipts.find((r) => r.channel === 'email').skipped, true);
    assert.match(result.receipts.find((r) => r.channel === 'email').reason, /rate cap/);
  } finally {
    server.close();
  }
});
