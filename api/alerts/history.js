/**
 * GET /api/alerts/history?state=live — the alert history page.
 * GET /api/alerts/history?id=alr_...  — one alert's detail page.
 *
 * The `renderAlertHistory` UI (ALERT-ENGINE-PLAN.md §4 item 6) wired into
 * routing, as the plan's NEXT step prescribed: a tiny serverless adapter that
 * serves the standalone static HTML pages (zero JS, zero CSS framework), so
 * Brando can see them in a browser. History rows link to their detail page
 * with a relative `?id=` link, keeping one adapter file for the whole
 * history surface instead of a dynamic route segment.
 *
 * Same session rules as `/api/alerts`: a Bearer <redacted> — header, or the
 * `access_token` query fallback `bearer()` already honours for non-header
 * callers — or a 401. The `?state=` filter names a state or `all`; anything
 * else falls back to `all` inside the renderer. An unknown `?id=` (or one
 * belonging to another user) is a 404.
 */

import { alertDetail, alertHistory } from '@wax/core';
import { bearer, html, param, route } from '../_lib/http.js';

export default route({
  GET: (req, res) => {
    const token = bearer(req);
    const id = param(req, 'id');
    if (id) return html(res, 200, alertDetail(token, id));
    html(res, 200, alertHistory(token, { state: param(req, 'state') ?? 'all' }));
  },
});
