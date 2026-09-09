/**
 * POST /api/alerts/unsubscribe — cancel alert subscriptions.
 *
 * Body: `{ token }` (one click from a message — the confirm token stays
 * valid for this after confirmation) or `{ email?, phone?, filter? }`.
 * Cancels every matching pending or active subscription; no match is a
 * 404. A cancelled address must re-subscribe and re-confirm to come
 * back — unsubscribing is never silently undone.
 */

import { unsubscribeAlertChannel } from '@wax/core';
import { json, readBody, route } from '../_lib/http.js';

export default route({
  POST: async (req, res) => {
    const body = await readBody(req);
    json(res, 200, unsubscribeAlertChannel(body));
  },
});
