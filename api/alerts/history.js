/**
 * GET /api/alerts/history?state=live — the alert history page.
 *
 * The `renderAlertHistory` UI (ALERT-ENGINE-PLAN.md §4 item 6) wired into
 * routing, as the plan's NEXT step prescribed: a tiny serverless adapter that
 * serves the standalone static HTML page (zero JS, zero CSS framework), so
 * Brando can see it in a browser.
 *
 * Same session rules as `/api/alerts`: a Bearer <redacted> — header, or the
 * `access_token` query fallback `bearer()` already honours for non-header
 * callers — or a 401. The `?state=` filter names a state or `all`; anything
 * else falls back to `all` inside the renderer.
 */

import { alertHistory } from '@wax/core';
import { bearer, html, param, route } from '../_lib/http.js';

export default route({
  GET: (req, res) => {
    const token = bearer(req);
    html(res, 200, alertHistory(token, { state: param(req, 'state') ?? 'all' }));
  },
});
