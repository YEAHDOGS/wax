/**
 * GET   /api/profile?handle=kestrel — a profile, its stats, neighbours and activity
 * PATCH /api/profile                — update your own
 *
 * Omitting `handle` returns the signed-in user's own profile.
 *
 * PATCH body accepts only `bio`, `location`, `ink`, `genres` and
 * `crate_public`. Unknown keys are ignored rather than rejected, so a client
 * that sends the whole profile object back does not fail the save.
 */

import { getProfile, updateProfile } from '@wax/core';
import { bearer, json, param, readBody, route } from './_lib/http.js';

export default route({
  GET: async (req, res) => json(res, 200, await getProfile(bearer(req), param(req, 'handle') ?? undefined)),

  PATCH: async (req, res) => {
    const patch = await readBody(req);
    json(res, 200, await updateProfile(bearer(req), patch));
  },
});
