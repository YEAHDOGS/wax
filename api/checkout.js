/**
 * POST /api/checkout — create a checkout session for the $10/month series.
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

import { ApiError, checkoutSession } from '@wax/core';
import { bearer, json, readBody, route } from './_lib/http.js';

export default route({
  POST: async (req, res) => {
    const body = await readBody(req);
    const mode = body.mode ?? 'test';
    if (mode !== 'test' && mode !== 'live') {
      throw new ApiError(400, 'bad_mode', 'mode is "test" or "live".');
    }
    json(res, 201, checkoutSession(bearer(req), {
      mode,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
    }));
  },
});
