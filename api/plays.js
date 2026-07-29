/**
 * POST /api/plays
 *
 * Body: { "track_id": "trk_..." }
 *
 * Records that a track was played. Feeds the activity list on a profile and,
 * later, the taste matching that the social layer is built on.
 *
 * Fire-and-forget from the player's point of view: it is called when playback
 * actually starts, never awaited, and a failure here must never interrupt
 * audio. The player drops the error on the floor on purpose.
 */

import { ApiError, recordPlay } from '@wax/core';
import { bearer, json, readBody, route } from './_lib/http.js';

export default route({
  POST: async (req, res) => {
    const { track_id } = await readBody(req);
    if (!track_id) throw new ApiError(400, 'missing_track', 'Name the track that played.');
    json(res, 200, recordPlay(bearer(req), track_id));
  },
});
