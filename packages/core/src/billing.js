/**
 * @file Billing: the money lane. Plans, trials, and checkout sessions.
 *
 * ## Why this file exists
 *
 * Wax's revenue is one sentence long: three artists free forever, unlimited
 * for $10/month, 30-day trial in between. That sentence has to live in exactly
 * one place so the web client, the mobile app, and the serverless API all
 * agree on it. That place is here.
 *
 * ## What this file is not
 *
 * It is not a payment integration. There are no provider SDKs here, no API
 * keys, no secrets — on purpose. `checkoutSession` has two modes:
 *
 * - `mode: 'test'` returns a fully-formed stub session so the client can build
 *   and rehearse the whole subscribe flow end to end with no credentials at
 *   all. This is the mode every developer uses until launch day.
 * - `mode: 'live'` throws `billing_not_configured` until a provider
 *   (Stripe is the planned one) is wired behind an env var the deployment —
 *   not this repo — owns.
 *
 * When the provider lands, it lands as one new function in this file, and the
 * client never changes shape. The stub is the contract the real thing must
 * keep.
 *
 * ## The lifecycle, in three functions
 *
 * 1. `startTrial(userId)` — `free` -> `trial`, stamped with `trial_ends_at`
 *    exactly 30 days out. One trial per user, ever: `trial` and `series` both
 *    throw `trial_already_used`.
 * 2. `expireTrials(store)` — the sweeper. Any `trial` past `trial_ends_at`
 *    falls back to `free`. Run it on a schedule (hourly is plenty).
 * 3. `activateSeries(userId, externalId)` — `trial|free` -> `series` once the
 *    provider confirms payment. Only the webhook path calls this.
 *
 * ## Errors
 *
 * Handlers throw {@link ApiError}. The `/api/checkout` adapter maps `.status`
 * onto the HTTP response the same way the rest of the API does.
 */

import { store as defaultStore, newToken } from './store.js';
import { ApiError, requireUser } from './handlers.js';

/** $10.00/month, in the smallest unit money has. */
export const SERIES_PRICE_CENTS = 1000;

/** The currency every price in this file is quoted in. */
export const SERIES_CURRENCY = 'usd';

/** How long a trial lasts before it falls back to `free`. */
export const TRIAL_DAYS = 30;

/** The catalog the pricing page renders — keep in lockstep with `apps/web/src/data/catalog.ts#plans`. */
export const PLANS = {
  free: {
    id: 'free',
    name: 'The Single',
    priceCents: 0,
    interval: null,
    line: 'Three artists, watched properly.',
  },
  trial: {
    id: 'trial',
    name: 'The Trial Pressing',
    priceCents: 0,
    interval: null,
    line: `Thirty days of everything. $${SERIES_PRICE_CENTS / 100}/month after, or walk away.`,
  },
  series: {
    id: 'series',
    name: 'The Subscription Series',
    priceCents: SERIES_PRICE_CENTS,
    interval: 'month',
    currency: SERIES_CURRENCY,
    line: 'Every artist you have ever meant to follow.',
  },
};

/** @typedef {'free'|'trial'|'series'} Plan */

/**
 * Start the one 30-day trial a user ever gets.
 *
 * @param {string} token The signed-in user's session bearer.
 * @param {{ store?: object }} [opts]
 * @returns {object} The updated user row: `{ id, plan: 'trial', trial_ends_at }`.
 * @throws {ApiError} 404 `not_found` when the user does not exist;
 *   409 `trial_already_used` when the user is already on `trial` or `series`.
 */
export function startTrial(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  if (user.plan === 'trial' || user.plan === 'series') {
    throw new ApiError(409, 'trial_already_used', 'This account already used its trial.');
  }
  const trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return store.users.update((u) => u.id === user.id, { plan: 'trial', trial_ends_at });
}

/**
 * Sweep expired trials back to `free`. Run on a schedule; idempotent.
 *
 * @param {{ store?: object }} [opts]
 * @returns {number} How many trials expired in this pass.
 */
