/**
 * Smoke/regression check for `packages/core/src/billing-receipt.js`.
 *
 * Run: `node --test packages/core/test-billing-receipt.mjs`
 * No dependencies beyond the Node standard library. The renderer is pure;
 * the sender runs against an in-memory fake channel, so no socket is ever
 * opened and no keys are needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  formatMoney,
  renderReceiptEmail,
  sendBillingReceipt,
  SERIES_PRICE_CENTS,
} from './src/index.js';

const USER = { email: 'buyer@example.com', display_name: 'Brando B' };

function testSession(overrides = {}) {
  return {
    id: 'testcs_abc123',
    mode: 'test',
    amount_cents: SERIES_PRICE_CENTS,
    currency: 'usd',
    plan: 'series',
    user_id: 'usr_free',
    ...overrides,
  };
}

/** In-memory fake email channel honouring the dispatch contract. */
function fakeEmailChannel(receipt = { ok: true, messageId: 're_fake_1' }) {
  return {
    name: 'fake-email',
    kind: 'email',
    sent: [],
    async send(envelope) {
      this.sent.push(envelope);
      return { ...receipt, channel: 'fake-email', sentAt: new Date(envelope?.nowMs ?? 0).toISOString() };
    },
  };
}

test('the renderer states the money sentence: $10/month series', () => {
  const r = renderReceiptEmail(USER, testSession({ mode: 'live' }));
  assert.match(r.subject, /Subscription Series/);
  assert.match(r.subject, /\$10\.00/);
  assert.match(r.text, /\$10\.00 USD, billed monthly/);
  assert.match(r.text, /Receipt ID: testcs_abc123/);
  assert.match(r.text, /cancel anytime/i);
  assert.match(r.html, /<strong>Amount:<\/strong> \$10\.00 USD, billed monthly/);
});

test('test-mode receipts say plainly that no money moved', () => {
  const r = renderReceiptEmail(USER, testSession({ mode: 'test' }));
  assert.match(r.subject, /test, no charge/i);
  assert.match(r.text, /TEST receipt — no card was charged/i);
  assert.match(r.html, /TEST receipt — no card was charged/);
  const live = renderReceiptEmail(USER, testSession({ mode: 'live' }));
  assert.doesNotMatch(live.text, /TEST receipt/i);
  assert.doesNotMatch(live.html, /TEST receipt/i);
});

test('the receipt shows the session amount, not the catalog, when they differ', () => {
  const r = renderReceiptEmail(USER, testSession({ amount_cents: 899, currency: 'eur' }));
  assert.match(r.subject, /\$8\.99/);
  assert.match(r.text, /\$8\.99 EUR, billed monthly/);
  assert.match(r.html, /\$8\.99/);
});

test('user strings are escaped in HTML — no script injection via a display name', () => {
  const evil = { email: 'x@example.com', display_name: '<img src=x onerror=alert(1)>' };
  const r = renderReceiptEmail(evil, testSession({ id: 'cs_<bad>' }));
  assert.doesNotMatch(r.html, /<img src=x/);
  assert.match(r.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(r.html, /Receipt ID:<\/strong> cs_&lt;bad&gt;/);
  assert.equal(escapeHtml('a&b<"c\'>d'), 'a&amp;b&lt;&quot;c&#39;&gt;d');
});

test('send delivers the envelope to the user email through the channel', async () => {
  const channel = fakeEmailChannel();
  const receipt = await sendBillingReceipt({ user: USER, session: testSession(), emailChannel: channel, nowMs: 1_700_000_000_000 });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.channel, 'fake-email');
  assert.equal(channel.sent.length, 1);
  const env = channel.sent[0];
  assert.equal(env.to, 'buyer@example.com');
  assert.match(env.message.subject, /Subscription Series/);
  assert.match(env.message.text, /\$10\.00 USD/);
  assert.equal(env.alert, null);
});

test('send passes the channel through: ok:false receipts return, never throw', async () => {
  const channel = fakeEmailChannel({ ok: false, error: 'NOT WIRED' });
  const receipt = await sendBillingReceipt({ user: USER, session: testSession(), emailChannel: channel });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /NOT WIRED/);
  assert.equal(channel.sent.length, 1);
});

test('send with no email on the user row refuses loudly and never touches the channel', async () => {
  const channel = fakeEmailChannel();
  const receipt = await sendBillingReceipt({ user: { display_name: 'No Email' }, session: testSession(), emailChannel: channel });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, 'no_email_on_file');
  assert.equal(channel.sent.length, 0);
});

test('send rejects a malformed channel at call time — loud, not a silent drop', async () => {
  await assert.rejects(
    sendBillingReceipt({ user: USER, session: testSession(), emailChannel: { name: 'broken' } }),
    TypeError,
  );
});

test('send treats a garbage channel return as a failed send', async () => {
  const receipt = await sendBillingReceipt({
    user: USER,
    session: testSession(),
    emailChannel: { name: 'junk', kind: 'email', send: async () => 'nope' },
  });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /malformed receipt/);
});

test('formatMoney renders cents as dollars', () => {
  assert.equal(formatMoney(1000), '$10.00');
  assert.equal(formatMoney(899), '$8.99');
  assert.equal(formatMoney(0), '$0.00');
});
