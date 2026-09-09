/**
 * GET /api/releases            — the catalog, newest pressing first
 * GET /api/releases?id=rel_... — one pressing, with its spread and any tracks
 *
 * `id` also accepts a catalog number, so `/api/releases?id=WAX%204112` works.
 * Catalog numbers are what the design system prints on every surface, which
 * makes them the identifier a person actually has to hand.
 *
 * Public: no token required. The catalog is not private.
 */

import { getRelease, listReleases } from '@wax/core';
import { json, param, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => {
    const id = param(req, 'id');
    if (id) return json(res, 200, await getRelease(id));
    return json(res, 200, {
      releases: await listReleases({
        artist_id: param(req, 'artist_id') ?? undefined,
        limit: Number(param(req, 'limit')) || undefined,
      }),
    });
  },
});
