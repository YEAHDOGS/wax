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
 * - `createResendChannel({ apiKey, from })` / `createTwilioChannel({ ... })`
 *   — DOCUMENTED STUBS. The constructors throw unless a live key is
 *   supplied ("needs API key from Brando"), and `send()` refuses to fake
 *   a send. Real provider wiring is a later, deliberate step — never ship
 *   fake sends as real ones.
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
 * Email adapter shape for Resend. A DOCUMENTED STUB: the constructor
 * throws unless a live key is supplied, and `send()` refuses to fake a
 * delivery. Real provider wiring needs Brando's key AND a deliberate
 * second pass — this file will never quietly pretend a stub is a send.
 *
 * @param {object} input
 * @param {string} input.apiKey Live Resend key (`RESEND_API_KEY`).
 * @param {string} input.from Verified sender, e.g. `alerts@wax.wearedogs.net`.
 */
export function createResendChannel({ apiKey, from } = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(
      'Resend email channel needs a live API key from Brando (RESEND_API_KEY) — ' +
        'dispatch refuses to fake email sends. Supply apiKey to continue.',
    );
  }
  if (!from || typeof from !== 'string') {
    throw new Error('Resend email channel needs a verified sender address (from).');
  }
  const channel = {
    name: 'resend',
    kind: 'email',
    async send() {
      throw new Error(
        'Resend adapter is a documented stub: the provider HTTP call is not ' +
          'wired yet. Wire src/dispatch.js createResendChannel.send against ' +
          'https://api.resend.com/emails with the live key before using.',
      );
    },
  };
  return assertChannel(channel, 'resend channel');
}

/**
 * SMS adapter shape for Twilio. Same stub contract as Resend: loud
 * without keys, and `send()` refuses to fake an SMS. The 160-char single
 * segment the notify layer formats (`formatDropSms`) is exactly what a
 * real send would carry.
 *
 * @param {object} input
 * @param {string} input.accountSid Live Twilio account SID.
 * @param {string} input.authToken Live Twilio auth token.
 * @param {string} input.from Twilio-verified sender number.
 */
export function createTwilioChannel({ accountSid, authToken, from } = {}) {
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
    async send() {
      throw new Error(
        'Twilio adapter is a documented stub: the provider HTTP call is not ' +
          'wired yet. Wire src/dispatch.js createTwilioChannel.send against ' +
          'the Twilio Messages API with the live credentials before using.',
      );
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
    const user = store.users.find((u) => u.id === alert?.user_id);
    const recipient = {
      email: user?.email_verified === true ? (user.email ?? null) : null,
      sms: user?.phone_verified === true ? (user.phone ?? null) : null,
    };
    const alertWithRecipient = { ...alert, recipient };

    const receipts = await dispatchAlert({ alert: alertWithRecipient, channels, fanout, nowMs });
    allReceipts.push(...receipts);

    const sentChannels = [...new Set(receipts.filter((r) => r.ok && !r.skipped && !String(r.channel ?? '').startsWith('fanout:')).map((r) => r.channel))];
    const row = store.alerts.insert({
      id: newId('alr'),
      ...alertWithRecipient,
      dispatched_at: new Date(nowMs).toISOString(),
      channels: sentChannels,
      dispatches: receipts,
    });

    // Receipts land in the scan log too — every send is inspectable
    // next to the scan attempts that found the drop.
    recordScanLog(store, {
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
