/**
 * @file Alert subscriptions — double-opt-in email/SMS drop alerts
 * (ALERT-ENGINE-PLAN.md §3, the NEXT step; the second money lane).
 *
 * Flow: `POST /api/alerts/subscribe` creates a `pending` subscription and
 * fires a confirmation message through the injected delivery channel.
 * `GET /api/alerts/confirm?token=` activates it. `POST
 * /api/alerts/unsubscribe` (token, or email/phone + filter) cancels it.
 * The confirm token doubles as the one-click unsubscribe token — the
 * plan's List-Unsubscribe flow — so it stays valid after confirmation.
 *
 * ## Identity
 *
 * Subscriptions are keyed by *address* (email/phone), not by session.
 * Someone can subscribe to drop alerts for an address they own without
 * holding a Wax account; the confirm token is the proof of ownership.
 * That is the whole of double opt-in: possession of the link proves
 * possession of the address.
 *
 * ## Delivery, never-throw
 *
 * The confirmation goes out through the existing provider adapters
 * (`createResendChannel` / `createTwilioChannel` in `dispatch.js`) when
 * the caller supplies a channel. When it does not — live keys are still
 * pending from Brando — the subscription is created anyway and a
 * `{ ok: false, error: 'provider keys pending' }` receipt is recorded on
 * the row. A throwing channel is caught into the same receipt shape.
 * This module never throws for a delivery problem; validation problems
 * throw {@link ApiError} like every other handler.
 *
 * ## Rate-limit guard
 *
 * Subscribes are throttled per recipient address
 * (`MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW` new subscribes per rolling
 * `SUBSCRIBE_WINDOW_MS`) — a few pending confirmations per address per
 * hour is plenty, more is list-bombing bait. Confirm attempts are capped
 * per presented token (`MAX_CONFIRM_ATTEMPTS_PER_WINDOW` failures per
 * rolling window) so unknown-token probing cannot brute-force the token
 * space. The eventual live sends are additionally gated by the notify
 * layer's `shouldDispatch` caps (`EMAIL_PER_HOUR_CAP` /
 * `SMS_PER_HOUR_CAP` in `notify.js`).
 *
 * Attempt counters live in the store's `subscribeAttempts` collection
 * (rows: `{ id, key, kind, at }`), so the in-memory store holds them
 * today and the Postgres swap inherits the guards with the
 * `subscribe_attempt` table — no handler changes either way.
 */

import { ApiError } from './handlers.js';
import { newId, newToken, store as defaultStore } from './store.js';

/** Channels a subscription can confirm and deliver over. */
export const SUBSCRIPTION_CHANNELS = ['email', 'sms'];

/** Lifecycle: pending (unconfirmed) → active → unsubscribed. */
export const SUBSCRIPTION_STATES = ['pending', 'active', 'unsubscribed'];

/** Top-level fields `subscribe` accepts. Anything else is a 400. */
const SUBSCRIBE_FIELDS = ['email', 'phone', 'channel', 'filter'];

/** Top-level fields `unsubscribe` accepts. Anything else is a 400. */
const UNSUBSCRIBE_FIELDS = ['token', 'email', 'phone', 'filter'];

/**
 * The release filter allowlist. A subscription watches drops matching all
 * of these; a field not on this list is rejected, never ignored — silently
 * dropping a criterion would lie about what the user signed up for.
 */
