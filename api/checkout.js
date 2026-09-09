/**
 * /api/checkout — the money lane's front door, in two verbs.
 *
 * GET — the checkout page (docs/CHECKOUT.md): plan card, $10/month price,
 * cancel-anytime copy, and a subscribe button wired to the POST below.
 * Session bearer required, same as the alert-history page.
 *
 * POST body:
 *   { "mode": "test" | "live", "success_url": "...", "cancel_url": "..." }
 *
 * Auth is the session bearer, same as every other write endpoint. In `test`
 * mode (the default) the response is a stub session — no provider, no keys,
 * no network — so the subscribe flow can be built and rehearsed today.
 * `live` returns 501 `billing_not_configured` until the provider is wired in
 * `packages/core/src/billing.js`.
 *
 * The free-tier watch cap in /api/watches is the paywall; this endpoint is
 * the door through it.
 */

import { ApiError, checkoutPage, checkoutSession } from '@wax/core';
import { bearer, html, json, readBody, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => {
    html(res, 200, await checkoutPage(bearer(req)));
  },
  POST: async (req, res) => {
    const body = await readBody(req);
    const mode = body.mode ?? 'test';
    if (mode !== 'test' && mode !== 'live') {
      throw new ApiError(400, 'bad_mode', 'mode is "test" or "live".');
    }
    json(res, 201, await checkoutSession(bearer(req), {
      mode,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
    }));
  },
});
