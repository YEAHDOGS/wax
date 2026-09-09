/**
 * POST /api/alerts/subscribe — start a double-opt-in alert subscription.
 *
 * Body: `{ email?, phone?, channel: "email"|"sms", filter? }`.
 * The filter is a release filter off the allowlist (`artist_id`,
 * `title_contains`, `max_price_cents`, `source_id`); unknown fields are
 * rejected, never ignored.
 *
 * Idempotent: re-subscribing an active or pending subscription with the
 * same channel + recipient + filter returns the existing record
 * (`duplicate: true`), no second row, no second confirmation.
 *
 * The confirmation goes out through the Resend/Twilio adapters when live
 * keys are present, and is never attempted without them — the adapters
 * refuse to construct keyless rather than fake a send. With no keys the
 * subscription is still created, a keys-pending receipt is logged on the
 * row, and the response carries the confirm token so the flow can be
 * exercised end to end today. Once live sends begin, production must
 * strip the token from this response: it travels inside the confirmation
 * message only.
 *
 * Rate-limit guard: subscribes are throttled per channel+address (5 new
 * subscribes per rolling hour — `MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW` in
 * src/subscriptions.js), with unknown confirm-token probes capped per
 * token (10/hour). Counters live in the store's `subscribeAttempts`
 * collection (`subscribe_attempt` in schema.sql), so the in-memory store
 * holds them today and the Postgres swap inherits them with the table.
 */

import { createResendChannel, createTwilioChannel, subscribeAlertChannel } from '@wax/core';
import { json, readBody, route } from '../_lib/http.js';

const FROM_EMAIL = process.env.WAX_ALERTS_FROM ?? 'alerts@wax.wearedogs.net';
const FROM_SMS = process.env.WAX_SMS_FROM ?? null;

/**
 * Build the confirmation channel for this kind of subscription, or null.
 * Never throws: without live keys there is no channel, and core logs a
 * keys-pending receipt instead of sending.
 */
function confirmationChannel(kind) {
  try {
    if (kind === 'sms') {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && FROM_SMS) {
        return createTwilioChannel({
          accountSid: process.env.TWILIO_ACCOUNT_SID,
          authToken: process.env.TWILIO_AUTH_TOKEN,
          from: FROM_SMS,
        });
      }
      return null;
    }
    if (process.env.RESEND_API_KEY) {
      return createResendChannel({ apiKey: process.env.RESEND_API_KEY, from: FROM_EMAIL });
    }
    return null;
  } catch {
    // A loud refusal from the adapter (bad config) stays a no-channel
    // receipt rather than a 500.
    return null;
  }
}

export default route({
  POST: async (req, res) => {
    const body = await readBody(req);
    const channel = confirmationChannel(body?.channel);
    const { subscription, confirm_token, delivered } = await subscribeAlertChannel(body, { channel });
    // Token in the response only while the confirmation was not actually
    // delivered (dev/key-pending path). With live sends it lives in the
    // message, never here.
    json(res, 200, delivered ? subscription : { ...subscription, confirm_token });
  },
});