const FILTER_FIELDS = {
  artist_id: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64,
  title_contains: (v) => typeof v === 'string' && v.length > 0 && v.length <= 120,
  max_price_cents: (v) => Number.isInteger(v) && v > 0,
  source_id: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Where the confirm link points. Overridable per call for tests. */
export const DEFAULT_CONFIRM_BASE_URL = 'https://wax.wearedogs.net/api/alerts/confirm';

/**
 * New subscribes allowed per address per rolling window. Five new
 * pending confirmations an hour is generous for a human; a flood is
 * list-bombing.
 */
export const SUBSCRIBE_WINDOW_MS = 60 * 60 * 1000;
export const MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW = 5;

/** Failed confirms allowed per presented token per rolling window. */
export const CONFIRM_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CONFIRM_ATTEMPTS_PER_WINDOW = 10;

/**
 * Count recent attempts for a key/kind and prune expired rows. The
 * sliding window is computed from `nowMs`, so tests can pin the clock.
 *
 * @param {object} store
 * @param {string} kind 'subscribe' | 'confirm'
 * @param {string} key Address (subscribe) or presented token (confirm).
 * @param {number} windowMs
 * @param {number} nowMs
 * @returns {number} Attempts inside the window.
 */
async function recentAttempts(store, kind, key, windowMs, nowMs) {
  const cutoff = nowMs - windowMs;
  await store.subscribeAttempts.remove((a) => a.kind === kind && a.key === key && Date.parse(a.at) <= cutoff);
  return (await store.subscribeAttempts.filter((a) => a.kind === kind && a.key === key)).length;
}

/**
 * Refuse when the key has spent its attempt budget for the window.
 * Throws a 429 `ApiError` — not a 400 — because the request is well
 * formed; it just arrived too often.
 */
async function checkThrottle({ store, kind, key, windowMs, max, nowMs, what }) {
  const seen = await recentAttempts(store, kind, key, windowMs, nowMs);
  if (seen >= max) {
    throw new ApiError(
      429,
      'rate_limited',
      `Too many ${what} — try again in a bit (limit ${max} per hour).`,
    );
  }
}

/** Record a spent attempt (every recorded attempt was itself allowed). */
async function recordAttempt(store, kind, key, nowMs) {
  await store.subscribeAttempts.insert({
    id: newId('satt'),
    key,
    kind,
    at: new Date(nowMs).toISOString(),
  });
}

const badRequest = (code, message) => new ApiError(400, code, message);

function rejectUnknownFields(input, allowed, what) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw badRequest('unknown_field', `Unknown field "${key}" in ${what}.`);
    }
  }
}

function normalizeEmail(raw, { required }) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) {
    if (required) throw badRequest('missing_email', 'An email address is required for email alerts.');
    return null;
  }
  if (!EMAIL_RE.test(email)) throw badRequest('invalid_email', `"${email}" is not a valid email address.`);
  return email;
}

function normalizePhone(raw, { required }) {
  const phone = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (!phone) {
    if (required) throw badRequest('missing_phone', 'A phone number is required for SMS alerts.');
    return null;
  }
  if (!E164_RE.test(phone)) {
    throw badRequest('invalid_phone', `"${phone}" is not a valid phone number. Use E.164, e.g. +13125550123.`);
  }
  return phone;
}

/**
 * Validate a release filter against the allowlist. Returns a normalized
 * object with keys in sorted order (stable for the idempotency key), or
 * null when no filter was given (watch everything).
 */
function validateFilter(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('bad_filter', 'The filter must be an object like {"artist_id": "art_..."}.');
  }
  const filter = {};
  for (const key of Object.keys(raw).sort()) {
    const check = FILTER_FIELDS[key];
    if (!check) throw badRequest('unknown_field', `Unknown filter field "${key}".`);
    if (!check(raw[key])) throw badRequest('bad_filter', `Invalid value for filter field "${key}".`);
    filter[key] = raw[key];
  }
  return filter;
}

function describeFilter(filter) {
  if (!filter || Object.keys(filter).length === 0) return 'all new drops';
  const bits = [];
  if (filter.artist_id) bits.push(`artist ${filter.artist_id}`);
  if (filter.title_contains) bits.push(`titles containing "${filter.title_contains}"`);
  if (filter.max_price_cents != null) bits.push(`under $${(filter.max_price_cents / 100).toFixed(2)}`);
  if (filter.source_id) bits.push(`from ${filter.source_id}`);
  return bits.join(', ');
}

/**
 * The public shape of a subscription. The confirm token is deliberately
 * absent — it travels inside the confirmation message, never in a
 * response body, except on the dev path where no message was sent
 * (the adapter re-adds it there, clearly marked).
 */
function publicSubscription(sub, { duplicate = false } = {}) {
  return {
    id: sub.id,
    channel: sub.channel,
    email: sub.email,
    phone: sub.phone,
    filter: sub.filter,
    state: sub.state,
    duplicate,
    created_at: sub.created_at,
    confirmed_at: sub.confirmed_at,
  };
}

/**
 * Send the double-opt-in confirmation. Never throws: with no channel (live
 * keys still pending from Brando) or a throwing channel, the failure is
 * recorded as a receipt on the subscription row.
 */
