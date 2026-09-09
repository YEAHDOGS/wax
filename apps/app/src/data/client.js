/**
 * @file The one place the app gets data from.
 *
 * Two modes, one interface:
 *
 * - **local** (default) — calls `@wax/core` handlers directly, in-process. No
 *   server, no network, no `vercel dev`. This is what makes `npm run dev` a
 *   single command that boots straight into a working, signed-in app.
 * - **remote** — `fetch`es `/api/*`. Enabled by setting `EXPO_PUBLIC_API_BASE`.
 *   The functions in `/api` are thin wrappers over the same handlers, so the
 *   two modes are the same code with a serialisation boundary in between.
 *
 * Screens never branch on the mode. They call `api.alerts()` and get rows.
 *
 * ## Audio in local mode
 *
 * `/api/stream` does not exist without a server, so local mode leaves
 * `audio_url` pointed at the origin. Playback works either way; what changes
 * is the waveform. See `player.js` — the analyser needs a same-origin,
 * CORS-clean source, which only the proxy provides.
 */

import * as core from '@wax/core';

/**
 * Base URL for the serverless API, e.g. `'https://wax.vercel.app'` or `''` for
 * same-origin. Unset means local mode.
 *
 * `EXPO_PUBLIC_`-prefixed variables are inlined into the bundle at build time,
 * which is correct here: this is a public URL, not a secret.
 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? null;

/** Whether the app is talking to a real server. */
export const isRemote = API_BASE !== null;

/**
 * An error from either transport, carrying the status and stable code the
 * handler produced, so a screen can branch on `err.code === 'watch_limit'`
 * without parsing a message.
 */
export class ClientError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.code = code;
  }
}

/** The bearer token for the current session. Set by `setToken`. */
let token = null;

/**
 * Set (or clear) the token every subsequent call authenticates with.
 * @param {?string} next
 */
export function setToken(next) {
  token = next ?? null;
}

/** @returns {?string} */
export const getToken = () => token;

/**
 * Call a handler, normalising whatever it throws into a {@link ClientError}.
 *
 * @template T
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
async function local(fn) {
  try {
    // `await` inside the try, not a bare `return`: the core handlers are
    // async, so an ApiError arrives as a rejection and only an await here
    // routes it into ClientError normalization.
    return await fn();
  } catch (err) {
    if (err?.name === 'ApiError') throw new ClientError(err.status, err.code, err.message);
    throw err;
  }
}

/**
 * Call the serverless API.
 *
 * @param {string} path e.g. `'/api/alerts?state=live'`
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body]
 * @returns {Promise<any>}
 */
async function remote(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // A 204 has no body to parse; everything else in this API returns JSON.
  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ClientError(
      response.status,
      payload?.error ?? 'http_error',
      payload?.message ?? `Request failed (${response.status}).`,
    );
  }
  return payload;
}

/**
 * The data interface. Every method exists in both modes and returns the same
 * shape from each.
 */
