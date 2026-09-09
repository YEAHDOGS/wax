/**
 * Regression suite for the Resend + Twilio provider adapters in
 * `packages/core/src/dispatch.js` (ALERT-ENGINE-PLAN.md §3, plan step
 * "Alert delivery (Resend, then Twilio)").
 *
 * Run: `node --test packages/core/test-dispatch-providers.mjs`
 *
 * No real providers, no real keys, no outbound network: both adapters
 * accept a `baseUrl` that aims them at loopback stub servers standing in
 * for the Resend and Twilio APIs. The fixture credentials are
 * unmistakably fake (`re_test_…`, `AC_test_…`) and are never written
 * anywhere. These tests pin the provider wire contract: request shapes,
 * auth headers, receipt shapes, and the failure modes (4xx, invalid
 * address, dead server) all land as `{ ok: false }` receipts — never a
 * throw, never a fake success.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildUnsubscribeUrl,
  createResendChannel,
  createTwilioChannel,
  dispatchAlert,
} from './src/index.js';

const T0 = Date.parse('2026-09-09T11:00:00.000Z');

/* ------------------------------------------------------------------ *
 * Loopback stub servers — stand-ins for the real provider APIs
 * ------------------------------------------------------------------ */

function startResendStub({ statusCode = 200 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(statusCode === 200 ? '{"id":"re_stub_123"}' : '{"message":"invalid sender"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startTwilioStub({ statusCode = 201 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Object.fromEntries(new URLSearchParams(body)),
      });
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(statusCode < 300 ? '{"sid":"SM_stub_456"}' : '{"message":"number is not a valid phone number"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Resend
 * ------------------------------------------------------------------ */

test('resend: success — POST /emails with Bearer auth, {from,to,subject,text}', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const channel = createResendChannel({
      apiKey: 're_test_stub_key',
      from: 'alerts@wax.wearedogs.net',
      baseUrl,
    });
    const message = { subject: 'New drop: MF DOOM — Operation Doomsday ($34.99)', text: 'New drop on Wax.\nBuy: https://shop/x' };
    const receipt = await channel.send({
      alert: { artist_name: 'MF DOOM', title: 'Operation Doomsday' },
      channel: 'email',
      to: 'fan@example.com',
      message,
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.channel, 'resend');
    assert.equal(receipt.messageId, 're_stub_123');
    assert.equal(receipt.sentAt, new Date(T0).toISOString());

    assert.equal(received.length, 1);
    const [call] = received;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/emails');
    assert.equal(call.authorization, 'Bearer re_test_stub_key');
    assert.deepEqual(call.body, {
      from: 'alerts@wax.wearedogs.net',
      to: ['fan@example.com'],
      subject: message.subject,
      text: message.text,
    });
  } finally {
    server.close();
  }
});

test('resend: provider 4xx is an { ok: false } receipt, not a throw', async () => {
  const { server, baseUrl } = await startResendStub({ statusCode: 422 });
  try {
    const channel = createResendChannel({
      apiKey: 're_test_stub_key',
      from: 'alerts@wax.wearedogs.net',
      baseUrl,
    });
    const receipt = await channel.send({
      alert: {},
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.channel, 'resend');
    assert.match(receipt.error, /422/);
    assert.match(receipt.error, /invalid sender/);
  } finally {
    server.close();
  }
});

test('resend: invalid recipient address is refused before any network', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const channel = createResendChannel({ apiKey: 're_test_stub_key', from: 'alerts@wax.wearedogs.net', baseUrl });
    for (const to of ['not-an-email', '', null]) {
      const receipt = await channel.send({ alert: {}, channel: 'email', to, message: null, nowMs: T0 });
      assert.equal(receipt.ok, false);
      assert.match(receipt.error, /invalid address/);
    }
    assert.equal(received.length, 0, 'refused addresses must never open a socket');
  } finally {
    server.close();
  }
});

test('resend: dead server is a failure receipt, never a throw', async () => {
  const channel = createResendChannel({
    apiKey: 're_test_stub_key',
    from: 'alerts@wax.wearedogs.net',
    baseUrl: 'http://127.0.0.1:1', // closed port — nothing listens here
  });
  const receipt = await channel.send({ alert: {}, channel: 'email', to: 'fan@example.com', message: null, nowMs: T0 });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /Resend failed/);
});

/* ------------------------------------------------------------------ *
 * Twilio
 * ------------------------------------------------------------------ */