async function sendConfirmation({ channel, recipient, sub, confirmBaseUrl, now }) {
  const confirmUrl = `${confirmBaseUrl}?token=${sub.confirm_token}`;
  const message = {
    subject: 'Confirm your Wax drop alerts',
    text:
      `You're one tap from Wax drop alerts for ${describeFilter(sub.filter)}.\n\n` +
      `Confirm: ${confirmUrl}\n\n` +
      `Didn't ask for this? Ignore it — nothing is subscribed until you confirm.\n` +
      `Unsubscribe anytime: ${confirmUrl}`,
  };
  const sentAt = new Date(now).toISOString();
  if (!channel || typeof channel.send !== 'function') {
    return {
      ok: false,
      channel: 'none',
      error:
        'provider keys pending — Brando has not supplied RESEND_API_KEY / ' +
        'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN yet, so the confirmation was not sent.',
      sentAt,
    };
  }
  try {
    const receipt = await channel.send({
      alert: null,
      channel: sub.channel,
      to: recipient,
      message,
      nowMs: now,
    });
    return { ...(receipt ?? {}), ok: receipt?.ok === true, sentAt: receipt?.sentAt ?? sentAt };
  } catch (err) {
    return {
      ok: false,
      channel: channel.name ?? 'unknown',
      error: `confirmation send failed: ${err?.message ?? String(err)}`,
      sentAt,
    };
  }
}

/**
 * Start a double-opt-in alert subscription.
 *
 * Idempotent: re-subscribing an active or pending subscription with the
 * same channel + recipient + filter returns the existing row
 * (`duplicate: true`) instead of creating a second one. Re-subscribing
 * after an unsubscribe starts a fresh `pending` subscription — a
 * cancelled address must re-confirm, always.
 *
 * @param {object} input `{ email?, phone?, channel: 'email'|'sms', filter? }`
 * @param {object} [deps]
 * @param {object} [deps.channel] Delivery channel (see module doc). Optional.
 * @param {string} [deps.confirmBaseUrl] Where the confirm link points.
 * @param {number} [deps.now]
 * @returns {Promise<{ subscription: object, confirm_token: string, delivered: boolean }>}
 */
export async function subscribeAlertChannel(
  input = {},
  { store = defaultStore, channel = null, confirmBaseUrl = DEFAULT_CONFIRM_BASE_URL, now = Date.now() } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('bad_request', 'Send a JSON object with email or phone, a channel, and an optional filter.');
  }
  rejectUnknownFields(input, SUBSCRIBE_FIELDS, 'the subscribe body');

  const kind = input.channel;
  if (kind !== 'email' && kind !== 'sms') {
    throw badRequest('bad_channel', 'channel must be "email" or "sms".');
  }
  const email = normalizeEmail(input.email, { required: kind === 'email' });
  const phone = normalizePhone(input.phone, { required: kind === 'sms' });
  const recipient = kind === 'email' ? email : phone;
  const filter = validateFilter(input.filter);
  const filterKey = JSON.stringify(filter ?? {});

  const existing = await store.subscriptions.find(
    (s) => s.channel === kind && s.recipient === recipient && s.filter_key === filterKey && s.state !== 'unsubscribed',
  );
  if (existing) return { subscription: publicSubscription(existing, { duplicate: true }), confirm_token: existing.confirm_token, delivered: existing.confirm_receipt?.ok === true };

  // Throttle before any new send: each new subscribe spends one attempt
  // for the address. Idempotent duplicates above return before this, so
  // re-posting the same subscription never burns budget or re-sends.
  await checkThrottle({
    store,
    kind: 'subscribe',
    key: `${kind}:${recipient}`,
    windowMs: SUBSCRIBE_WINDOW_MS,
    max: MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW,
    nowMs: now,
    what: 'subscription attempts for this address',
  });
  await recordAttempt(store, 'subscribe', `${kind}:${recipient}`, now);

  const sub = await store.subscriptions.insert({
    id: newId('sub'),
    email,
    phone,
    recipient,
    channel: kind,
    filter,
    filter_key: filterKey,
    state: 'pending',
    confirm_token: newToken(),
    confirm_receipt: null,
    created_at: new Date(now).toISOString(),
    confirmed_at: null,
    unsubscribed_at: null,
  });

  const receipt = await sendConfirmation({ channel, recipient, sub, confirmBaseUrl, now });
  await store.subscriptions.update((s) => s.id === sub.id, { confirm_receipt: receipt });

  return {
    subscription: publicSubscription(await store.subscriptions.find((s) => s.id === sub.id)),
    confirm_token: sub.confirm_token,
    delivered: receipt.ok === true,
  };
}

/**
 * Confirm a pending subscription (double opt-in). Idempotent: clicking the
 * link again on an active subscription returns it unchanged.
 *
 * Unknown tokens spend one confirm attempt each, capped per token per
 * rolling window (429 past the cap) — the token is the only credential
 * in this flow, so probing it must have a price. Valid tokens are never
 * counted: a real confirm, a repeat click, and a cancelled-link 410 are
 * all honest traffic.
 *
 * @param {?string} token The confirm token from the link.
 * @param {object} [deps]
 * @param {number} [deps.now]
 */
