/**
 * @file Checkout page (the money lane's front door).
 *
 * `POST /api/checkout` (in `billing.js` / `api/checkout.js`) already creates a
 * checkout session — this file is the page that gets the user to press the
 * button. Pure render logic, same static-HTML contract as `alert-history.js`:
 * one self-contained document, no CSS framework, no network on load.
 *
 * The button does need one network call — creating the session — so this page
 * carries a small inline script (the only JS on the page) that POSTs to
 * `/api/checkout` and renders the stub session. The handler that serves this
 * page already validated the session bearer, so it hands it back to the page
 * as `window.WAX_SESSION` — staging-only wiring. Production should move the
 * session into an HttpOnly cookie and drop the injected token; see
 * `docs/CHECKOUT.md`.
 *
 * Pricing lives in `billing.js` (`PLANS`, `SERIES_PRICE_CENTS`) and this page
 * reads from it — the money sentence is stated once and rendered here.
 */

import { PLANS, SERIES_PRICE_CENTS, SERIES_CURRENCY, TRIAL_DAYS } from './billing.js';

/**
 * Escape a value for safe inclusion in HTML text or an attribute.
 *
 * @param {*} value
 * @returns {string}
 */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Session tokens come from `newToken()` (URL-safe alphabet), but this page
 * embeds one inside a `<script>` block, so the charset is pinned explicitly.
 * Anything outside `[A-Za-z0-9_-]` refuses to render the button script —
 * a corrupt token must break loudly, not inject.
 *
 * @param {?string} token
 * @returns {?string}
 */
const safeSession = (token) =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(token) ? token : null;

/**
 * @param {number} cents
 * @returns {string}
 */
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

const INCLUDED = [
  'Unlimited artists — every pressing you will ever chase',
  'Unlimited merch sites — every store that carries them',
  'SMS alerts the minute a drop lands, plus email',
  'Price-drop and restock alerts on your whole wantlist',
  'Full alert history, per-state filters',
];

const FREE_INCLUDED = [
  'Three artists, watched properly',
  'Email alerts only — SMS stays behind the paywall',
  'Free forever, no card, no trial',
];

/**
 * Render the checkout page for one user as a standalone HTML document.
 *
 * @param {object} user The session user (`requireUser` row): `{ id, plan, trial_ends_at, display_name }`.
 * @param {object} [opts]
 * @param {?string} [opts.token] The validated session bearer, re-handed to the
 *   inline button script. Must be URL-safe; garbage refuses the script.
 * @returns {string} A complete HTML document.
 */