export const api = {
  /**
   * Sign in. Pass `{ test: true }` for the seeded test collector.
   *
   * Stores the returned token on the client as a side effect, so the caller
   * does not have to remember to — forgetting produced a 401 on the very next
   * call, every time, until this did it here.
   *
   * @param {{ email?: string, password?: string, test?: boolean }} input
   * @returns {Promise<import('@wax/core').SessionView>}
   */
  async login(input) {
    const session = isRemote
      ? await remote('/api/auth/login', { method: 'POST', body: input })
      : await local(() => core.login(input));
    setToken(session.token);
    return session;
  },

  /**
   * Resolve a stored token to a session. Throws 401 if it is dead.
   * @param {string} existing
   */
  async session(existing) {
    setToken(existing);
    const session = isRemote
      ? await remote('/api/auth/session')
      : await local(() => core.getSession(existing));
    setToken(session.token);
    return session;
  },

  /** Sign out. Clears the token whether or not the call succeeds. */
  async logout() {
    try {
      if (isRemote) await remote('/api/auth/session', { method: 'DELETE' });
      else await local(() => core.logout(token));
    } finally {
      setToken(null);
    }
  },

  /**
   * Everything the app needs at launch, in one call.
   * @returns {Promise<any>}
   */
  bootstrap() {
    // Local mode has no `/api/stream`, so track URLs stay pointed at origin.
    return isRemote
      ? remote('/api/bootstrap')
      : local(() => core.bootstrap(token, { streamBase: null }));
  },

  /**
   * The alert board plus its per-state counts.
   * @param {string} [state] One of the alert states, or `'all'`.
   */
  alerts(state = 'all') {
    return isRemote
      ? remote(`/api/alerts?state=${encodeURIComponent(state)}`)
      : local(() => ({
          alerts: core.listAlerts(token, { state }),
          counts: core.alertCounts(token),
        }));
  },

  /**
   * Mark an alert read.
   * @param {string} id
   */
  readAlert(id) {
    return isRemote
      ? remote('/api/alerts', { method: 'POST', body: { action: 'read', id } })
      : local(() => core.markAlertRead(token, id));
  },

  /**
   * Catch a drop: marks the alert caught and files the pressing in the crate.
   * @param {string} id
   * @param {{ condition?: string, paid_cents?: number }} [input]
   */
  catchAlert(id, input = {}) {
    return isRemote
      ? remote('/api/alerts', { method: 'POST', body: { action: 'catch', id, ...input } })
      : local(() => core.catchAlert(token, id, input));
  },

  /** The collection. */
  crate() {
    return isRemote ? remote('/api/crate') : local(() => ({ crate: core.listCrate(token) }));
  },

  /**
   * File a pressing directly.
   * @param {{ release_id: string, condition?: string, paid_cents?: number, notes?: string }} input
   */
  addToCrate(input) {
    return isRemote
      ? remote('/api/crate', { method: 'POST', body: input })
      : local(() => core.addToCrate(token, input));
  },

  /**
   * Pull a pressing out of the crate.
   * @param {string} releaseId
   */
  removeFromCrate(releaseId) {
    return isRemote
      ? remote(`/api/crate?release_id=${encodeURIComponent(releaseId)}`, { method: 'DELETE' })
      : local(() => core.removeFromCrate(token, releaseId));
  },

  /** Standing watch instructions. */
  watches() {
    return isRemote ? remote('/api/watches') : local(() => ({ watches: core.listWatches(token) }));
  },

  /**
   * Stop watching an artist.
   * @param {string} id
   */
  removeWatch(id) {
    return isRemote
      ? remote(`/api/watches?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      : local(() => core.removeWatch(token, id));
  },

  /**
   * A profile with stats, neighbours and activity. Omit `handle` for your own.
   * @param {string} [handle]
   */
  profile(handle) {
    const query = handle ? `?handle=${encodeURIComponent(handle)}` : '';
    return isRemote
      ? remote(`/api/profile${query}`)
      : local(() => core.getProfile(token, handle));
  },

  /**
   * Update your own profile.
   * @param {object} patch
   */
  updateProfile(patch) {
    return isRemote
      ? remote('/api/profile', { method: 'PATCH', body: patch })
      : local(() => core.updateProfile(token, patch));
  },

  /** The player's catalog. */
  tracks() {
    return isRemote
      ? remote('/api/tracks')
      : local(() => ({ tracks: core.listTracks({ streamBase: null }) }));
  },

  /**
   * Report a track's true duration, once something has decoded it.
   *
   * Best-effort: the player calls this and ignores the result. A failure here
   * must never affect playback.
   *
   * @param {string} id
   * @param {number} durationSec
   */
  setTrackDuration(id, durationSec) {
    const call = isRemote
      ? remote('/api/tracks', { method: 'PATCH', body: { id, duration_sec: durationSec } })
      : local(() => core.setTrackDuration(id, durationSec));
    return Promise.resolve(call).catch(() => null);
  },

  /**
   * Record that a track played. Fire-and-forget, for the same reason.
   * @param {string} trackId
   */
  recordPlay(trackId) {
    const call = isRemote
      ? remote('/api/plays', { method: 'POST', body: { track_id: trackId } })
      : local(() => core.recordPlay(token, trackId));
    return Promise.resolve(call).catch(() => null);
  },

  /**
   * One pressing, with its spread and tracks.
   * @param {string} id A release id or a catalog number.
   */
  release(id) {
    return isRemote
      ? remote(`/api/releases?id=${encodeURIComponent(id)}`)
      : local(() => core.getRelease(id));
  },
};
