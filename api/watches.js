/**
 * GET    /api/watches            — standing watch instructions, joined to artists
 * POST   /api/watches            — start watching an artist
 * DELETE /api/watches?id=wch_... — stop watching
 *
 * POST body:
 *   { "artist_id": "art_...", "merch_types": ["tee"], "target_price_cents": 6500,
 *     "channels": ["email", "push"] }
 *
 * A free account watching a fourth artist gets 402 with code `watch_limit`.
 * That is the paywall, and it is the only one in the product.
 */

import { ApiError, addWatch, listWatches, removeWatch } from '@wax/core';
import { bearer, json, param, readBody, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => json(res, 200, { watches: await listWatches(bearer(req)) }),

  POST: async (req, res) => {
    const body = await readBody(req);
    if (!body.artist_id) throw new ApiError(400, 'missing_artist', 'Name the artist to watch.');
    json(res, 201, await addWatch(bearer(req), body));
  },

  DELETE: async (req, res) => {
    const id = param(req, 'id');
    if (!id) throw new ApiError(400, 'missing_id', 'Name the watch to remove.');
    json(res, 200, await removeWatch(bearer(req), id));
  },
});
