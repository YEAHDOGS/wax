/**
 * @file Alert dispatch layer — the pluggable channel half of the alert
 * engine (plan §3, after the scan worker in `poller.js` and the HTTP
 * fetcher in `fetcher.js`).
 *
 * `poller.js` turns new drops into *alert feed items* carrying formatted
 * content and a per-delivery dispatch verdict. This module takes those
 * items and actually sends them. It performs no scan logic, no matching,
 * no rate gating — only delivery.
 *
 * ## Channel interface
 *
 * A channel is any object shaped like:
 *
 *   { name: string, kind: string, send(envelope) => Promise<receipt> }
 *
 * where `envelope` is `{ alert, channel, to, message, nowMs }` and a
 * `receipt` is either `{ ok: true, channel, messageId, sentAt }` or
 * `{ ok: false, channel, error, sentAt }`. `dispatchAlert` never throws
 * for a single channel failing — a dead webhook must not take down the
 * SMS that rides beside it — but a missing *channel for a delivery* is a
 * loud `{ ok: false }` receipt, not a silent drop.
 *
 * ## Shipped channels
 *
 * - `createWebhookChannel({ url, ... })` — POSTs a JSON payload to any
 *   http(s) URL. The integration seam for n8n / Discord / Slack / a
 *   Brando-owned endpoint. Fully working.
 * - `createLogChannel({ path })` — appends one JSONL line per send to a
 *   local file. Dev/test channel; the receipts it records are marked
 *   `dev: true` so a log line is never mistaken for a real send.
 * - `createResendChannel({ apiKey, from, baseUrl? })` — fully wired email
 *   adapter: POSTs `{ from, to, subject, text }` to the Resend `/emails`
 *   endpoint with a Bearer key. Still throws at setup without a live key —
 *   a stub send would be fraud. Key-gated, loopback-tested; live sends
 *   wait on Brando's `RESEND_API_KEY`.
 * - `createTwilioChannel({ accountSid, authToken, from, baseUrl? })` —
 *   fully wired SMS adapter: POSTs form-encoded `From`/`To`/`Body` to the
 *   Twilio Messages API with Basic auth. Addresses are validated to E.164
 *   before anything leaves. Key-gated, loopback-tested; live sends wait
 *   on Brando's Twilio credentials.
 *
 * `baseUrl` on both providers exists only for the test suite's loopback
 * stub servers — production always uses the provider's real endpoint.
 *
 * ## Wiring
 *
 * `dispatchScanAlerts({ store, alerts, channels, nowMs })` is the worker's
 * hand-off: for every alert the scan pass produced, it resolves the user's
 * recipient addresses, sends each green-lit delivery through its channel,
 * persists the alert row with its delivery receipts, and records a
 * `dispatch` row in the per-source scan log — receipts land in
 * `scan_logs` too, per the plan's transparency pattern.
 */

import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { newId } from './store.js';
import { recordScanLog } from './poller.js';

/** Webhook POST timeout before a slow receiver counts as a failure. */
export const WEBHOOK_TIMEOUT_MS = 8_000;

/** Max bytes read off a webhook response before we stop caring. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/**
 * Only http(s) may be a webhook target — anything else is a typo or an
 * attempt to get dispatch to dial something it must not touch. Same
 * defense-in-depth posture as the scan worker's `canFetch`.
 * @param {?string} url
 * @returns {boolean}
 */
