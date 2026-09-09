/**
 * GET  /api/alerts?state=live   — the alert board, joined and filtered
 * POST /api/alerts              — act on an alert
 *
 * POST body:
 *   { "action": "read",  "id": "alr_..." }
 *   { "action": "catch", "id": "alr_...", "condition": "M", "paid_cents": 8400 }
 *
 * Actions are a body field rather than separate nested routes, because
 * `/api/alerts/[id]/catch.js` buys nothing here except two more files and a
 * dynamic segment to parse.
 *
 * `catch` is the important one: it marks the alert caught *and* files the
 * pressing in the crate, in one call, because an alert that reads "caught"
 * while the record is missing from the crate is how a collector stops trusting
 * the app.
 */

import { ApiError, alertCounts, catchAlert, listAlerts, markAlertRead } from '@wax/core';
import { bearer, json, param, readBody, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => {
    const token = bearer(req);
    json(res, 200, {
      alerts: await listAlerts(token, { state: param(req, 'state') ?? 'all' }),
      counts: await alertCounts(token),
    });
  },

  POST: async (req, res) => {
    const token = bearer(req);
    const { action, id, condition, paid_cents } = await readBody(req);
    if (!id) throw new ApiError(400, 'missing_id', 'Name the alert to act on.');

    switch (action) {
      case 'read':
        return json(res, 200, await markAlertRead(token, id));
      case 'catch':
        return json(res, 200, await catchAlert(token, id, { condition, paid_cents }));
      default:
        throw new ApiError(400, 'bad_action', `Unknown action "${action}". Use "read" or "catch".`);
    }
  },
});
