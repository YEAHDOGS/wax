/**
 * GET    /api/crate                       — the collection, joined to releases and spreads
 * POST   /api/crate                       — file a pressing
 * DELETE /api/crate?release_id=rel_...    — pull one out
 *
 * POST body: { "release_id": "rel_...", "condition": "NM", "paid_cents": 3200, "notes": "..." }
 *
 * Keyed on `release_id` rather than the crate item's own id, because a
 * pressing is in a crate at most once and the caller always knows the release.
 */

import { ApiError, addToCrate, listCrate, removeFromCrate } from '@wax/core';
import { bearer, json, param, readBody, route } from './_lib/http.js';

export default route({
  GET: (req, res) => json(res, 200, { crate: listCrate(bearer(req)) }),

  POST: async (req, res) => {
    const body = await readBody(req);
    if (!body.release_id) throw new ApiError(400, 'missing_release', 'Name the release to file.');
    json(res, 201, addToCrate(bearer(req), body));
  },

  DELETE: (req, res) => {
    const releaseId = param(req, 'release_id');
    if (!releaseId) throw new ApiError(400, 'missing_release', 'Name the release to remove.');
    json(res, 200, removeFromCrate(bearer(req), releaseId));
  },
});