export function canPost(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Assert a channel honours the contract the dispatch layer expects.
 * Fails loud at setup time so a broken channel never half-sends in
 * production.
 * @param {*} channel
 * @param {string} [label]
 */
export function assertChannel(channel, label = 'channel') {
  if (!channel || typeof channel !== 'object') {
    throw new TypeError(`${label} must be an object, got ${typeof channel}`);
  }
  if (typeof channel.name !== 'string' || !channel.name) {
    throw new TypeError(`${label} must have a non-empty string 'name'`);
  }
  if (typeof channel.kind !== 'string' || !channel.kind) {
    throw new TypeError(`${label} must have a non-empty string 'kind'`);
  }
  if (typeof channel.send !== 'function') {
    throw new TypeError(`${label} must expose send(envelope)`);
  }
  return channel;
}

/* ------------------------------------------------------------------ *
 * Shared provider plumbing
 * ------------------------------------------------------------------ */

/** Hard ceiling on bytes read off any provider response. */
const PROVIDER_MAX_BODY_BYTES = 64 * 1024;

/** Provider HTTP timeout — a slow provider counts as a failure, fast. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * One provider HTTP call — POST body, JSON or form-encoded — with a hard
 * timeout and body cap. No retries here: retry policy belongs to the
 * worker (`poller.js`), not the wire. Returns `{ statusCode, headers,
 * bodyText }` or throws on transport failure.
 */
function postProvider(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const impl = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = impl(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { 'user-agent': 'WaxBot/1.0; +https://wax.wearedogs.net/bot', ...headers },
        timeout: PROVIDER_TIMEOUT_MS,
      },
      (res) => {
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= PROVIDER_MAX_BODY_BYTES) chunks.push(chunk);
          else res.destroy();
        });
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, headers: res.headers, bodyText: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('provider timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** ISO timestamp for a receipt, honoring the envelope's clock in tests. */
function receiptAt(envelope) {
  return new Date(envelope?.nowMs ?? Date.now()).toISOString();
}

/** The text the recipient sees — a formatted message, or the raw alert. */
function messageText(message, alert) {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') return message.text ?? message.body ?? JSON.stringify(message);
  return alert?.listing_url ? `Wax: ${alert.artist_name ?? 'new drop'} — ${alert.title ?? ''} ${alert.listing_url}`.trim() : 'Wax alert';
}

function messageSubject(message, alert) {
  if (message && typeof message === 'object' && typeof message.subject === 'string') return message.subject;
  const artist = alert?.artist_name ?? 'Wax';
  const title = alert?.title ?? 'new drop';
  return `${artist} — ${title}`;
}

/**
 * Parse a JSON provider body defensively — a provider erroring as HTML
 * must not take down the dispatch layer.
 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Build the `{ ok: false }` receipt every provider error path shares,
 * so a 4xx, a transport failure, and a bad address all read the same.
 */
function providerFailure(name, sentAt, error) {
  return { ok: false, channel: name, error, sentAt };
}

/* ------------------------------------------------------------------ *
 * Webhook channel — fully working
 * ------------------------------------------------------------------ */

/**
 * POST every dispatched alert as JSON to a configured URL.
 *
 * Payload: `{ event: 'wax.alert', channel, to, alert, message, sent_at }`.
 * The message body mirrors the email/sms the user would otherwise get,
 * so a webhook receiver can rebuild the alert without Wax internals.
 *
 * @param {object} input
 * @param {string} input.url The receiver URL (http/https only).
 * @param {string} [input.name] Channel name. Defaults to `'webhook'`.
 * @param {number} [input.timeoutMs] Defaults to `WEBHOOK_TIMEOUT_MS`.
 * @returns {{ name: string, kind: 'webhook', send: (envelope) => Promise<object> }}
 */
export function createWebhookChannel({ url, name = 'webhook', timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
  if (!canPost(url)) {
    throw new TypeError(`webhook channel needs an http(s) url, got ${JSON.stringify(url)}`);
  }
  const channel = {
    name,
    kind: 'webhook',
    url,
    async send(envelope) {
      const sentAt = new Date(envelope?.nowMs ?? Date.now()).toISOString();
      const payload = JSON.stringify({
        event: 'wax.alert',
        channel: envelope?.channel ?? null,
        to: envelope?.to ?? null,
        alert: publicAlert(envelope?.alert),
        message: envelope?.message ?? null,
        sent_at: sentAt,
      });
      try {
        const { statusCode, headers } = await postJson(url, payload, timeoutMs);
        if (statusCode >= 200 && statusCode < 300) {
          return {
            ok: true,
            channel: name,
            messageId: headers['x-request-id'] ?? `wh_${randomUUID()}`,
            sentAt,
          };
        }
        return { ok: false, channel: name, error: `webhook HTTP ${statusCode}`, sentAt };
      } catch (err) {
        return { ok: false, channel: name, error: `webhook failed: ${err?.message ?? String(err)}`, sentAt };
      }
    },
  };
  return assertChannel(channel, 'webhook channel');
}

/** Strip a feed alert down to the fields a receiver is allowed to see. */
function publicAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;
  return {
    artist_name: alert.artist_name ?? null,
    title: alert.title ?? null,
    price_cents: alert.price_cents ?? null,
    currency: alert.currency ?? null,
    listing_url: alert.listing_url ?? null,
    source_label: alert.source_label ?? null,
    detected_at: alert.detected_at ?? null,
  };
}

/** One JSON POST, no retries — retry policy belongs to the worker, not the wire. */
function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const impl = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = impl(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'WaxBot/1.0; +https://wax.wearedogs.net/bot',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > WEBHOOK_MAX_BODY_BYTES) res.destroy();
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('webhook timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/* ------------------------------------------------------------------ *
 * Log channel — dev/test
 * ------------------------------------------------------------------ */

/**
 * Append one JSONL line per send to a local file. The receipts it
 * produces carry `dev: true` so nobody mistakes a log line for a real
 * delivery. No network, no keys, no surprises — the channel the test
 * suite and local dev use.
 *
 * @param {object} input
 * @param {string} input.path File to append to (parent dirs are created).
 * @param {string} [input.name] Channel name. Defaults to `'log'`.
 */
export function createLogChannel({ path, name = 'log' } = {}) {
  if (!path || typeof path !== 'string') {
    throw new TypeError(`log channel needs a file path, got ${JSON.stringify(path)}`);
  }
  const channel = {
    name,
    kind: 'log',
    path,
    async send(envelope) {
      const sentAt = new Date(envelope?.nowMs ?? Date.now()).toISOString();
      const messageId = `log_${randomUUID()}`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(
          path,
          `${JSON.stringify({ message_id: messageId, sent_at: sentAt, dev: true, channel: envelope?.channel ?? null, to: envelope?.to ?? null, message: envelope?.message ?? null })}\n`,
        );
        return { ok: true, channel: name, messageId, sentAt, dev: true };
      } catch (err) {
        return { ok: false, channel: name, error: `log write failed: ${err?.message ?? String(err)}`, sentAt, dev: true };
      }
    },
  };
  return assertChannel(channel, 'log channel');
}

/* ------------------------------------------------------------------ *
 * Provider stubs — Resend (email) and Twilio (SMS)
 * ------------------------------------------------------------------ */

/**
 * Email adapter for Resend — the plan §3 provider, fully wired.
 *
 * Constructor is still loud without a live key (dispatch never fakes
 * email), but with one it really sends: `POST {baseUrl}/emails` with a
 * Bearer token, `{ from, to, subject, text }` body, per the documented
 * Resend API shape.
 *
 * `baseUrl` exists only so the test suite can aim the adapter at a local
 * stub server — production always uses the default
 * `https://api.resend.com`. Nothing here needs or stores a real key;
 * Brando supplies `RESEND_API_KEY` when the send is real.
 *
 * List-Unsubscribe (plan §3, "the missing piece before real sends"):
 * pass `unsubscribeUrl` to put every email behind a compliant one-click
 * unsubscribe. It may be a static http(s) URL, or a function
 * `(envelope) => ?string` resolved per send — the function form is how a
 * per-recipient token lands in the URL (use `buildUnsubscribeUrl` from
 * `subscriptions.js`, with the endpoint's unsubscribe token, to build
 * it). A set-but-malformed URL refuses the send as `{ ok: false }` —
 * Gmail and Outlook require working List-Unsubscribe on bulk mail, so a
 * bad value is a delivery incident, not a warning.
 *
 * @param {object} input
 * @param {string} input.apiKey Live Resend key (`RESEND_API_KEY`).
 * @param {string} input.from Verified sender, e.g. `alerts@wax.wearedogs.net`.
 * @param {string} [input.baseUrl] Provider root. Defaults to the real one.
 * @param {?(string|(envelope: object) => ?string)} [input.unsubscribeUrl]
 *   Static List-Unsubscribe URL, or a per-send resolver.
 */
export function createResendChannel({ apiKey, from, baseUrl = 'https://api.resend.com', unsubscribeUrl = null } = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(
      'Resend email channel needs a live API key from Brando (RESEND_API_KEY) — ' +
        'dispatch refuses to fake email sends. Supply apiKey to continue.',
    );
  }
  if (!from || typeof from !== 'string') {
    throw new Error('Resend email channel needs a verified sender address (from).');
  }
  if (unsubscribeUrl != null && typeof unsubscribeUrl !== 'string' && typeof unsubscribeUrl !== 'function') {
    throw new TypeError(
      `Resend unsubscribeUrl must be a URL string or a (envelope) => url function, got ${typeof unsubscribeUrl}`,
    );
  }
  /** Resolve the configured unsubscribe target for one send; null = no link for this recipient. */
  function resolveUnsubscribeUrl(envelope) {
    if (unsubscribeUrl == null) return null;
    let resolved;
    if (typeof unsubscribeUrl === 'function') {
      try {
        resolved = unsubscribeUrl(envelope);
      } catch {
        resolved = null;
      }
    } else {
      resolved = unsubscribeUrl;
    }
    if (resolved == null || resolved === '') return null;
    if (typeof resolved !== 'string') return { invalid: true, raw: resolved };
    try {
      const parsed = new URL(resolved);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? { url: resolved }
        : { invalid: true, raw: resolved };
    } catch {
      return { invalid: true, raw: resolved };
    }
  }
  const channel = {
    name: 'resend',
    kind: 'email',
    async send(envelope) {
      const sentAt = receiptAt(envelope);
      const to = envelope?.to ?? null;
      if (!to || !EMAIL_RE.test(to)) {
        return providerFailure('resend', sentAt, `refusing to send email to invalid address ${JSON.stringify(to)}`);
      }
      let emailHeaders = null;
      if (unsubscribeUrl != null) {
        const resolved = resolveUnsubscribeUrl(envelope);
        if (resolved?.invalid) {
          return providerFailure(
            'resend',
            sentAt,
            `refusing to send — invalid List-Unsubscribe URL ${JSON.stringify(String(resolved.raw).slice(0, 120))}; ` +
              'fix the URL or drop the unsubscribeUrl option',
          );
        }
        if (resolved?.url) {
          // RFC 2369 header, RFC 8058 one-click POST marker.
          emailHeaders = {
            'List-Unsubscribe': `<${resolved.url}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          };
        }
      }
      const payload = JSON.stringify({
        from,
        to: [to],
        subject: messageSubject(envelope?.message, envelope?.alert),
        text: messageText(envelope?.message, envelope?.alert),
        ...(emailHeaders ? { headers: emailHeaders } : {}),
      });
      try {
        const { statusCode, bodyText } = await postProvider(`${baseUrl}/emails`, {
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            authorization: `Bearer ${apiKey}`,
          },
          body: payload,
        });
        const body = safeJson(bodyText);
        if (statusCode >= 200 && statusCode < 300) {
          return { ok: true, channel: 'resend', messageId: body?.id ?? null, sentAt };
        }
        return providerFailure(
          'resend',
          sentAt,
          `Resend HTTP ${statusCode}: ${body?.message ?? bodyText.slice(0, 200)}`,
        );
      } catch (err) {
        return providerFailure('resend', sentAt, `Resend failed: ${err?.message ?? String(err)}`);
      }
    },
  };
  return assertChannel(channel, 'resend channel');
}

/**
 * SMS adapter for Twilio — the plan §3 provider, fully wired.
 *
 * Constructor is still loud without live credentials, but with them it
 * really sends: `POST {baseUrl}/2010-04-01/Accounts/{sid}/Messages.json`
 * with HTTP Basic auth and a form-encoded `From`/`To`/`Body`, per the
 * documented Twilio Messages API shape. The 160-char single segment the
 * notify layer formats (`formatDropSms`) is exactly what rides the wire.
 *
 * `baseUrl` exists only for the loopback test stub; production uses the
 * default `https://api.twilio.com`.
 *
 * @param {object} input
 * @param {string} input.accountSid Live Twilio account SID.
 * @param {string} input.authToken Live Twilio auth token.
 * @param {string} input.from Twilio-verified sender number (E.164).
 */
export function createTwilioChannel({ accountSid, authToken, from, baseUrl = 'https://api.twilio.com' } = {}) {
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio SMS channel needs live credentials from Brando ' +
        '(TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN) — dispatch refuses to fake SMS sends. ' +
        'Supply accountSid and authToken to continue.',
    );
  }
  if (!from || typeof from !== 'string') {
    throw new Error('Twilio SMS channel needs a verified sender number (from).');
  }
  const channel = {
    name: 'twilio',
    kind: 'sms',
    async send(envelope) {
      const sentAt = receiptAt(envelope);
      const to = envelope?.to ?? null;
      if (!to || !E164_RE.test(to)) {
        return providerFailure('twilio', sentAt, `refusing to SMS invalid number ${JSON.stringify(to)} (E.164 expected)`);
      }
      const params = new URLSearchParams({ From: from, To: to, Body: messageText(envelope?.message, envelope?.alert) });
      const form = params.toString();
      const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      try {
        const { statusCode, bodyText } = await postProvider(
          `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
          {
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'content-length': Buffer.byteLength(form),
              authorization: `Basic ${basic}`,
            },
            body: form,
          },
        );
        const body = safeJson(bodyText);
        if (statusCode >= 200 && statusCode < 300) {
          return { ok: true, channel: 'twilio', messageId: body?.sid ?? null, sentAt };
        }
        return providerFailure(
          'twilio',
          sentAt,
          `Twilio HTTP ${statusCode}: ${body?.message ?? bodyText.slice(0, 200)}`,
        );
      } catch (err) {
        return providerFailure('twilio', sentAt, `Twilio failed: ${err?.message ?? String(err)}`);
      }
    },
  };
  return assertChannel(channel, 'twilio channel');
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/**
 * Send one alert feed item through its channels.
 *
 * Each `delivery` on the alert carries the notify layer's verdict.
 * Only `verdict.dispatch === true` deliveries go out; the rest (rate
 * caps, digest folds, unverified phone) are reported back as skipped,
 * never silently dropped. One channel failing does not stop the others,
 * and a throw inside a channel is caught into a `{ ok: false }`
 * receipt — dispatch returns a verdict per delivery, it never throws.
 *
 * @param {object} input
 * @param {object} input.alert Feed item from the scan worker's
 *   `buildAlerts` (deliveries + `recipient` map of channel → address).
 * @param {Record<string, object>} input.channels Map of delivery channel
 *   (`'email'`, `'sms'`) to channel object.
 * @param {string[]} [input.fanout] Extra channel names that receive a
 *   copy of every dispatched delivery (e.g. a webhook mirror).
 * @param {number} [input.nowMs]
 * @returns {Promise<Array<object>>} One receipt per attempted delivery,
 *   plus `{ skipped: true }` entries for deliveries the verdict held back.
 */
export async function dispatchAlert({ alert, channels = {}, fanout = [], nowMs = Date.now() }) {
  const receipts = [];
  for (const delivery of alert?.deliveries ?? []) {
    if (!delivery?.verdict?.dispatch) {
      receipts.push({
        channel: delivery?.channel ?? 'unknown',
        skipped: true,
        reason: delivery?.verdict?.reason ?? 'held by dispatch verdict',
        sentAt: new Date(nowMs).toISOString(),
      });
      continue;
    }
    const channel = channels[delivery.channel];
    const to = alert?.recipient?.[delivery.channel] ?? null;
    if (!channel) {
      receipts.push({
        ok: false,
        channel: delivery.channel,
        error: `no channel configured for '${delivery.channel}'`,
        sentAt: new Date(nowMs).toISOString(),
      });
      continue;
    }
    if (!to) {
      receipts.push({
        ok: false,
        channel: delivery.channel,
        error: `no recipient address for '${delivery.channel}'`,
        sentAt: new Date(nowMs).toISOString(),
      });
      continue;
    }
    let receipt;
    try {
      receipt = await channel.send({ alert, channel: delivery.channel, to, message: delivery.message, nowMs });
    } catch (err) {
      receipt = {
        ok: false,
        channel: delivery.channel,
        error: `channel threw: ${err?.message ?? String(err)}`,
        sentAt: new Date(nowMs).toISOString(),
      };
    }
    receipts.push({ ...receipt, via: channel.name, channel: delivery.channel });

    // Fan-out copies ride alongside: they observe, they never gate.
    for (const extra of fanout) {
      const mirror = channels[extra];
      if (!mirror || mirror === channel) continue;
      try {
        const copy = await mirror.send({
          alert,
          channel: `fanout:${delivery.channel}`,
          to: extra,
          message: delivery.message,
          nowMs,
        });
        receipts.push({ ...copy, via: mirror.name, channel: `fanout:${delivery.channel}` });
      } catch (err) {
        receipts.push({
          via: mirror.name,
          ok: false,
          channel: `fanout:${delivery.channel}`,
          error: `fanout threw: ${err?.message ?? String(err)}`,
          sentAt: new Date(nowMs).toISOString(),
        });
      }
    }
  }
  return receipts;
}

/**
 * The scan worker's hand-off: dispatch a whole pass of alerts, persist
 * each alert row with its delivery receipts, and record a `dispatch`
 * entry per alert in the scan log — the receipts live in `scan_logs`
 * too, the same transparency pattern as the scan attempts.
 *
 * Rows land on `store.alerts` shaped for the existing rate ledger:
 * `dispatched_at` + `channels` (the channels that left successfully), so
 * `sentThisWindow` keeps counting what actually went out. Persisted
 * alerts are never re-dispatched by a later pass — the row is the
 * exactly-once marker.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {Array<object>} input.alerts Feed items from `runScanPass`.
 * @param {Record<string, object>} input.channels Channel map for
 *   {@link dispatchAlert}.
 * @param {string[]} [input.fanout]
 * @param {number} [input.nowMs]
 * @returns {Promise<{ dispatched: number, receipts: Array<object>, alerts: Array<object> }>}
 */
export async function dispatchScanAlerts({ store, alerts = [], channels = {}, fanout = [], nowMs = Date.now() }) {
  const dispatchedAlerts = [];
  const allReceipts = [];

  for (const alert of alerts) {
    const user = await store.users.find((u) => u.id === alert?.user_id);
    const recipient = {
      email: user?.email_verified === true ? (user.email ?? null) : null,
      sms: user?.phone_verified === true ? (user.phone ?? null) : null,
    };
    const alertWithRecipient = { ...alert, recipient };

    const receipts = await dispatchAlert({ alert: alertWithRecipient, channels, fanout, nowMs });
    allReceipts.push(...receipts);

    const sentChannels = [...new Set(receipts.filter((r) => r.ok && !r.skipped && !String(r.channel ?? '').startsWith('fanout:')).map((r) => r.channel))];
    const row = await store.alerts.insert({
      id: newId('alr'),
      ...alertWithRecipient,
      dispatched_at: new Date(nowMs).toISOString(),
      channels: sentChannels,
      dispatches: receipts,
    });

    // Receipts land in the scan log too — every send is inspectable
    // next to the scan attempts that found the drop.
    await recordScanLog(store, {
      source_id: `alert:${row.id}`,
      outcome: 'dispatch',
      alert_id: row.id,
      user_id: alert?.user_id ?? null,
      delivered: sentChannels.length,
      attempted: receipts.filter((r) => !r.skipped).length,
      failures: receipts.filter((r) => r.ok === false).length,
      skipped: receipts.filter((r) => r.skipped).length,
      receipts,
    });

    dispatchedAlerts.push(row);
  }

  return {
    dispatched: dispatchedAlerts.length,
    receipts: allReceipts,
    alerts: dispatchedAlerts,
  };
}
