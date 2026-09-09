/**
 * @file Send-adapter seam — the config-flag boundary between the alert
 * queue and the real providers (plan §3).
 *
 * Live Resend/Twilio keys are NOT available yet (blocked on Brando), so
 * the engine ships against a clean seam, never a half-wired provider:
 *
 * - `createDisabledResendAdapter()` / `createDisabledTwilioAdapter()` —
 *   **NOT WIRED.** Every `send()` returns a `{ ok: false }` receipt with
 *   a loud `NOT WIRED` reason and never opens a socket. A disabled
 *   adapter is fraud-proof by construction: it cannot send, because it
 *   has no code path that sends.
 * - `createConsoleAdapter()` — the adapter tests and local dev use. Sends
 *   are recorded in-memory (no I/O, no keys) and receipts carry
 *   `dev: true` so they are never mistaken for real deliveries.
 * - `resolveSendAdapters(config)` — the seam: given `{ email, sms }`
 *   config with an `enabled` flag and optional live keys, returns either
 *   the fully-wired adapters from `dispatch.js` (when Brando's keys are
 *   present) or the disabled stubs (anything else). Nothing in between.
 *
 * All adapters honour the dispatch channel contract (`dispatch.js`):
 * `{ name, kind, send(envelope) => Promise<receipt> }`, enforced by
 * `assertChannel` at construction.
 */

import { randomUUID } from 'node:crypto';

import {
  assertChannel,
  createResendChannel,
  createTwilioChannel,
} from './dispatch.js';

/**
 * The wiring board — one line per provider, readable at a glance.
 * `enabled: false` + `status: 'NOT WIRED'` until Brando supplies keys.
 */
export const SEND_WIRING = Object.freeze({
  resend: Object.freeze({
    enabled: false,
    needs: 'RESEND_API_KEY',
    status: 'NOT WIRED — email sends disabled, no socket ever opened',
  }),
  twilio: Object.freeze({
    enabled: false,
    needs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    status: 'NOT WIRED — SMS sends disabled, no socket ever opened',
  }),
});

/**
 * The receipt every disabled adapter returns. It is honest twice over:
 * `ok: false` (nothing left) and a reason naming the exact missing keys.
 */
function disabledReceipt(channel, needs, sentAt) {
  const needsList = Array.isArray(needs) ? needs.join(' + ') : needs;
  return {
    ok: false,
    channel,
    sentAt,
    error:
      `NOT WIRED — ${channel} sends are disabled until Brando supplies live keys ` +
      `(${needsList}). This adapter has no send path: no socket was opened, ` +
      `no provider was contacted.`,
  };
}

/**
 * Stub Resend (email) adapter — clearly NOT WIRED, needs keys.
 * Never sends; returns the NOT-WIRED receipt on every call.
 * @param {object} [input]
 * @param {string} [input.from] Declared sender, carried for later wiring.
 */
export function createDisabledResendAdapter({ from = 'alerts@wax.wearedogs.net' } = {}) {
  const adapter = {
    name: 'resend',
    kind: 'email',
    from,
    wired: false,
    async send(envelope) {
      return disabledReceipt('resend', SEND_WIRING.resend.needs, new Date(envelope?.nowMs ?? Date.now()).toISOString());
    },
  };
  return assertChannel(adapter, 'disabled resend adapter');
}

/**
 * Stub Twilio (SMS) adapter — clearly NOT WIRED, needs keys.
 * Never sends; returns the NOT-WIRED receipt on every call.
 * @param {object} [input]
 * @param {string} [input.from] Declared sender, carried for later wiring.
 */
export function createDisabledTwilioAdapter({ from = null } = {}) {
  const adapter = {
    name: 'twilio',
    kind: 'sms',
    from,
    wired: false,
    async send(envelope) {
      return disabledReceipt('twilio', SEND_WIRING.twilio.needs, new Date(envelope?.nowMs ?? Date.now()).toISOString());
    },
  };
  return assertChannel(adapter, 'disabled twilio adapter');
}

/**
 * Console adapter — the adapter the test suite and local dev use.
 * Records every send into `sink` (an in-memory array, caller-owned) and
 * returns an `{ ok: true }` receipt marked `dev: true`. No network, no
 * keys, no I/O — the record is the whole point.
 *
 * @param {object} [input]
 * @param {Array<object>} [input.sink] Collector for send records.
 * @param {string} [input.name] Channel name. Defaults to `'console'`.
 * @param {'email'|'sms'} [input.kind] Declared kind. Defaults to `'email'`.
 */
export function createConsoleAdapter({ sink = [], name = 'console', kind = 'email' } = {}) {
  if (!Array.isArray(sink)) {
    throw new TypeError(`console adapter needs an array sink, got ${typeof sink}`);
  }
  const adapter = {
    name,
    kind,
    sink,
    async send(envelope) {
      const sentAt = new Date(envelope?.nowMs ?? Date.now()).toISOString();
      const messageId = `console_${randomUUID()}`;
      sink.push({
        message_id: messageId,
        sent_at: sentAt,
        dev: true,
        channel: envelope?.channel ?? null,
        to: envelope?.to ?? null,
        message: envelope?.message ?? null,
      });
      return { ok: true, channel: name, messageId, sentAt, dev: true };
    },
  };
  return assertChannel(adapter, 'console adapter');
}

/**
 * The seam. Given provider config, return the adapters the queue should
 * dispatch through — real ones when Brando's keys are present, disabled
 * stubs in every other case. There is no "sort of wired".
 *
 * @param {object} [input]
 * @param {object} [input.email]
 * @param {boolean} [input.email.enabled] Must be `true` AND `apiKey`
 *   present to wire Resend.
 * @param {string} [input.email.apiKey] Live `RESEND_API_KEY`.
 * @param {string} [input.email.from] Verified sender.
 * @param {object} [input.sms]
 * @param {boolean} [input.sms.enabled] Must be `true` AND both Twilio
 *   credentials present to wire Twilio.
 * @param {string} [input.sms.accountSid]
 * @param {string} [input.sms.authToken]
 * @param {string} [input.sms.from] Twilio-verified sender (E.164).
 * @param {boolean} [input.dev] When `true`, returns console adapters for
 *   tests and local dev instead of disabled stubs.
 * @returns {{ email: object, sms: object }}
 */
export function resolveSendAdapters({ email = {}, sms = {}, dev = false } = {}) {
  const emailAdapter =
    email?.enabled === true && email?.apiKey
      ? createResendChannel({ apiKey: email.apiKey, from: email.from })
      : dev
        ? createConsoleAdapter({ name: 'console-email', kind: 'email' })
        : createDisabledResendAdapter({ from: email?.from });

  const smsAdapter =
    sms?.enabled === true && sms?.accountSid && sms?.authToken
      ? createTwilioChannel({ accountSid: sms.accountSid, authToken: sms.authToken, from: sms.from })
      : dev
        ? createConsoleAdapter({ name: 'console-sms', kind: 'sms' })
        : createDisabledTwilioAdapter({ from: sms?.from });

  return { email: emailAdapter, sms: smsAdapter };
}
