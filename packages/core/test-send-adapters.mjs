/**
 * Smoke/regression check for `packages/core/src/send-adapters.js` — the
 * config-flag send seam (ALERT-ENGINE-PLAN.md §3).
 *
 * Run: `node --test packages/core/test-send-adapters.mjs`
 * Zero dependencies beyond the Node standard library. Pins the adapter
 * contract the queue relies on:
 *
 * 1. Every adapter honours the dispatch channel contract
 *    (`{ name, kind, send }` — enforced by `assertChannel`).
 * 2. The disabled Resend/Twilio stubs NEVER attempt a send: every call
 *    returns `{ ok: false }` with a `NOT WIRED` reason naming the missing
 *    keys. No socket, no provider contact, no fake receipts.
 * 3. The console adapter records sends in-memory with `dev: true`
 *    receipts — the adapter tests use.
 * 4. `resolveSendAdapters` returns stubs for keyless config, console
 *    adapters in dev mode, and the real `dispatch.js` channels only when
 *    `enabled: true` AND keys are supplied.
 *
 * If any of them fail, the seam between the engine and the providers
 * changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEND_WIRING,
  createDisabledResendAdapter,
  createDisabledTwilioAdapter,
  createConsoleAdapter,
  resolveSendAdapters,
} from './src/send-adapters.js';
import { assertChannel } from './src/dispatch.js';

const envelope = (overrides = {}) => ({
  alert: { artist_name: 'MF DOOM', title: 'Operation: Doomsday' },
  channel: 'email',
  to: 'brando@example.com',
  message: { subject: 'Wax: drop', text: 'body' },
  nowMs: 1786275600000,
  ...overrides,
});

test('every adapter honours the dispatch channel contract', () => {
  for (const adapter of [
    createDisabledResendAdapter(),
    createDisabledTwilioAdapter(),
    createConsoleAdapter(),
  ]) {
    assertChannel(adapter); // throws when the contract breaks
    assert.equal(typeof adapter.send, 'function');
  }
});

test('disabled resend stub never sends — NOT WIRED receipt every time', async () => {
  const adapter = createDisabledResendAdapter();
  assert.equal(adapter.name, 'resend');
  assert.equal(adapter.kind, 'email');
  assert.equal(adapter.wired, false);

  const receipt = await adapter.send(envelope());
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /NOT WIRED/);
  assert.match(receipt.error, /RESEND_API_KEY/);
  assert.match(receipt.error, /no socket was opened/);
  assert.equal(receipt.sentAt, new Date(1786275600000).toISOString());
});

test('disabled twilio stub never sends — NOT WIRED receipt every time', async () => {
  const adapter = createDisabledTwilioAdapter();
  assert.equal(adapter.name, 'twilio');
  assert.equal(adapter.kind, 'sms');
  assert.equal(adapter.wired, false);

  const receipt = await adapter.send(envelope({ channel: 'sms', to: '+15551234567' }));
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /NOT WIRED/);
  assert.match(receipt.error, /TWILIO_ACCOUNT_SID/);
  assert.match(receipt.error, /no socket was opened/);
});

test('console adapter records sends in-memory, receipts are dev-marked', async () => {
  const sink = [];
  const adapter = createConsoleAdapter({ sink });
  const receipt = await adapter.send(envelope());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.dev, true);
  assert.match(receipt.messageId, /^console_/);
  assert.equal(sink.length, 1);
  assert.equal(sink[0].to, 'brando@example.com');
  assert.equal(sink[0].message.subject, 'Wax: drop');
  assert.equal(sink[0].dev, true);
});

test('console adapter rejects a non-array sink', () => {
  assert.throws(() => createConsoleAdapter({ sink: 'nope' }), TypeError);
});

test('SEND_WIRING declares both providers unwired', () => {
  assert.equal(SEND_WIRING.resend.enabled, false);
  assert.equal(SEND_WIRING.twilio.enabled, false);
  assert.match(SEND_WIRING.resend.status, /NOT WIRED/);
  assert.match(SEND_WIRING.twilio.status, /NOT WIRED/);
  assert.ok(Object.isFrozen(SEND_WIRING));
});

test('resolveSendAdapters: keyless config resolves to disabled stubs', () => {
  const { email, sms } = resolveSendAdapters({});
  assert.equal(email.name, 'resend');
  assert.equal(email.wired, false);
  assert.equal(sms.name, 'twilio');
  assert.equal(sms.wired, false);
});

test('resolveSendAdapters: enabled without keys still resolves to stubs (no half-wired)', () => {
  const { email, sms } = resolveSendAdapters({ email: { enabled: true }, sms: { enabled: true, from: '+15551234567' } });
  assert.equal(email.wired, false);
  assert.equal(sms.wired, false);
});

test('resolveSendAdapters: dev mode resolves console adapters', () => {
  const { email, sms } = resolveSendAdapters({ dev: true });
  assert.equal(email.name, 'console-email');
  assert.equal(email.kind, 'email');
  assert.equal(sms.name, 'console-sms');
  assert.equal(sms.kind, 'sms');
  assert.ok(Array.isArray(email.sink) && Array.isArray(sms.sink));
});

test('resolveSendAdapters: enabled WITH keys returns the real dispatch channels', () => {
  const { email, sms } = resolveSendAdapters({
    email: { enabled: true, apiKey: 'test-key-not-real', from: 'alerts@example.com' },
    sms: { enabled: true, accountSid: 'ACx', authToken: 'tok', from: '+15551234567' },
  });
  assert.equal(email.name, 'resend');
  assert.equal(email.wired, undefined); // real channel: no stub flag, real send path
  assert.equal(sms.name, 'twilio');
  // disabled-vs-real is structural: the real adapter has no `wired: false` marker
  assert.equal('wired' in email, false);
  assert.equal('wired' in sms, false);
});
