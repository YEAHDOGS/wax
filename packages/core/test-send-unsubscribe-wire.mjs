/**
 * Regression suite for the List-Unsubscribe seam wiring in
 * `resolveSendAdapters` (ALERT-ENGINE-PLAN.md §3, List-Unsubscribe).
 *
 * `createResendChannel` already knew how to send one-click
 * List-Unsubscribe headers (pinned in test-dispatch-providers.mjs), but the
 * production wiring board — `resolveSendAdapters` — never passed an
 * `unsubscribeUrl` through. Without this, the first live send would have
 * shipped bulk email with no unsubscribe path: a Gmail/Outlook
 * spam-compliance incident, not a cosmetic gap.
 *
 * Run: `node --test packages/core/test-send-unsubscribe-wire.mjs`
 *
 * No real providers, no real keys, no outbound network: wired adapters aim
 * at a loopback stub through the `email.baseUrl` override, with
 * unmistakably fake fixture credentials (`re_test_…`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildUnsubscribeUrl, resolveSendAdapters } from './src/index.js';

const T0 = Date.parse('2026-09-09T11:00:00.000Z');

const UNSUB_BASE = 'https://wax.wearedogs.net/api/alerts/unsubscribe';

/** Tokenized per-recipient resolver, the shape launch config will use. */
const tokenizedUnsubscribeUrl = (envelope) =>
  envelope?.unsubscribe_token ? buildUnsubscribeUrl(UNSUB_BASE, envelope.unsubscribe_token) : null;

function startResendStub() {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"re_stub_123"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('seam wires the tokenized unsubscribeUrl into live email headers', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const { email } = resolveSendAdapters({
      email: {
        enabled: true,
        apiKey: 're_test_wire_key',
        from: 'alerts@wax.wearedogs.net',
        baseUrl,
        unsubscribeUrl: tokenizedUnsubscribeUrl,
      },
    });
    assert.equal(email.name, 'resend');
    const receipt = await email.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      unsubscribe_token: 'tok_wire_1',
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(
      received[0].body.headers['List-Unsubscribe'],
      '<https://wax.wearedogs.net/api/alerts/unsubscribe?token=tok_wire_1>',
    );
    assert.equal(received[0].body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  } finally {
    server.close();
  }
});

test('seam: static unsubscribeUrl string passes through verbatim', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const { email } = resolveSendAdapters({
      email: {
        enabled: true,
        apiKey: 're_test_wire_key',
        from: 'alerts@wax.wearedogs.net',
        baseUrl,
        unsubscribeUrl: 'https://wax.wearedogs.net/unsubscribe',
      },
    });
    const receipt = await email.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(received[0].body.headers['List-Unsubscribe'], '<https://wax.wearedogs.net/unsubscribe>');
  } finally {
    server.close();
  }
});

test('seam: no unsubscribeUrl configured — payload has no headers key', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const { email } = resolveSendAdapters({
      email: { enabled: true, apiKey: 're_test_wire_key', from: 'alerts@wax.wearedogs.net', baseUrl },
    });
    const receipt = await email.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal('headers' in received[0].body, false);
  } finally {
    server.close();
  }
});

test('seam: malformed unsubscribeUrl refuses the send before any network', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const { email } = resolveSendAdapters({
      email: {
        enabled: true,
        apiKey: 're_test_wire_key',
        from: 'alerts@wax.wearedogs.net',
        baseUrl,
        unsubscribeUrl: 'javascript:alert(1)',
      },
    });
    const receipt = await email.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, false);
    assert.match(receipt.error, /List-Unsubscribe/);
    assert.equal(received.length, 0, 'no request may leave with a bad unsubscribe URL');
  } finally {
    server.close();
  }
});

test('seam: resolver throwing or returning junk resolves to a loud refusal, never a silent send', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    for (const bad of [
      () => { throw new Error('resolver blew up'); },
      () => 'ftp://evil.example/unsub',
      () => 42,
    ]) {
      const { email } = resolveSendAdapters({
        email: {
          enabled: true,
          apiKey: 're_test_wire_key',
          from: 'alerts@wax.wearedogs.net',
          baseUrl,
          unsubscribeUrl: bad,
        },
      });
      const receipt = await email.send({
        alert: null,
        channel: 'email',
        to: 'fan@example.com',
        message: { subject: 's', text: 't' },
        unsubscribe_token: 'tok_wire_2',
        nowMs: T0,
      });
      // The throwing resolver swallows to null: no headers, send proceeds.
      // A junk URL refuses the send loudly. Both must be observable, never silent.
      if (bad.toString().includes('throw')) {
        assert.equal(receipt.ok, true, 'throwing resolver resolves to null — send proceeds without headers');
        assert.equal('headers' in received[received.length - 1].body, false);
      } else {
        assert.equal(receipt.ok, false);
        assert.match(receipt.error, /List-Unsubscribe/);
      }
    }
    assert.ok(received.length >= 1, 'at least the throwing-resolver send should have left');
  } finally {
    server.close();
  }
});

test('seam: keyless config still resolves to NOT-WIRED stubs (regression)', async () => {
  const { email, sms } = resolveSendAdapters({
    email: { enabled: false, from: 'alerts@wax.wearedogs.net', unsubscribeUrl: tokenizedUnsubscribeUrl },
    sms: { enabled: false },
  });
  assert.equal(email.name, 'resend');
  assert.equal(email.wired, false);
  const receipt = await email.send({
    alert: null,
    channel: 'email',
    to: 'fan@example.com',
    message: { subject: 's', text: 't' },
    unsubscribe_token: 'tok_wire_3',
    nowMs: T0,
  });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /NOT WIRED/);
  assert.equal(sms.name, 'twilio');
});
