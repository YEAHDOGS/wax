/**
 * Regression checks for the alert-subscription routes —
 * `POST /api/alerts/subscribe`, `GET /api/alerts/confirm?token=`,
 * `POST /api/alerts/unsubscribe` (ALERT-ENGINE-PLAN.md §3 NEXT).
 *
 * Run: `node --test packages/core/test-subscription-routes.mjs`
 * (Node ≥22 applies the same ESM syntax detection to `/api/*.js` that Vercel
 * does in production; on older Node use `--experimental-detect-module`.)
 *
 * No dependencies beyond the Node standard library. The adapter tests call
 * the real route handlers with fake req/res objects — never the network,
 * never a live provider. Delivery is a stub channel injected into the core
 * handlers; the "no keys" path is the real adapter with no env credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  confirmAlertSubscription,
  createStore,
  subscribeAlertChannel,
  unsubscribeAlertChannel,
} from './src/index.js';

const subscribeRoute = (await import('../../api/alerts/subscribe.js')).default;
const confirmRoute = (await import('../../api/alerts/confirm.js')).default;
const unsubscribeRoute = (await import('../../api/alerts/unsubscribe.js')).default;

function freshStore() {
  return createStore({ users: [], profiles: [], follows: [], artists: [], releases: [], tracks: [], watches: [], alerts: [], crateItems: [], wantlistItems: [], pricePoints: [], activity: [] });
}

function fakeReq({ method = 'POST', query = {}, body = undefined } = {}) {
  const req = { method, headers: {}, query };
  if (body !== undefined) req.body = body;
  return req;
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: null,
    headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    body: null,
    end(body) { this.body = body; },
  };
}

async function call(route, req) {
  const res = fakeRes();
  await route(req, res);
  return { status: res.statusCode, body: res.body == null ? null : JSON.parse(res.body) };
}

/** A delivery channel that records sends and reports success. */
function stubChannel(name = 'stub', calls = []) {
  return {
    name,
    kind: 'email',
    send: async (envelope) => {
      calls.push(envelope);
      return { ok: true, channel: name, messageId: 'msg_1', sentAt: new Date().toISOString() };
    },
  };
}

/** A delivery channel whose send throws — dispatch must never throw back. */
const throwingChannel = {
  name: 'boom',
  kind: 'email',
  send: async () => { throw new Error('provider exploded'); },
};

