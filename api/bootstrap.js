/**
 * GET /api/bootstrap
 *
 * Everything the app needs at launch, in one response: user, profile, alert
 * board, alert counts, crate, watches, price watch, and the player catalog.
 *
 * This exists because a cold start otherwise fires six requests before it can
 * draw a single pixel. On a phone that is the difference between an app that
 * feels instant and one that feels like a website.
 *
 * Track URLs come back pointed at `/api/stream` rather than at the origin, so
 * the client never learns where the bytes actually live.
 */

import { bootstrap } from '@wax/core';
import { bearer, json, route } from './_lib/http.js';

export default route({
  GET: (req, res) => json(res, 200, bootstrap(bearer(req), { streamBase: '/api/stream' })),
});