export function expireTrials({ store = defaultStore } = {}) {
  const now = new Date().toISOString();
  const expired = store.users.filter(
    (u) => u.plan === 'trial' && u.trial_ends_at && u.trial_ends_at <= now,
  );
  for (const u of expired) {
    store.users.update((row) => row.id === u.id, { plan: 'free', trial_ends_at: null });
  }
  return expired.length;
}

/**
 * The plan the dispatch path actually enforces for this user, right now.
 *
 * Lives in `./plan.js` (a leaf module — billing cannot be imported from
 * `handlers.js` without a cycle, since billing already imports handlers
 * for `ApiError`/`requireUser`). Re-exported here so the public API stays
 * `import { effectivePlan } from './billing.js'`.
 */
export { effectivePlan } from './plan.js';

/**
 * Mark a user paid-up. Called only from the payment provider's webhook after
 * the charge is confirmed — never directly from client code.
 *
 * @param {string} token The signed-in user's session bearer.
 * @param {string} externalId The provider's subscription id (Stripe `sub_*`).
 * @param {{ store?: object }} [opts]
 * @returns {object} The updated user row.
 * @throws {ApiError} 404 `not_found` when the user does not exist.
 */
export function activateSeries(token, externalId, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return store.users.update((u) => u.id === user.id, {
    plan: 'series',
    trial_ends_at: null,
    external_subscription_id: externalId,
  });
}

/**
 * Create a checkout session for the $10/month series.
 *
 * In `test` mode (the default) this returns a stub — no network, no keys, no
 * provider — so the subscribe flow can be built and rehearsed today. The stub
 * is deliberately shaped like a real provider session: `id`, `url`, `amount`,
 * `currency`, `mode`, and `plan` are the contract the live implementation
 * must keep.
 *
 * In `live` mode it throws `billing_not_configured`. Wiring the provider is
 * launch-day work and it happens in this file, behind a deployment-owned env
 * var — never a value committed to this repo.
 *
 * @param {string} token The signed-in user's session bearer.
 * @param {{ mode?: 'test'|'live', successUrl?: string, cancelUrl?: string, store?: object }} [opts]
 * @returns {{ id: string, url: string, mode: 'test'|'live', plan: string, amount_cents: number, currency: string, user_id: string }}
 * @throws {ApiError} 404 `not_found` when the user does not exist;
 *   409 `already_subscribed` when the user is already on `series`;
 *   501 `billing_not_configured` in `live` mode until a provider is wired.
 */
export function checkoutSession(token, { mode = 'test', successUrl, cancelUrl, store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  if (user.plan === 'series') {
    throw new ApiError(409, 'already_subscribed', 'This account is already on the Subscription Series.');
  }
  if (mode === 'live') {
    throw new ApiError(
      501,
      'billing_not_configured',
      'Live checkout is not wired yet. This is launch-day work, not a bug.',
    );
  }
  const id = `testcs_${newToken().slice(0, 24)}`;
  const session = {
    id,
    url: `https://checkout.wax.fm/test/${id}`,
    mode: 'test',
    plan: 'series',
    amount_cents: SERIES_PRICE_CENTS,
    currency: SERIES_CURRENCY,
    user_id: user.id,
    success_url: successUrl ?? null,
    cancel_url: cancelUrl ?? null,
  };
  // The stub has to be retrievable later, the way a provider dashboard would
  // be — so it goes in a module-level registry, not the store. (The store's
  // collections mirror the seed schema; checkout sessions are provider state.)
  sessionRegistry.set(id, { ...session, created_at: new Date().toISOString() });
  return session;
}

/**
 * Look a test-mode session back up by id. The shape the webhook simulator —
 * and later the real webhook handler — verifies against.
 *
 * @param {string} id
 * @returns {object|undefined} The session, or `undefined` when unknown.
 */
export function getCheckoutSession(id) {
  return sessionRegistry.get(id);
}

/** @type {Map<string, object>} */
const sessionRegistry = new Map();
