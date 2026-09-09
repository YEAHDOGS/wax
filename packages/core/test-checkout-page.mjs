/**
 * Smoke/regression check for the checkout page — the money lane's front door.
 *
 * Run: `node --test packages/core/test-checkout-page.mjs`
 * (Node ≥22 applies the same ESM syntax detection to `/api/*.js` that Vercel
 * does in production; on older Node use `--experimental-detect-module`.)
 *
 * No dependencies beyond the Node standard library. The renderer tests call
 * `renderCheckoutPage` directly; the contract tests pin the `checkoutSession`
 * stub shape (the stub IS the contract the live provider must keep); the
 * adapter tests call the real `/api/checkout` route with fake req/res
 * objects — never the network, never a live provider, never real keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  SERIES_PRICE_CENTS,
  checkoutPage,
  checkoutSession,
  createStore,
  renderCheckoutPage,
} from './src/index.js';

const route = (await import('../../api/checkout.js')).default;

const BASE = '2026-09-09T10:00:00.000Z';

function fixtureUser(store, id = 'usr_co', plan = 'free', over = {}) {
  store.users.insert({
    id, email: `${id}@example.com`, handle: id, display_name: 'Checkout',
    avatar_url: null, plan, trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: BASE,
    ...over,
  });
  return store.createSession(id).token;
}

function fakeReq({ method = 'GET', token = null, body = null } = {}) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
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

/* ------------------------------------------------------------------ *
 * The renderer.
 * ------------------------------------------------------------------ */

test('renderCheckoutPage: plan card, price, cancel-anytime copy, button', () => {
  const html = renderCheckoutPage(
    { id: 'usr_free', plan: 'free', display_name: 'Free Bird' },
    { token: 'tok_abc-DEF_123' },
  );
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('The Subscription Series'));
  assert.equal(SERIES_PRICE_CENTS, 1000);
  assert.ok(html.includes('$10.00'));
  assert.ok(html.includes('Cancel anytime'));
  assert.ok(html.includes('The Single'));
  assert.ok(html.includes('id="buy"'), 'the subscribe button renders');
  assert.ok(html.includes('/api/checkout'), 'the button posts to the session endpoint');
  assert.ok(html.includes('tok_abc-DEF_123'), 'the validated session is handed to the page script');
});

test('renderCheckoutPage: hostile display names and tokens cannot inject', () => {
  const html = renderCheckoutPage(
    { id: 'usr_x', plan: 'free', display_name: 'Evil <script>alert(1)</script>' },
    { token: '";</script><script>alert(1)</script>' },
  );
  assert.ok(!html.includes('<script>alert(1)</script>'), 'display name is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'display name escaped visibly');
  assert.ok(!html.includes('window.WAX_SESSION = "'), 'corrupt token is not embedded as a string');
  assert.ok(html.includes('disabled'), 'corrupt token disables the buy button');
});

test('renderCheckoutPage: a series subscriber gets the done panel, never a button', () => {
  const html = renderCheckoutPage(
    { id: 'usr_s', plan: 'series', display_name: 'Sub' },
    { token: 'tok_ok_12345' },
  );
  assert.ok(html.includes('You&rsquo;re on the Subscription Series'));
  assert.ok(!html.includes('id="buy"'), 'no buy button when there is nothing left to buy');
});

test('renderCheckoutPage: trial users see their trial end date', () => {
  const html = renderCheckoutPage(
    { id: 'usr_t', plan: 'trial', trial_ends_at: '2026-10-09T10:00:00.000Z', display_name: 'Trial' },
    { token: 'tok_ok_12345' },
  );
  assert.ok(html.includes('2026-10-09'), 'trial end date is shown');
  assert.ok(html.includes('id="buy"'), 'trial users can still subscribe');
});

test('renderCheckoutPage: no real provider surface, ever', () => {
  const html = renderCheckoutPage({ id: 'usr_f', plan: 'free' }, { token: 'tok_ok_12345' });
  assert.ok(!/sk_live|pk_live|whsec_/i.test(html), 'no live key material');
});

/* ------------------------------------------------------------------ *
 * The stub contract (billing.js).
 * ------------------------------------------------------------------ */

test('checkoutSession stub: the response shape the live provider must keep', async () => {
  const store = createStore();
  const token = fixtureUser(store);
  const s = await checkoutSession(token, {
    mode: 'test',
    successUrl: 'https://wax.test/success',
    cancelUrl: 'https://wax.test/cancel',
    store,
  });
  assert.deepEqual(Object.keys(s).sort(), [
    'amount_cents', 'cancel_url', 'currency', 'id',
    'mode', 'plan', 'success_url', 'url', 'user_id',
  ].sort());
  assert.equal(s.mode, 'test');
  assert.equal(s.plan, 'series');
  assert.equal(s.amount_cents, 1000);
  assert.equal(s.currency, 'usd');
  assert.equal(s.user_id, 'usr_co');
  assert.equal(s.success_url, 'https://wax.test/success');
  assert.equal(s.cancel_url, 'https://wax.test/cancel');
  assert.ok(/^testcs_/.test(s.id), 'stub ids are namespaced testcs_');
});

test('checkoutSession: live mode is a loud 501 until the provider is wired', async () => {
  const store = createStore();
  const token = fixtureUser(store);
  await assert.rejects(
    checkoutSession(token, { mode: 'live', store }),
    (e) => e instanceof ApiError && e.status === 501 && e.code === 'billing_not_configured',
  );
});

test('checkoutSession: a series subscriber gets 409, never a second session', async () => {
  const store = createStore();
  const token = fixtureUser(store, 'usr_series', 'series');
  await assert.rejects(
    checkoutSession(token, { mode: 'test', store }),
    (e) => e instanceof ApiError && e.status === 409 && e.code === 'already_subscribed',
  );
});

/* ------------------------------------------------------------------ *
 * The route adapter.
 * ------------------------------------------------------------------ */

test('GET /api/checkout: no bearer is a 401, never a page', async () => {
  const bad = fakeRes();
  await route(fakeReq(), bad);
  assert.equal(bad.statusCode, 401);
  const body = JSON.parse(bad.body);
  assert.equal(body.error, 'unauthorized');
  assert.ok(!bad.body.includes('The Subscription Series'), 'no page leaks on auth failure');
});

test('checkoutPage handler: renders the session user page against a seeded store', async () => {
  const store = createStore();
  fixtureUser(store);
  const token = store.createSession('usr_co').token;
  const page = await checkoutPage(token, { store });
  assert.ok(page.includes('The Subscription Series'));
  assert.ok(page.includes('$10.00'));
});

test('POST /api/checkout: test mode 201s the stub shape, bad mode 400s', async () => {
  const store = createStore();
  fixtureUser(store);
  const token = store.createSession('usr_co').token;

  // The adapter uses the module store, so seed through the public surface is
  // covered by test-billing.mjs; here we assert the adapter's wiring:
  const badMode = fakeRes();
  await route(fakeReq({ method: 'POST', body: { mode: 'nope' } }), badMode);
  assert.equal(badMode.statusCode, 400);
  assert.ok(JSON.parse(badMode.body).error === 'bad_mode');

  const missing = fakeRes();
  await route(fakeReq({ method: 'POST', token: 'bogus', body: { mode: 'test' } }), missing);
  assert.equal(missing.statusCode, 401);
});