test('twilio: success — POST Messages.json with Basic auth, form-encoded From/To/Body', async () => {
  const { server, received, baseUrl } = await startTwilioStub();
  try {
    const channel = createTwilioChannel({
      accountSid: 'AC_test_stub_sid',
      authToken: 'test_stub_token',
      from: '+15550123456',
      baseUrl,
    });
    const receipt = await channel.send({
      alert: { artist_name: 'Porter Robinson', title: 'SMILE! :D' },
      channel: 'sms',
      to: '+14155550199',
      message: 'Wax: Porter Robinson — SMILE! :D ($29.99)',
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.channel, 'twilio');
    assert.equal(receipt.messageId, 'SM_stub_456');

    assert.equal(received.length, 1);
    const [call] = received;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/2010-04-01/Accounts/AC_test_stub_sid/Messages.json');
    assert.equal(
      call.authorization,
      `Basic ${Buffer.from('AC_test_stub_sid:test_stub_token').toString('base64')}`,
    );
    assert.match(call.contentType, /application\/x-www-form-urlencoded/);
    assert.deepEqual(call.body, {
      From: '+15550123456',
      To: '+14155550199',
      Body: 'Wax: Porter Robinson — SMILE! :D ($29.99)',
    });
  } finally {
    server.close();
  }
});

test('twilio: provider 4xx is an { ok: false } receipt, not a throw', async () => {
  const { server, baseUrl } = await startTwilioStub({ statusCode: 400 });
  try {
    const channel = createTwilioChannel({
      accountSid: 'AC_test_stub_sid',
      authToken: 'test_stub_token',
      from: '+15550123456',
      baseUrl,
    });
    const receipt = await channel.send({ alert: {}, channel: 'sms', to: '+14155550199', message: 'hi', nowMs: T0 });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.channel, 'twilio');
    assert.match(receipt.error, /400/);
    assert.match(receipt.error, /not a valid phone number/);
  } finally {
    server.close();
  }
});

test('twilio: non-E.164 numbers are refused before any network', async () => {
  const { server, received, baseUrl } = await startTwilioStub();
  try {
    const channel = createTwilioChannel({
      accountSid: 'AC_test_stub_sid',
      authToken: 'test_stub_token',
      from: '+15550123456',
      baseUrl,
    });
    for (const to of ['5551234', '14155550199', '+1', '', null]) {
      const receipt = await channel.send({ alert: {}, channel: 'sms', to, message: 'hi', nowMs: T0 });
      assert.equal(receipt.ok, false);
      assert.match(receipt.error, /E\.164/);
    }
    assert.equal(received.length, 0, 'refused numbers must never open a socket');
  } finally {
    server.close();
  }
});

test('twilio: dead server is a failure receipt, never a throw', async () => {
  const channel = createTwilioChannel({
    accountSid: 'AC_test_stub_sid',
    authToken: 'test_stub_token',
    from: '+15550123456',
    baseUrl: 'http://127.0.0.1:1',
  });
  const receipt = await channel.send({ alert: {}, channel: 'sms', to: '+14155550199', message: 'hi', nowMs: T0 });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /Twilio failed/);
});

/* ------------------------------------------------------------------ *
 * End to end through dispatchAlert: a dead email provider must not
 * block the SMS that rides beside it.
 * ------------------------------------------------------------------ */

test('dispatchAlert: failing Resend + healthy Twilio — one failure receipt, one success receipt', async () => {
  const resendStub = await startResendStub({ statusCode: 500 });
  const twilioStub = await startTwilioStub();
  try {
    const channels = {
      email: createResendChannel({ apiKey: 're_test_stub_key', from: 'alerts@wax.wearedogs.net', baseUrl: resendStub.baseUrl }),
      sms: createTwilioChannel({
        accountSid: 'AC_test_stub_sid',
        authToken: 'test_stub_token',
        from: '+15550123456',
        baseUrl: twilioStub.baseUrl,
      }),
    };
    const alert = {
      user_id: 'u_1',
      artist_name: 'Death Grips',
      title: 'The Money Store',
      recipient: { email: 'fan@example.com', sms: '+14155550199' },
      deliveries: [
        { channel: 'email', message: { subject: 's', text: 't' }, verdict: { dispatch: true, reason: 'ok' } },
        { channel: 'sms', message: 'Wax: Death Grips — The Money Store', verdict: { dispatch: true, reason: 'ok' } },
      ],
    };
    const receipts = await dispatchAlert({ alert, channels, nowMs: T0 });
    assert.equal(receipts.length, 2);
    const email = receipts.find((r) => r.channel === 'email');
    const sms = receipts.find((r) => r.channel === 'sms');
    assert.equal(email.ok, false);
    assert.match(email.error, /500/);
    assert.equal(sms.ok, true);
    assert.equal(sms.messageId, 'SM_stub_456');
    assert.equal(sms.via, 'twilio');
    assert.equal(resendStub.received.length, 1, 'the dead provider still got its attempt');
    assert.equal(twilioStub.received.length, 1, 'the healthy channel still sent');
  } finally {
    resendStub.server.close();
    twilioStub.server.close();
  }
});

