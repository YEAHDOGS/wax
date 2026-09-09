/**
 * POST /api/alerts/unsubscribe — cancel alert subscriptions.
 *
 * Body: `{ token }` (one click from a message — the confirm token stays
 * valid for this after confirmation) or `{ email?, phone?, filter? }`.
 * The `?token=` query parameter is accepted too: that is the RFC 8058
 * one-click path — email clients POST the List-Unsubscribe URL with an
 * empty body, so the token has to ride in the URL. Body wins when both
 * are present.
 * Cancels every matching pending or active subscription; no match is a
 * 404. A cancelled address must re-subscribe and re-confirm to come
 * back — unsubscribing is never silently undone.
 */

import { unsubscribeAlertChannel } from '@wax/core';
import { json, param, readBody, route } from '../_lib/http.js';

export default route({
  POST: async (req, res) => {
    const body = await readBody(req);
    const token = typeof body.token === 'string' && body.token ? body.token : param(req, 'token');
    json(res, 200, await unsubscribeAlertChannel({ ...body, ...(token ? { token } : {}) }));
  },
});
