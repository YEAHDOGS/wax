/**
 * GET   /api/tracks  — the player's catalog, in running order
 * PATCH /api/tracks  — record a track's true duration
 *
 * PATCH body: { "id": "trk_...", "duration_sec": 214 }
 *
 * The seed ships `duration_sec: null` on every track, because nothing had
 * decoded the files yet. The player reports the real value the first time it
 * loads one, so the column fills itself in through use. No batch job, no
 * transcode step, no duration column that quietly disagrees with the file.
 */

import { ApiError, listTracks, setTrackDuration } from '@wax/core';
import { json, readBody, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => json(res, 200, { tracks: await listTracks({ streamBase: '/api/stream' }) }),

  PATCH: async (req, res) => {
    const { id, duration_sec } = await readBody(req);
    if (!id) throw new ApiError(400, 'missing_id', 'Name the track.');
    json(res, 200, await setTrackDuration(id, duration_sec));
  },
});
