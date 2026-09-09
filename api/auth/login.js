/**
 * POST /api/auth/login
 *
 * Sign in and receive a bearer token.
 *
 * Body:
 *   { "test": true }                                  -> the seeded test collector
 *   { "email": "...", "password": "..." }             -> a seeded account
 *
 * The `test: true` path is what the app's "Enter as test collector" button
 * sends. It takes no credentials by design: this is a demo build with an
 * in-memory store and no real user data in it.
 *
 * Returns 200 with a {@link import('@wax/core').SessionView}, or 401.
 */

import { login } from '@wax/core';
import { json, readBody, route } from '../_lib/http.js';

export default route({
  POST: async (req, res) => {
    const body = await readBody(req);
    json(res, 200, await login(body));
  },
});