export async function confirmAlertSubscription(token, { store = defaultStore, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) {
    throw new ApiError(404, 'bad_token', 'That confirmation link is invalid or already used.');
  }
  const sub = await store.subscriptions.find((s) => s.confirm_token === token);
  if (!sub) {
    await checkThrottle({
      store,
      kind: 'confirm',
      key: token,
      windowMs: CONFIRM_WINDOW_MS,
      max: MAX_CONFIRM_ATTEMPTS_PER_WINDOW,
      nowMs: now,
      what: 'confirmation attempts with this token',
    });
    await recordAttempt(store, 'confirm', token, now);
    throw new ApiError(404, 'bad_token', 'That confirmation link is invalid or already used.');
  }
  if (sub.state === 'active') return publicSubscription(sub);
  if (sub.state === 'unsubscribed') {
    throw new ApiError(410, 'gone', 'This subscription was cancelled. Subscribe again for a fresh link.');
  }
  const updated = await store.subscriptions.update((s) => s.id === sub.id, {
    state: 'active',
    confirmed_at: new Date().toISOString(),
  });
  return publicSubscription(updated);
}

/**
 * Build the one-click unsubscribe URL that rides in alert emails as the
 * `List-Unsubscribe` header (RFC 2369) with `List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click` (RFC 8058). The confirm token doubles as
 * the unsubscribe token, so the URL points at the same
 * `POST /api/alerts/unsubscribe` endpoint — email clients POST to it
 * with an empty body and the token in the query string, which that route
 * accepts (see `api/alerts/unsubscribe.js`).
 *
 * Throws on a non-http(s) base or an empty token: a broken unsubscribe
 * link in a bulk email is a deliverability incident, not a cosmetic
 * issue — Gmail and Outlook both require working List-Unsubscribe.
 *
 * @param {string} baseUrl Absolute http(s) URL of the unsubscribe endpoint,
 *   e.g. `https://wax.wearedogs.net/api/alerts/unsubscribe`.
 * @param {string} token The subscription's confirm token.
 * @returns {string} `baseUrl?token=<encoded token>` (appends `&token=` if
 *   the base already carries a query string).
 */
export function buildUnsubscribeUrl(baseUrl, token) {
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new TypeError(`buildUnsubscribeUrl needs an absolute http(s) base URL, got ${String(baseUrl)}`);
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`buildUnsubscribeUrl needs an absolute URL, got ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(
      `buildUnsubscribeUrl refuses the ${parsed.protocol} scheme — only http(s) may carry an unsubscribe link`,
    );
  }
  if (typeof token !== 'string' || !token) {
    throw new TypeError('buildUnsubscribeUrl needs a non-empty unsubscribe token');
  }
  const sep = parsed.search ? '&' : '?';
  return `${parsed.toString()}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Cancel alert subscriptions. Identify by confirm token (one-click from a
 * message) or by email/phone + filter. Cancels every matching pending or
 * active subscription.
 */
export async function unsubscribeAlertChannel(input = {}, { store = defaultStore } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('bad_request', 'Send a JSON object with a token, or email/phone plus the filter.');
  }
  rejectUnknownFields(input, UNSUBSCRIBE_FIELDS, 'the unsubscribe body');

  let matches = [];
  if (typeof input.token === 'string' && input.token) {
    const sub = await store.subscriptions.find((s) => s.confirm_token === input.token);
    if (sub && sub.state !== 'unsubscribed') matches = [sub];
  } else {
    if (input.token != null) throw badRequest('bad_token', 'The token must be a string.');
    const email = input.email != null ? normalizeEmail(input.email, { required: false }) : null;
    const phone = input.phone != null ? normalizePhone(input.phone, { required: false }) : null;
    if (!email && !phone) throw badRequest('bad_request', 'Unsubscribe with a token, or with email/phone plus the filter.');
    const filter = validateFilter(input.filter);
    const filterKey = JSON.stringify(filter ?? {});
    matches = await store.subscriptions.filter(
      (s) =>
        s.state !== 'unsubscribed' &&
        s.filter_key === filterKey &&
        ((email && s.email === email) || (phone && s.phone === phone)),
    );
  }

  if (matches.length === 0) {
    throw new ApiError(404, 'not_found', 'No matching alert subscription.');
  }
  const unsubscribedAt = new Date().toISOString();
  for (const sub of matches) {
    await store.subscriptions.update((s) => s.id === sub.id, { state: 'unsubscribed', unsubscribed_at: unsubscribedAt });
  }
  return { ok: true, unsubscribed: matches.length };
}
