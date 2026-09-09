/**
 * @file Alert delivery content for the alert engine (plan §3).
 *
 * Resend (email) and Twilio (SMS) do the actual sending later — this module
 * owns everything that can be decided offline: what the message *says* and
 * whether it is allowed to leave right now.
 *
 * Two rules from docs/ALERT-ENGINE-PLAN.md:
 *
 * 1. Alert content carries artist, title, price, source link, and a "buy"
 *    deep link. Nothing else is needed to act on a drop; nothing more is
 *    sent.
 * 2. Per-user rate limiting: a restock flood must not send 40 texts. When
 *    the cap is hit, `shouldDispatch` says so and the excess folds into the
 *    next digest instead of being dropped.
 *
 * Free tier (plan §5): email alerts only. The $10/mo series unlocks SMS.
 * That gate lives here, in one place, not scattered through call sites.
 */

/** Maximum SMS a user receives per hour before the rest defer to digest. */
export const SMS_PER_HOUR_CAP = 10;

/** Maximum emails a user receives per hour before the rest defer to digest. */
export const EMAIL_PER_HOUR_CAP = 60;

/**
 * @param {?number} cents
 * @returns {string} e.g. `"$34.99"`, or `"—"` when the price is unknown.
 */
export function formatPrice(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

const KIND_LABEL = {
  drop: 'New drop',
  price: 'Price drop',
  restock: 'Back in stock',
  merch: 'New merch',
};

/**
 * Compose the email for one alert.
 *
 * @param {object} input
 * @param {import('./types.js').Alert} input.alert
 * @param {string} input.artistName
 * @param {string} input.releaseTitle
 * @param {?string} [input.variant]
 * @param {?string} [input.sourceLabel]
 * @returns {{ subject: string, text: string }}
 */
export function formatDropEmail({ alert, artistName, releaseTitle, variant = null, sourceLabel = null }) {
  const kind = KIND_LABEL[alert.kind] ?? 'Alert';
  const price = formatPrice(alert.price_cents);
  const buy = alert.listing_url ?? 'https://wax.wearedogs.net/alerts';
  const subject = `${kind}: ${artistName} — ${releaseTitle} (${price})`;
  const lines = [
    `${kind} on Wax.`,
    '',
    `Artist: ${artistName}`,
    `Title:  ${releaseTitle}${variant ? ` (${variant})` : ''}`,
    `Price:  ${price}`,
    sourceLabel ? `Source: ${sourceLabel}` : null,
    '',
    `Buy: ${buy}`,
    '',
    'You are watching this artist on Wax. Reply STOP to mute these emails.',
  ].filter((l) => l !== null);
  return { subject, text: lines.join('\n') };
}

/**
 * Compose the SMS for one alert. Kept under 160 GSM characters so it ships
 * as a single segment — long texts cost double on Twilio.
 *
 * @param {object} input Same shape as {@link formatDropEmail}.
 * @returns {string}
 */
export function formatDropSms({ alert, artistName, releaseTitle, sourceLabel = null }) {
  const price = formatPrice(alert.price_cents);
  const where = sourceLabel ? ` @ ${sourceLabel}` : '';
  const core = `${artistName} — ${releaseTitle} (${price})${where}`;
  const url = alert.listing_url ? ` ${shorten(alert.listing_url)}` : '';
  const msg = `Wax: ${core}${url}`;
  return msg.length <= 160 ? msg : `${msg.slice(0, 157)}…`;
}

/**
 * Collapse a long listing URL to something readable in one segment.
 * Only ever used for display; the email always carries the full link.
 * @param {string} url
 */
function shorten(url) {
  const cut = url.replace(/^https?:\/\//, '');
  return cut.length > 32 ? `${cut.slice(0, 29)}…` : cut;
}

/**
 * Fold several alerts into one email digest — the fallback when the rate
 * cap bites, and the shape free-tier users get by default.
 *
 * @param {object} input
 * @param {Array<{ alert: import('./types.js').Alert, artistName: string, releaseTitle: string, sourceLabel: ?string }>} input.items
 * @param {string} input.windowLabel e.g. `'the last hour'`
 * @returns {{ subject: string, text: string }}
 */
export function formatDigest({ items, windowLabel }) {
  const subject = `Wax digest: ${items.length} alert${items.length === 1 ? '' : 's'} in ${windowLabel}`;
  const lines = [`${items.length} new alert${items.length === 1 ? '' : 's'} in ${windowLabel}:`, ''];
  for (const { alert, artistName, releaseTitle, sourceLabel } of items) {
    const kind = KIND_LABEL[alert.kind] ?? 'Alert';
    lines.push(
      `• ${kind}: ${artistName} — ${releaseTitle} (${formatPrice(alert.price_cents)})${sourceLabel ? ` @ ${sourceLabel}` : ''}`,
      `  ${alert.listing_url ?? 'https://wax.wearedogs.net/alerts'}`,
    );
  }
  lines.push('', 'Manage your watches: https://wax.wearedogs.net/watches');
  return { subject, text: lines.join('\n') };
}

/**
 * Decide whether an alert message may leave right now.
 *
 * Counts what this user already received in the trailing window
 * (`window_ms`, default one hour). When the cap for the channel is hit,
 * dispatch is deferred — the alert folds into the next digest, never dropped
 * silently and never sent as message number 41.
 *
 * SMS is series-only: a free-tier SMS request is denied outright so the
 * provider is never billed for a plan that does not cover it.
 *
 * @param {object} input
 * @param {import('./types.js').Channel} input.channel
 * @param {'free'|'trial'|'series'} input.plan
 * @param {{ channel: import('./types.js').Channel, sent_at: string }[]} input.sentThisWindow
 * @param {number} [input.window_ms]
 * @param {number} [input.now]
 * @returns {{ dispatch: boolean, reason: string }}
 */
export function shouldDispatch({ channel, plan, sentThisWindow, window_ms = 3600_000, now = Date.now() }) {
  if (channel === 'sms' && plan === 'free') {
    return { dispatch: false, reason: 'sms is a $10/mo series feature — queued for the email digest instead' };
  }
  const cutoff = now - window_ms;
  const recent = sentThisWindow.filter((s) => s.channel === channel && Date.parse(s.sent_at) >= cutoff);
  const cap = channel === 'sms' ? SMS_PER_HOUR_CAP : EMAIL_PER_HOUR_CAP;
  if (recent.length >= cap) {
    return { dispatch: false, reason: `rate cap hit (${cap}/${channel}/hour) — folding into the next digest` };
  }
  return { dispatch: true, reason: 'ok' };
}
