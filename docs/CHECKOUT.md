# Wax checkout — the money lane's front door

The $10/month **Subscription Series** is the only thing Wax sells, and this
is the page that sells it: `GET /api/checkout`.

## The flow (staging, today)

1. A signed-in user opens `GET /api/checkout` (Bearer <redacted>, same session
   rules as `/api/alerts/history`).
2. The page renders the plan card: **The Subscription Series — $10.00/month**,
   billed monthly, cancel anytime, 30 days free first (The Trial Pressing).
   The free plan (**The Single** — 3 artists, email only, free forever) sits
   beside it so the upgrade is a comparison, not a demand.
3. The user presses **Start the Subscription Series**. A small inline script
   POSTs `{ "mode": "test" }` to `/api/checkout` with the session bearer and
   renders the result.
4. The response is a **stub session** from `checkoutSession()` in
   `packages/core/src/billing.js` — `{ id, url, mode: 'test', plan: 'series',
   amount_cents: 1000, currency: 'usd', user_id, success_url, cancel_url }`.
   No provider, no keys, no network, no charge. The page says so, plainly.
5. Users already on `series` see a "you're on it" panel instead of a button —
   the POST would 409 `already_subscribed` anyway.

Pricing is stated exactly once (`PLANS` / `SERIES_PRICE_CENTS` in
`billing.js`); the page renders from it. The stub shape is the contract the
live provider must keep — `test-checkout-page.mjs` pins every field, so the
day the provider lands, the client and the tests don't move.

## Launch-day integration (Brando's steps — no code changes needed elsewhere)

All of this happens in `packages/core/src/billing.js`, behind
deployment-owned env vars. Nothing here is ever committed to the repo.

1. **Create the Stripe account** (planned provider; any subscription-capable
   provider fits the same seam) and make a $10.00/month USD recurring
   product. Copy the **price id**.
2. **Set the deployment env vars** (Vercel project settings, not the repo):
   `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_SERIES`, `STRIPE_WEBHOOK_SECRET`,
   `WAX_BASE_URL`.
3. **Wire `checkoutSession`'s `live` branch**: today it throws 501
   `billing_not_configured`. Replace that branch with a Stripe Checkout
   Session create call returning the same shape as the stub —
   `{ id, url, mode: 'live', plan: 'series', amount_cents: 1000,
   currency: 'usd', user_id, success_url, cancel_url }`. The page's inline
   script only needs `mode: 'test'` → `mode: 'live'` flipped once this
   works — the integration point is marked in `checkout-page.js`.
4. **Add the webhook endpoint** (new file, e.g. `api/billing/webhook.js`):
   verify the Stripe signature with `STRIPE_WEBHOOK_SECRET`, and on
   `checkout.session.completed` call `activateSeries(userId,
   subscriptionId)` — the only function allowed to move a user to `series`.
   Verify the session against `getCheckoutSession()` (stub registry today,
   Stripe session lookup after) before activating.
5. **Flip the page script** from `mode: 'test'` to `mode: 'live'` and
   redeploy. Staging keeps `test` forever; production is the only place
   `live` should ever be requested.

## Staging-only wiring (known, accepted)

- The page's inline script receives the session as `window.WAX_SESSION`,
  injected server-side after the bearer was validated. Acceptable for
  staging; production should move the session into an HttpOnly cookie and
  stop injecting it.
- Test sessions live in a module-level registry (`getCheckoutSession`),
  like provider state — they don't touch the store schema.
- The stub checkout URL (`https://checkout.wax.fm/test/<id>`) is a placeholder
  page that doesn't exist yet; the page labels it a stub so nobody mistakes
  it for a payment form.
