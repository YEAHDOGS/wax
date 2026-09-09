/**
 * GET /api/alerts/confirm?token= — complete double opt-in.
 *
 * The link inside the confirmation message lands here. Idempotent:
 * clicking twice on an active subscription returns it unchanged.
 * A bad or unknown token is a 404 (no oracle: the same response whether
 * the token never existed or belongs to someone else's address); a
 * cancelled subscription is a 410.
 *
 * The token rides the query string because it arrives as a link. It is a
 * single-use capability for confirmation and the ongoing one-click
 * unsubscribe token, not a session — it authenticates nothing else.
 */

import { confirmAlertSubscription } from '@wax/core';
import { json, param, route } from '../_lib/http.js';

export default route({
  GET: async (req, res) => {
    json(res, 200, await confirmAlertSubscription(param(req, 'token')));
  },
});