/* ------------------------------------------------------------------ *
 * List-Unsubscribe wiring (ALERT-ENGINE-PLAN.md §3, RFC 2369 + RFC 8058)
 * ------------------------------------------------------------------ */

test('resend: List-Unsubscribe headers ride the payload when unsubscribeUrl is set', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const channel = createResendChannel({
      apiKey: 're_test_stub_key',
      from: 'alerts@wax.wearedogs.net',
      baseUrl,
      unsubscribeUrl: 'https://wax.wearedogs.net/api/alerts/unsubscribe?token=tok_123',
    });
    const receipt = await channel.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 'New drop', text: 'New drop on Wax.' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.deepEqual(received[0].body.headers, {
      'List-Unsubscribe': '<https://wax.wearedogs.net/api/alerts/unsubscribe?token=tok_123>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  } finally {
    server.close();
  }
});

test('resend: no headers key when unsubscribeUrl is not configured', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const channel = createResendChannel({
      apiKey: 're_test_stub_key',
      from: 'alerts@wax.wearedogs.net',
      baseUrl,
    });
    const receipt = await channel.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal('headers' in received[0].body, false, 'payload shape unchanged without unsubscribeUrl');
  } finally {
    server.close();
  }
});

test('resend: unsubscribeUrl as a function resolves per-send from envelope.unsubscribe_token', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    const channel = createResendChannel({
      apiKey: 're_test_stub_key',
      from: 'alerts@wax.wearedogs.net',
      baseUrl,
      unsubscribeUrl: (envelope) =>
        envelope?.unsubscribe_token
          ? buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe', envelope.unsubscribe_token)
          : null,
    });
    const receipt = await channel.send({
      alert: null,
      channel: 'email',
      to: 'fan@example.com',
      message: { subject: 's', text: 't' },
      unsubscribe_token: 'tok_abc+def',
      nowMs: T0,
    });
    assert.equal(receipt.ok, true);
    assert.equal(
      received[0].body.headers['List-Unsubscribe'],
      '<https://wax.wearedogs.net/api/alerts/unsubscribe?token=tok_abc%2Bdef>',
    );
    assert.equal(received[0].body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  } finally {
    server.close();
  }
});

test('resend: malformed List-Unsubscribe URL refuses the send before any network', async () => {
  const { server, received, baseUrl } = await startResendStub();
  try {
    for (const bad of ['javascript:alert(1)', 'ftp://evil.example/unsub', 'relative/path']) {
      const channel = createResendChannel({
        apiKey: 're_test_stub_key',
        from: 'alerts@wax.wearedogs.net',
        baseUrl,
        unsubscribeUrl: bad,
      });
      const receipt = await channel.send({
        alert: null,
        channel: 'email',
        to: 'fan@example.com',
        message: { subject: 's', text: 't' },
        nowMs: T0,
      });
      assert.equal(receipt.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      assert.match(receipt.error, /List-Unsubscribe/);
    }
    assert.equal(received.length, 0, 'no request may leave with a bad unsubscribe URL');
  } finally {
    server.close();
  }
});

test('resend: unsubscribeUrl with the wrong type throws at construction', () => {
  assert.throws(
    () => createResendChannel({ apiKey: 're_test_stub_key', from: 'a@b.c', unsubscribeUrl: 42 }),
    /unsubscribeUrl must be a URL string or a/,
  );
  assert.throws(
    () => createResendChannel({ apiKey: 're_test_stub_key', from: 'a@b.c', unsubscribeUrl: { oops: 1 } }),
    /unsubscribeUrl must be a URL string or a/,
  );
});

test('buildUnsubscribeUrl: builds ?token=, appends &token= to an existing query, encodes the token', () => {
  assert.equal(
    buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe', 'tok_123'),
    'https://wax.wearedogs.net/api/alerts/unsubscribe?token=tok_123',
  );
  assert.equal(
    buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe', 'a b+c'),
    'https://wax.wearedogs.net/api/alerts/unsubscribe?token=a%20b%2Bc',
  );
  assert.equal(
    buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe?src=email', 'tok_9'),
    'https://wax.wearedogs.net/api/alerts/unsubscribe?src=email&token=tok_9',
  );
});

test('buildUnsubscribeUrl: refuses non-http(s) schemes, relative URLs, and empty tokens', () => {
  for (const bad of ['ftp://x.example/u', 'javascript:alert(1)', '/relative/path', '']) {
    assert.throws(() => buildUnsubscribeUrl(bad, 'tok_1'), /absolute|scheme/, bad || '(empty)');
  }
  assert.throws(() => buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe', ''), /token/);
  assert.throws(() => buildUnsubscribeUrl('https://wax.wearedogs.net/api/alerts/unsubscribe', null), /token/);
});