export function renderCheckoutPage(user, { token = null } = {}) {
  const plan = PLANS[user?.plan] ?? PLANS.free;
  const series = PLANS.series;
  const free = PLANS.free;
  const onSeries = user?.plan === 'series';
  const session = safeSession(token);

  const trialLine =
    user?.plan === 'trial' && user?.trial_ends_at
      ? `<p class="note">Your trial pressing runs through <strong>${esc(
          String(user.trial_ends_at).slice(0, 10),
        )}</strong> — then ${money(series.priceCents)}/month, or walk away.</p>`
      : '';

  const action = onSeries
    ? `<div class="done" role="status">
         <p><strong>You&rsquo;re on the Subscription Series.</strong></p>
         <p class="note">This account already pays ${money(series.priceCents)}/month. There is nothing left to buy here.</p>
       </div>`
    : `<form id="checkout" action="#" onsubmit="return false;">
         <button id="buy" type="button" ${session ? '' : 'disabled'}>
           ${user?.plan === 'trial' ? 'Keep the series after my trial' : 'Start the Subscription Series'}
         </button>
         <p class="note">Starts with ${TRIAL_DAYS} days free. ${money(
           series.priceCents,
         )}/${series.interval} after that. Cancel anytime — your alerts stop at the end of the paid month, nothing else changes.</p>
       </form>
       <div id="result" role="status" aria-live="polite"></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wax &mdash; ${esc(series.name)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #111; color: #f2f2f2; margin: 0; padding: 2rem 1rem; }
  main { max-width: 42rem; margin: 0 auto; }
  .cards { display: grid; gap: 1rem; grid-template-columns: 1fr; }
  @media (min-width: 42rem) { .cards { grid-template-columns: 1.2fr 1fr; } }
  .card { border: 1px solid #333; border-radius: 12px; padding: 1.5rem; background: #181818; }
  .card.hot { border-color: #d4a017; background: #1d1a12; }
  .price { font-size: 2.5rem; font-weight: 800; margin: .5rem 0; }
  .price small { font-size: 1rem; font-weight: 400; color: #aaa; }
  ul { padding-left: 1.25rem; line-height: 1.7; }
  button { font-size: 1.1rem; font-weight: 700; padding: .9rem 1.6rem; border: 0; border-radius: 999px; background: #d4a017; color: #111; cursor: pointer; }
  button:disabled { background: #444; color: #999; cursor: not-allowed; }
  .note { color: #aaa; font-size: .9rem; line-height: 1.6; }
  .done { border: 1px solid #2e7d32; border-radius: 12px; padding: 1.5rem; background: #142114; }
  .stub { border: 1px dashed #d4a017; border-radius: 12px; padding: 1rem; margin-top: 1rem; word-break: break-all; }
  .err { color: #ff8a80; }
  a { color: #d4a017; }
  h1 { margin-top: 0; }
</style>
</head>
<body>
<main>
  <h1>The Subscription Series</h1>
  <p class="note">Wax watches every store for every record you care about. Three artists are free forever &mdash; this is the unlimited version.</p>
  <div class="cards">
    <section class="card hot" aria-label="Subscription Series plan">
      <h2>${esc(series.name)}</h2>
      <p class="price">${esc(money(series.priceCents))}<small>/${esc(series.interval ?? '')} ${esc(series.currency ?? '').toUpperCase()}</small></p>
      <p>${esc(series.line)}</p>
      <ul>
        ${INCLUDED.map((i) => `<li>${esc(i)}</li>`).join('\n        ')}
      </ul>
    </section>
    <section class="card" aria-label="Free plan">
      <h2>${esc(free.name)}</h2>
      <p class="price">${esc(money(free.priceCents))}<small> forever</small></p>
      <p>${esc(free.line)}</p>
      <ul>
        ${FREE_INCLUDED.map((i) => `<li>${esc(i)}</li>`).join('\n        ')}
      </ul>
    </section>
  </div>
  <h2>Checkout</h2>
  <p class="note">Signed in as <strong>${esc(user?.display_name ?? user?.id ?? 'unknown')}</strong> &mdash; currently on <strong>${esc(plan.name)}</strong>.</p>
  ${trialLine}
  ${action}
  <p class="note">Cancel anytime from your profile &mdash; no dark patterns, no retention maze. The free plan keeps working either way.</p>
</main>
<script>
/**
 * STAGING WIRING — the session below was validated server-side before this
 * page was rendered. Production moves this into an HttpOnly cookie.
 * Integration point for the real provider: swap 'test' for 'live' in the
 * body once docs/CHECKOUT.md's launch-day steps are done.
 */
window.WAX_SESSION = ${JSON.stringify(session)};
(function () {
  var btn = document.getElementById('buy');
  var out = document.getElementById('result');
  if (!btn || !out) return;
  btn.addEventListener('click', function () {
    if (!window.WAX_SESSION) {
      out.innerHTML = '<p class="err">No session to check out with. Sign in again and reload.</p>';
      return;
    }
    btn.disabled = true;
    out.innerHTML = '<p class="note">Creating your checkout session&hellip;</p>';
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.WAX_SESSION },
      body: JSON.stringify({ mode: 'test' }),
    }).then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status !== 201) {
          out.innerHTML = '<p class="err">Checkout refused (' + res.status + '): ' +
            String(res.body && res.body.message || res.body && res.body.code || 'unknown') + '</p>';
          btn.disabled = false;
          return;
        }
        var s = res.body;
        out.innerHTML = '<div class="stub" role="status"><p><strong>Test checkout session created.</strong></p>' +
          '<p class="note">This is the stub &mdash; no provider, no keys, no charge. Production redirects here to the real payment page.</p>' +
          '<p>session <code>' + s.id + '</code> &middot; ' + s.amount_cents / 100 + ' ' + String(s.currency).toUpperCase() + '/' + s.plan + '</p>' +
          '<p><a href="' + s.url + '">Open the (stub) payment page</a></p></div>';
      })
      .catch(function (e) {
        out.innerHTML = '<p class="err">Network error: ' + String(e && e.message || e) + '</p>';
        btn.disabled = false;
      });
  });
})();
</script>
</body>
</html>`;
}
