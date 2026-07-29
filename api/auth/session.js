/**
 * GET    /api/auth/session  — resolve the current bearer token to a session
 * DELETE /api/auth/session  — sign out
 *
 * The app calls GET on launch to decide whether to show the sign-in screen or
 * go straight to the player. A 401 here is a normal, expected answer, not an
 * error condition — it just means nobody is signed in.
 */

import { getSession, logout } from '@wax/core';
import { bearer, json, route } from '../_lib/http.js';

export default route({
  GET: (req, res) => json(res, 200, getSession(bearer(req))),
  DELETE: (req, res) => json(res, 200, logout(bearer(req))),
});
