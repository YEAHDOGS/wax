/**
 * @file Billing receipts — what "you paid" looks like as an email.
 *
 * The $10/month Subscription Series is Wax's only sale, and every sale gets
 * a receipt. This module is the piece the launch-day webhook calls after
 * `activateSeries(userId, subscriptionId)`: it renders the receipt
 * (`renderReceiptEmail`, pure, zero dependencies) and sends it through the
 * existing channel seam (`sendBillingReceipt`) — the same `{ name, kind,
 * send(envelope) }` contract `dispatch.js` uses, so the fully-wired Resend
 * channel is one adapter away when Brando supplies `RESEND_API_KEY`.
 *
 * Posture, same as the checkout page (docs/CHECKOUT.md):
 *
 * - Test-mode receipts say plainly that no charge happened. A receipt that
 *   pretends money moved when it didn't is fraud.
 * - A missing email address on the user row is an `{ ok: false }` receipt
 *   (`no_email_on_file`), never a throw — the webhook must not fail an
 *   activation because the receipt couldn't go.
 * - The channel's own guards still apply: an invalid address or a disabled
 *   adapter returns its `{ ok: false }` receipt, no socket ever opened.
 */

import { PLANS, SERIES_CURRENCY, SERIES_PRICE_CENTS } from './billing.js';
import { assertChannel } from './dispatch.js';

/**
 * Format integer cents as dollars — `1000` → `"$10.00"`.
 *
 * @param {number} cents
 * @returns {string}
 */
export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Escape a user string for the HTML receipt body. Every user-supplied value
 * in the receipt (display name, session id) goes through this before it
 * touches HTML — receipts land in mail clients, the wrong place to learn
 * what an `onerror` attribute can do.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the receipt email for a confirmed series activation.
 *
 * Pure: no store, no adapters, no clock. Takes plain data so the webhook
 * can call it with a Stripe-session-shaped object too — it only reads
 * `id`, `mode`, `amount_cents`, and `currency`, never assuming the row
 * came from `checkoutSession`.
 *
 * The honest-receipt rule: the amount rendered is the amount on the
 * session (`amount_cents`), not the catalog price. If they ever differ,
 * the receipt shows what moved, not what the price list said.
 *
 * @param {{ name?: ?string, email?: ?string }} user Who paid (name/email only).
 * @param {{ id?: ?string, mode?: 'test'|'live', amount_cents?: number, currency?: string }} session What was confirmed.
 * @param {{ issuedAt?: string }} [opts] ISO timestamp to print; defaults to now.
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderReceiptEmail(user, session, { issuedAt = new Date().toISOString() } = {}) {
  const name = user?.name?.trim() || user?.display_name?.trim() || 'Wax listener';
  const amountCents = Number.isFinite(session?.amount_cents)
    ? session.amount_cents
    : SERIES_PRICE_CENTS;
  const currency = (session?.currency ?? SERIES_CURRENCY).toUpperCase();
  const mode = session?.mode === 'live' ? 'live' : 'test';
  const sessionId = session?.id ?? 'unknown';
  const planLine = PLANS.series.line;
  const amount = formatMoney(amountCents);
  const testNote =
    mode === 'test'
      ? '\n\nThis is a TEST receipt — no card was charged and no money moved. ' +
        'The subscription will activate for real when the live checkout is wired.'
      : '';
  const subject = `Wax receipt: ${PLANS.series.name} — ${amount}/${currency === 'USD' ? 'month' : currency}${mode === 'test' ? ' (test, no charge)' : ''}`;
  const text =
    `Hi ${name},\n\n` +
    `You're on the Subscription Series. ${planLine}\n\n` +
    `Amount: ${amount} ${currency}, billed monthly.\n` +
    `Receipt ID: ${sessionId}\n` +
    `Issued: ${issuedAt}\n\n` +
    `Cancel anytime — losing unlimited alerts never deletes your watches.${testNote}`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>You're on the <strong>${escapeHtml(PLANS.series.name)}</strong>. ${escapeHtml(planLine)}</p>` +
    `<p><strong>Amount:</strong> ${escapeHtml(amount)} ${escapeHtml(currency)}, billed monthly.<br>` +
    `<strong>Receipt ID:</strong> ${escapeHtml(sessionId)}<br>` +
    `<strong>Issued:</strong> ${escapeHtml(issuedAt)}</p>` +
    `<p>Cancel anytime — losing unlimited alerts never deletes your watches.</p>` +
    (mode === 'test'
      ? '<p><em>This is a TEST receipt — no card was charged and no money moved. ' +
        'The subscription will activate for real when the live checkout is wired.</em></p>'
      : '');
  return { subject, text, html };
}

/**
 * Send the receipt for a confirmed series activation through an email
 * channel, returning the channel's receipt.
 *
 * The channel honors the `dispatch.js` contract
 * (`{ name, kind, send(envelope) => Promise<receipt> }`) and is asserted at
 * call time — a broken channel is a loud `TypeError`, never a silent drop.
 * No email on the user row is an `{ ok: false }` receipt
 * (`no_email_on_file`), never a throw: the receipt is secondary to the
 * activation the webhook already recorded.
 *
 * @param {{ user: { email?: ?string, display_name?: ?string, name?: ?string }, session: { id?: ?string, mode?: 'test'|'live', amount_cents?: number, currency?: string }, emailChannel: object, nowMs?: number }} opts
 * @returns {Promise<object>} The channel receipt (`{ ok, channel, ... }`).
 */
export async function sendBillingReceipt({ user, session, emailChannel, nowMs } = {}) {
  const channel = assertChannel(emailChannel, 'email channel');
  const sentAt = new Date(nowMs ?? Date.now()).toISOString();
  const email = user?.email?.trim() ?? '';
  if (!email) {
    return { ok: false, channel: channel.name ?? 'email', error: 'no_email_on_file', sentAt };
  }
  const name = user?.display_name?.trim() || user?.name?.trim() || null;
  const message = renderReceiptEmail({ name, email }, session, { issuedAt: sentAt });
  const receipt = await channel.send({ alert: null, channel: channel.kind, to: email, message, nowMs });
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, channel: channel.name ?? 'email', error: 'malformed receipt from channel', sentAt };
  }
  return receipt;
}