async function assertThrowsApi(fn, status, code) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ApiError ${status}/${code}, nothing thrown`);
}

/* ------------------------------------------------------------------ *
 * subscribe
 * ------------------------------------------------------------------ */

test('subscribe: valid email creates a pending subscription and sends the confirmation', async () => {
  const store = freshStore();
  const calls = [];
  const { subscription, delivered } = await subscribeAlertChannel(
    { email: 'collector@example.com', channel: 'email', filter: { artist_id: 'art_1', max_price_cents: 4000 } },
    { store, channel: stubChannel('stub', calls) },
  );
  assert.equal(subscription.state, 'pending');
  assert.equal(subscription.duplicate, false);
  assert.equal(subscription.recipient, undefined); // public view carries email/phone, not the internal field
  assert.equal(subscription.email, 'collector@example.com');
  assert.deepEqual(subscription.filter, { artist_id: 'art_1', max_price_cents: 4000 });
  assert.equal(delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'collector@example.com');
  assert.match(calls[0].message.text, /Confirm:/);
  const row = store.subscriptions.find((s) => s.id === subscription.id);
  assert.equal(row.confirm_receipt.ok, true);
  assert.equal(row.confirm_receipt.channel, 'stub');
});

test('subscribe: email is normalized (trimmed, lowercased)', async () => {
  const store = freshStore();
  const { subscription } = await subscribeAlertChannel(
    { email: '  Fan@Example.COM ', channel: 'email' },
    { store, channel: stubChannel() },
  );
  assert.equal(subscription.email, 'fan@example.com');
});

test('subscribe: invalid email is rejected', async () => {
  const store = freshStore();
  await assertThrowsApi(
    () => subscribeAlertChannel({ email: 'not-an-email', channel: 'email' }, { store }),
    400, 'invalid_email',
  );
});

test('subscribe: email channel requires an email', async () => {
  const store = freshStore();
  await assertThrowsApi(
    () => subscribeAlertChannel({ phone: '+13125550123', channel: 'email' }, { store }),
    400, 'missing_email',
  );
});

test('subscribe: sms requires a valid E.164 phone', async () => {
  const store = freshStore();
  await assertThrowsApi(
    () => subscribeAlertChannel({ phone: '555-0123', channel: 'sms' }, { store }),
    400, 'invalid_phone',
  );
  const { subscription } = await subscribeAlertChannel(
    { phone: '+13125550123', channel: 'sms' },
    { store, channel: stubChannel() },
  );
  assert.equal(subscription.phone, '+13125550123');
  assert.equal(subscription.state, 'pending');
});

test('subscribe: unknown top-level fields are rejected', async () => {
  const store = freshStore();
  await assertThrowsApi(
    () => subscribeAlertChannel({ email: 'a@example.com', channel: 'email', notify_me: true }, { store }),
    400, 'unknown_field',
  );
});

test('subscribe: unknown filter fields are rejected', async () => {
  const store = freshStore();
  await assertThrowsApi(
    () => subscribeAlertChannel({ email: 'a@example.com', channel: 'email', filter: { color: 'red' } }, { store }),
    400, 'unknown_field',
  );
  await assertThrowsApi(
    () => subscribeAlertChannel({ email: 'a@example.com', channel: 'email', filter: { max_price_cents: -5 } }, { store }),
    400, 'bad_filter',
  );
});

test('subscribe: same address + filter twice is idempotent — one row, no second send', async () => {
  const store = freshStore();
  const calls = [];
  const channel = stubChannel('stub', calls);
  const input = { email: 'twice@example.com', channel: 'email', filter: { title_contains: 'blue' } };
  const first = await subscribeAlertChannel(input, { store, channel });
  const second = await subscribeAlertChannel(input, { store, channel });
  assert.equal(second.subscription.id, first.subscription.id);
  assert.equal(second.subscription.duplicate, true);
  assert.equal(store.subscriptions.count(), 1);
  assert.equal(calls.length, 1);
});

test('subscribe: different filters are different subscriptions', async () => {
  const store = freshStore();
  const channel = stubChannel();
  await subscribeAlertChannel({ email: 'x@example.com', channel: 'email', filter: { artist_id: 'a' } }, { store, channel });
  await subscribeAlertChannel({ email: 'x@example.com', channel: 'email', filter: { artist_id: 'b' } }, { store, channel });
  assert.equal(store.subscriptions.count(), 2);
});

test('subscribe: a throwing channel never throws — the failure is a receipt', async () => {
  const store = freshStore();
  const { subscription, delivered } = await subscribeAlertChannel(
    { email: 'unlucky@example.com', channel: 'email' },
    { store, channel: throwingChannel },
  );
  assert.equal(subscription.state, 'pending');
  assert.equal(delivered, false);
  const row = store.subscriptions.find((s) => s.id === subscription.id);
  assert.equal(row.confirm_receipt.ok, false);
  assert.match(row.confirm_receipt.error, /provider exploded/);
});

test('subscribe: no channel logs a keys-pending receipt and the flow still completes', async () => {
  const store = freshStore();
  const { subscription, delivered } = await subscribeAlertChannel(
    { email: 'nokeys@example.com', channel: 'email' },
    { store },
  );
  assert.equal(subscription.state, 'pending');
  assert.equal(delivered, false);
  const row = store.subscriptions.find((s) => s.id === subscription.id);
  assert.equal(row.confirm_receipt.ok, false);
  assert.match(row.confirm_receipt.error, /provider keys pending/);
});

/* ------------------------------------------------------------------ *
 * confirm
 * ------------------------------------------------------------------ */

test('confirm: valid token activates the subscription', async () => {
  const store = freshStore();
  const { confirm_token } = await subscribeAlertChannel(
    { email: 'confirm@example.com', channel: 'email' },
    { store, channel: stubChannel() },
  );
  const sub = await confirmAlertSubscription(confirm_token, { store });
  assert.equal(sub.state, 'active');
  assert.ok(sub.confirmed_at);
});

test('confirm: bad token is a 404', async () => {
  const store = freshStore();
  await assertThrowsApi(async () => await confirmAlertSubscription('nope', { store }), 404, 'bad_token');
  await assertThrowsApi(async () => await confirmAlertSubscription(null, { store }), 404, 'bad_token');
});

test('confirm: re-clicking the link on an active subscription is idempotent', async () => {
  const store = freshStore();
  const { confirm_token } = await subscribeAlertChannel(
    { email: 'again@example.com', channel: 'email' },
    { store, channel: stubChannel() },
  );
  const first = await confirmAlertSubscription(confirm_token, { store });
  const second = await confirmAlertSubscription(confirm_token, { store });
  assert.equal(second.state, 'active');
  assert.equal(second.id, first.id);
});

test('confirm: a cancelled subscription is gone, not re-confirmable', async () => {
  const store = freshStore();
  const { confirm_token } = await subscribeAlertChannel(
    { email: 'cancelled@example.com', channel: 'email' },
    { store, channel: stubChannel() },
  );
  await unsubscribeAlertChannel({ token: confirm_token }, { store });
  await assertThrowsApi(async () => await confirmAlertSubscription(confirm_token, { store }), 410, 'gone');
});

/* ------------------------------------------------------------------ *
 * unsubscribe
 * ------------------------------------------------------------------ */

test('unsubscribe: token cancels the subscription', async () => {
  const store = freshStore();
  const { confirm_token, subscription } = await subscribeAlertChannel(
    { email: 'bye@example.com', channel: 'email' },
    { store, channel: stubChannel() },
  );
  await confirmAlertSubscription(confirm_token, { store });
  const out = await unsubscribeAlertChannel({ token: confirm_token }, { store });
  assert.deepEqual(out, { ok: true, unsubscribed: 1 });
  const row = store.subscriptions.find((s) => s.id === subscription.id);
  assert.equal(row.state, 'unsubscribed');
  assert.ok(row.unsubscribed_at);
});

test('unsubscribe: email + filter cancels without a token', async () => {
  const store = freshStore();
  const filter = { artist_id: 'art_9' };
  const { confirm_token } = await subscribeAlertChannel(
    { email: 'nofilter@example.com', channel: 'email', filter },
    { store, channel: stubChannel() },
  );
  await confirmAlertSubscription(confirm_token, { store });
  const out = await unsubscribeAlertChannel({ email: 'nofilter@example.com', filter }, { store });
  assert.deepEqual(out, { ok: true, unsubscribed: 1 });
});

test('unsubscribe: no match is a 404', async () => {
  const store = freshStore();
  await assertThrowsApi(
    async () => await unsubscribeAlertChannel({ email: 'ghost@example.com' }, { store }),
    404, 'not_found',
  );
  await assertThrowsApi(
    async () => await unsubscribeAlertChannel({ token: 'ghost' }, { store }),
    404, 'not_found',
  );
});

test('unsubscribe: re-subscribing after cancel starts a fresh pending subscription', async () => {
  const store = freshStore();
  const channel = stubChannel();
  const input = { email: 'back@example.com', channel: 'email' };
  const { confirm_token } = await subscribeAlertChannel(input, { store, channel });
  await confirmAlertSubscription(confirm_token, { store });
  await unsubscribeAlertChannel({ token: confirm_token }, { store });
  const again = await subscribeAlertChannel(input, { store, channel });
  assert.equal(again.subscription.duplicate, false);
  assert.equal(again.subscription.state, 'pending');
  assert.equal(store.subscriptions.count(), 2);
  assert.equal(store.subscriptions.filter((s) => s.state === 'unsubscribed').length, 1);
});

test('unsubscribe: unknown fields are rejected', async () => {
  const store = freshStore();
  await assertThrowsApi(
    async () => await unsubscribeAlertChannel({ email: 'a@example.com', reason: 'bored' }, { store }),
    400, 'unknown_field',
  );
});

/* ------------------------------------------------------------------ *
 * HTTP adapters
 * ------------------------------------------------------------------ */

test('adapter: POST /api/alerts/subscribe returns the subscription (dev path shows the token)', async () => {
  // No provider credentials in this environment, so the adapter takes the
  // no-channel path: subscription created, receipt logged, token shown so
  // the flow can be exercised without live sends.
  const { status, body } = await call(subscribeRoute, fakeReq({
    body: { email: 'http@example.com', channel: 'email', filter: { artist_id: 'art_1' } },
  }));
  assert.equal(status, 200);
  assert.equal(body.state, 'pending');
  assert.equal(body.duplicate, false);
  assert.ok(body.confirm_token);
  assert.ok(!('confirm_receipt' in body));
});

test('adapter: POST /api/alerts/subscribe validates input', async () => {
  const { status, body } = await call(subscribeRoute, fakeReq({
    body: { email: 'bad', channel: 'email' },
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_email');
});

test('adapter: GET /api/alerts/confirm activates with the token from subscribe', async () => {
  const created = await call(subscribeRoute, fakeReq({
    body: { email: 'flow@example.com', channel: 'email' },
  }));
  const { status, body } = await call(confirmRoute, fakeReq({
    method: 'GET',
    query: { token: created.body.confirm_token },
  }));
  assert.equal(status, 200);
  assert.equal(body.state, 'active');
});

test('adapter: GET /api/alerts/confirm with a bad token is a 404', async () => {
  const { status, body } = await call(confirmRoute, fakeReq({ method: 'GET', query: { token: 'nope' } }));
  assert.equal(status, 404);
  assert.equal(body.error, 'bad_token');
});

test('adapter: POST /api/alerts/unsubscribe by token cancels', async () => {
  const created = await call(subscribeRoute, fakeReq({
    body: { email: 'leave@example.com', channel: 'email' },
  }));
  const { status, body } = await call(unsubscribeRoute, fakeReq({
    body: { token: created.body.confirm_token },
  }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, unsubscribed: 1 });
});

test('adapter: wrong methods get a 405 naming the allowed ones', async () => {
  const get = await call(subscribeRoute, fakeReq({ method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal(get.body.error, 'method_not_allowed');
  const post = await call(confirmRoute, fakeReq({ method: 'POST', body: {} }));
  assert.equal(post.status, 405);
});

test('adapter: POST /api/alerts/unsubscribe honors ?token= with an empty body (RFC 8058 one-click)', async () => {
  const created = await call(subscribeRoute, fakeReq({
    body: { email: 'oneclick@example.com', channel: 'email' },
  }));
  const token = created.body.confirm_token;
  // Real one-click POSTs from email clients carry no body — Vercel hands the
  // route an empty object; the token rides the URL.
  const { status, body } = await call(unsubscribeRoute, fakeReq({
    query: { token },
    body: {},
  }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, unsubscribed: 1 });
});

test('adapter: ?token= with a garbage token is still a 404, not a 200', async () => {
  const { status, body } = await call(unsubscribeRoute, fakeReq({
    query: { token: 'tok_nonexistent' },
    body: {},
  }));
  assert.equal(status, 404);
  assert.equal(body.error, 'not_found');
});

test('adapter: body token wins over ?token= when both are present', async () => {
  const created = await call(subscribeRoute, fakeReq({
    body: { email: 'bodywins@example.com', channel: 'email' },
  }));
  const { status, body } = await call(unsubscribeRoute, fakeReq({
    query: { token: 'tok_nonexistent' },
    body: { token: created.body.confirm_token },
  }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, unsubscribed: 1 });
});
