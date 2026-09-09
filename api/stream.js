/**
 * GET /api/stream?track=trk_hollywood
 *
 * Streams a track's audio, proxied from wherever the bytes actually live.
 *
 * ## Why proxy at all
 *
 * The origin (`data.wearedogs.net`) serves the audio correctly but sends no
 * `Access-Control-Allow-Origin`. A plain `<audio src>` does not care — media
 * elements are exempt from CORS for playback. But the moment the player wants
 * a **waveform**, it has to run the file through `AudioContext` via
 * `createMediaElementSource`, and a cross-origin element without CORS taints
 * the graph: the analyser returns silence and the visualiser flatlines.
 *
 * Proxying the bytes through this function makes the audio same-origin, which
 * makes the analyser legal, which is the whole reason the player's waveform is
 * real data rather than a sine wave pretending.
 *
 * Two things fall out of it for free:
 *
 * - The client never learns the origin URL, so moving the files is a
 *   server-side change with no app release.
 * - Playback becomes measurable — this is the one place every byte passes
 *   through, so play counts and bandwidth are countable here later.
 *
 * ## Range requests
 *
 * Seeking in a 7 MB file depends on `Range`, so the header is forwarded
 * upstream verbatim and the `206`, `Content-Range` and `Accept-Ranges` come
 * back untouched. Dropping any of those turns a seekable track into one that
 * has to be downloaded start-to-finish before the scrubber works.
 */

import { Readable } from 'node:stream';
import { ApiError, listTracks } from '@wax/core';
import { param, route } from './_lib/http.js';

/**
 * Hosts this proxy will fetch from.
 *
 * An allowlist, not a pass-through: without it, `?track=` could be widened
 * into an open proxy that fetches anything on the internet with this
 * deployment's IP and CORS headers on it. Tracks are resolved by id against
 * the catalog and their host is checked even so — belt and braces, because the
 * cost of being wrong here is hosting someone else's malware.
 */
const ALLOWED_HOSTS = new Set(['data.wearedogs.net']);

/** Response headers worth forwarding from the origin. */
const PASS_THROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];

export default route({
  GET: async (req, res) => {
    const trackId = param(req, 'track');
    if (!trackId) throw new ApiError(400, 'missing_track', 'Name the track to stream.');

    // Resolve against the catalog rather than trusting a URL from the client.
    const track = (await listTracks()).find((t) => t.id === trackId);
    if (!track) throw new ApiError(404, 'not_found', 'No such track.');

    const upstream = new URL(track.audio_url);
    if (!ALLOWED_HOSTS.has(upstream.hostname)) {
      // Reachable only if the seed itself is wrong, which is why it is a 500
      // and not a 400 — the client did nothing incorrect.
      throw new ApiError(500, 'bad_origin', 'That track points somewhere Wax will not fetch from.');
    }

    /** @type {Record<string, string>} */
    const forwarded = {};
    if (req.headers.range) forwarded.range = req.headers.range;
    if (req.headers['if-range']) forwarded['if-range'] = req.headers['if-range'];
    if (req.headers['if-none-match']) forwarded['if-none-match'] = req.headers['if-none-match'];

    const response = await fetch(upstream, { headers: forwarded });

    res.statusCode = response.status;
    for (const header of PASS_THROUGH) {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    // `route()` already set the permissive CORS origin. This is the header
    // that makes the analyser legal, so it is worth naming explicitly.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    // Immutable audio. A year is safe: the URL is keyed to a track id whose
    // bytes never change in place.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // 304 and friends carry no body.
    if (!response.body || response.status === 304) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(res);
  },
});
