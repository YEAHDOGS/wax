/**
 * @file Every read and write the product performs, as plain functions.
 *
 * ## Why this file exists
 *
 * A handler here takes a session and some arguments and returns data. It does
 * not know about HTTP, Vercel, `Request`, `Response`, headers, or status codes.
 * That buys two things:
 *
 * 1. The serverless functions in `/api` are ten-line adapters. All the product
 *    logic is here, in one readable place, testable by calling a function.
 * 2. The app can run with **no server at all**. In local mode the client calls
 *    these directly (see `apps/app/src/data/client.js`), which is why
 *    `npm run dev` needs nothing but Metro.
 *
 * ## What this file is not
 *
 * It is not a resolver layer. There is no schema stitching, no field-level
 * resolution, no dataloader, no N+1 to solve. When a screen needs an alert
 * joined to its release and artist, a function below does the join with
 * `Array.find` and returns the finished object. If that ever gets slow, the
 * fix is a SQL join in the same function — not an abstraction on top of it.
 *
 * ## Errors
 *
 * Handlers throw {@link ApiError}. The adapters catch it and map `.status`
 * onto the HTTP response. Anything else that throws is a genuine bug and
 * becomes a 500.
 */

import { store as defaultStore, newId } from './store.js';
import { renderAlertHistory } from './alert-history.js';

/**
 * An error carrying the HTTP status it should become.
 *
 * @property {number} status
 * @property {string} code Stable, machine-readable, e.g. `'not_found'`.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message Written for a human; the UI may show it verbatim.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const notFound = (what) => new ApiError(404, 'not_found', `${what} not found.`);
const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in to do that.');

/**
 * The password every seeded account accepts.
 *
 * This is a demo credential in a repository, deliberately and visibly so. When
 * the Postgres store lands, this constant goes with it and the check below
 * becomes an argon2 verify against `users.password_hash`. It is spelled out
 * here rather than hidden in an env var precisely so that nobody mistakes it
 * for a secret worth protecting.
 */
export const DEMO_PASSWORD = 'wax';

/** The account the "Enter as test collector" button signs you in as. */
export const TEST_USER_EMAIL = 'test@wax.fm';

// -------------------------------------------------------------------- auth

/**
 * Sign in.
 *
 * Two modes. With `test: true` the caller gets the seeded test collector with
 * no credentials at all — that is the one-tap demo button, and it is the only
 * path that skips a password. Otherwise the email must exist and the password
 * must match {@link DEMO_PASSWORD}.
 *
 * @param {object}   input
 * @param {string}  [input.email]
 * @param {string}  [input.password]
 * @param {boolean} [input.test] Sign in as the seeded test collector.
 * @param {object}  [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').SessionView}
 */
export function login({ email, password, test = false } = {}, { store = defaultStore } = {}) {
  const address = test ? TEST_USER_EMAIL : String(email ?? '').trim().toLowerCase();
  const user = store.users.find((u) => u.email.toLowerCase() === address);

  // Same error for "no such account" and "wrong password", so the response
  // cannot be used to enumerate which addresses have accounts.
  if (!user || (!test && password !== DEMO_PASSWORD)) {
    throw new ApiError(401, 'bad_credentials', 'That email and password do not match an account.');
  }

  const session = store.createSession(user.id);
  return {
    token: session.token,
    expires_at: session.expires_at,
    user,
    profile: store.profiles.find((p) => p.user_id === user.id),
  };
}

/**
 * Resolve a bearer token to the signed-in user, or throw 401.
 *
 * Every handler that needs a user calls this rather than trusting a user id
 * passed in from outside — there is exactly one place in this codebase where a
 * token becomes an identity, and this is it.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').User}
 */
export function requireUser(token, { store = defaultStore } = {}) {
  const user = store.userForToken(token);
  if (!user) throw unauthorized();
  return user;
}

/**
 * The current session, for restoring state on app launch.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').SessionView}
 */
export function getSession(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const session = store.sessions.find((s) => s.token === token);
  return {
    token,
    expires_at: session.expires_at,
    user,
    profile: store.profiles.find((p) => p.user_id === user.id),
  };
}

/**
 * Sign out. Idempotent — signing out twice is not an error.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ ok: true }}
 */
export function logout(token, { store = defaultStore } = {}) {
  store.endSession(token);
  return { ok: true };
}

// ------------------------------------------------------------------ catalog

/**
 * Attach an artist to a release. The one join every catalog surface needs.
 *
 * @param {import('./types.js').Release} release
 * @param {typeof defaultStore} store
 */
const withArtist = (release, store) => ({
  ...release,
  artist: store.artists.find((a) => a.id === release.artist_id) ?? null,
});

/**
 * The full catalog, newest pressing first.
 *
 * @param {object} [query]
 * @param {string} [query.artist_id] Restrict to one artist.
 * @param {number} [query.limit]
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {Array<import('./types.js').Release & { artist: ?import('./types.js').Artist }>}
 */
export function listReleases({ artist_id, limit } = {}, { store = defaultStore } = {}) {
  let rows = store.releases.all();
  if (artist_id) rows = rows.filter((r) => r.artist_id === artist_id);
  rows.sort((a, b) => Date.parse(b.released_at ?? 0) - Date.parse(a.released_at ?? 0));
  if (limit) rows = rows.slice(0, limit);
  return rows.map((r) => withArtist(r, store));
}

/**
 * One pressing, with everything the detail screen shows: artist, current
 * spread, and any tracks that stream from it.
 *
 * @param {string} id
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export function getRelease(id, { store = defaultStore } = {}) {
  const release = store.releases.find((r) => r.id === id || r.cat === id);
  if (!release) throw notFound('Release');
  return {
    ...withArtist(release, store),
    price: store.latestPrice(release.id),
    tracks: store.tracks
      .filter((t) => t.release_id === release.id)
      .sort((a, b) => a.position - b.position),
  };
}

/**
 * The player's catalog, in running order.
 *
 * `audio_url` is rewritten to point at the stream proxy when one is
 * configured. The client never sees the origin URL, which means swapping where
 * the bytes come from is a server-side change nobody has to redeploy an app
 * binary for.
 *
 * @param {object} [options]
 * @param {?string} [options.streamBase] e.g. `'/api/stream'`. Null leaves URLs untouched.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Track[]}
 */
export function listTracks({ streamBase = null } = {}, { store = defaultStore } = {}) {
  return store.tracks
    .all()
    .sort((a, b) => a.position - b.position)
    .map((t) => ({
      ...t,
      audio_url: streamBase ? `${streamBase}?track=${encodeURIComponent(t.id)}` : t.audio_url,
    }));
}

/**
 * Record the true duration of a track once something has decoded it.
 *
 * The seed ships `duration_sec: null` for every track because nothing had
 * played them yet. The player calls this the first time it learns a real
 * duration, so the column fills itself in through use rather than through a
 * batch job nobody wrote.
 *
 * @param {string} id
 * @param {number} durationSec
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Track}
 */
export function setTrackDuration(id, durationSec, { store = defaultStore } = {}) {
  const seconds = Math.round(Number(durationSec));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ApiError(400, 'bad_duration', 'Duration must be a positive number of seconds.');
  }
  const updated = store.tracks.update((t) => t.id === id, { duration_sec: seconds });
  if (!updated) throw notFound('Track');
  return updated;
}

// ------------------------------------------------------------- alert board

/**
 * The alert board.
 *
 * Each row arrives fully joined — release, artist, current spread, and whether
 * the pressing is already in the user's crate — because the board renders all
 * four and a second round trip per row would be absurd.
 *
 * @param {?string} token
 * @param {object} [query]
 * @param {import('./types.js').AlertState|'all'} [query.state] Filter, default all.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').AlertRow[]}
 */
export function listAlerts(token, { state = 'all' } = {}, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const crate = new Set(
    store.crateItems.filter((c) => c.user_id === user.id).map((c) => c.release_id),
  );

  return store.alerts
    .filter((a) => a.user_id === user.id && (state === 'all' || a.state === state))
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at))
    .map((alert) => {
      const release = store.releases.find((r) => r.id === alert.release_id);
      return {
        ...alert,
        release,
        artist: store.artists.find((a) => a.id === release?.artist_id) ?? null,
        in_crate: crate.has(alert.release_id),
        price: store.latestPrice(alert.release_id),
      };
    });
}

/**
 * Counts per state, for the board's filter row.
 *
 * Returned as its own call rather than derived on the client, so the numbers
 * stay right when the board is paginated and the client only holds a page.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ all: number, live: number, caught: number, sold_out: number, watching: number, missed: number, unread: number }}
 */
export function alertCounts(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const rows = store.alerts.filter((a) => a.user_id === user.id);
  const of = (s) => rows.filter((a) => a.state === s).length;
  return {
    all: rows.length,
    live: of('live'),
    caught: of('caught'),
    sold_out: of('sold_out'),
    watching: of('watching'),
    missed: of('missed'),
    unread: rows.filter((a) => a.read_at === null).length,
  };
}

/**
 * The alert history page, as a standalone static HTML document.
 *
 * The renderer is pure (`alert-history.js`); this handler is the route's half
 * of the wiring — it resolves the session to a user and hands the finished
 * page to the `/api/alerts/history` adapter. Unknown `?state=` values fall
 * back to `all` inside the renderer, same as the filter row behaves.
 *
 * @param {?string} token
 * @param {object} [query]
 * @param {import('./types.js').AlertState|'all'} [query.state] Filter, default all.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {string} A complete HTML document.
 */
export function alertHistory(token, { state = 'all' } = {}, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return renderAlertHistory(store, user.id, { state });
}

/**
 * Mark an alert read. Sets `read_at` once and never moves it again — the first
 * time a user saw something is a fact, not a running value.
 *
 * @param {?string} token
 * @param {string} alertId
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Alert}
 */
export function markAlertRead(token, alertId, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const alert = store.alerts.find((a) => a.id === alertId && a.user_id === user.id);
  if (!alert) throw notFound('Alert');
  if (alert.read_at) return alert;
  return store.alerts.update((a) => a.id === alertId, { read_at: new Date().toISOString() });
}

/**
 * Catch a drop: mark the alert `caught` and put the pressing in the crate.
 *
 * The two writes belong together. An alert that says "caught" while the record
 * is absent from the crate is the kind of inconsistency that makes a collector
 * stop trusting the app, so no caller is given the option to do only one.
 *
 * @param {?string} token
 * @param {string} alertId
 * @param {object} [input]
 * @param {import('./types.js').Condition} [input.condition]
 * @param {?number} [input.paid_cents] Defaults to the price at detection.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ alert: import('./types.js').Alert, crate_item: import('./types.js').CrateItem }}
 */
export function catchAlert(token, alertId, { condition = 'M', paid_cents } = {}, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const alert = store.alerts.find((a) => a.id === alertId && a.user_id === user.id);
  if (!alert) throw notFound('Alert');
  if (alert.state === 'sold_out') {
    throw new ApiError(409, 'sold_out', 'That listing is gone. Wax will watch for a restock.');
  }

  const now = new Date().toISOString();
  const updated = store.alerts.update((a) => a.id === alertId, {
    state: 'caught',
    read_at: alert.read_at ?? now,
  });

  // A pressing can only be in a crate once; catching an alert for something
  // already owned updates nothing and is not an error.
  let item = store.crateItems.find(
    (c) => c.user_id === user.id && c.release_id === alert.release_id,
  );
  if (!item) {
    item = store.crateItems.insert({
      id: newId('crt'),
      user_id: user.id,
      release_id: alert.release_id,
      condition,
      paid_cents: paid_cents ?? alert.price_cents ?? null,
      acquired_at: now,
      notes: null,
      created_at: now,
    });
    store.activity.insert({
      id: newId('act'),
      user_id: user.id,
      verb: 'caught',
      object_type: 'release',
      object_id: alert.release_id,
      created_at: now,
    });
  }

  return { alert: updated, crate_item: item };
}

// -------------------------------------------------------------------- crate

/**
 * The user's collection, newest first, joined to release, artist and spread.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').CrateRow[]}
 */
export function listCrate(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return store.crateItems
    .filter((c) => c.user_id === user.id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((item) => {
      const release = store.releases.find((r) => r.id === item.release_id);
      return {
        ...item,
        release,
        artist: store.artists.find((a) => a.id === release?.artist_id) ?? null,
        price: store.latestPrice(item.release_id),
      };
    });
}

/**
 * Add a pressing to the crate directly, outside the alert flow.
 *
 * @param {?string} token
 * @param {object} input
 * @param {string} input.release_id
 * @param {import('./types.js').Condition} [input.condition]
 * @param {?number} [input.paid_cents]
 * @param {?string} [input.notes]
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').CrateItem}
 */
export function addToCrate(token, { release_id, condition = 'NM', paid_cents = null, notes = null }, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  if (!store.releases.find((r) => r.id === release_id)) throw notFound('Release');

  const existing = store.crateItems.find(
    (c) => c.user_id === user.id && c.release_id === release_id,
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const item = store.crateItems.insert({
    id: newId('crt'),
    user_id: user.id,
    release_id,
    condition,
    paid_cents,
    acquired_at: now,
    notes,
    created_at: now,
  });
  store.activity.insert({
    id: newId('act'),
    user_id: user.id,
    verb: 'added',
    object_type: 'release',
    object_id: release_id,
    created_at: now,
  });
  return item;
}

/**
 * Remove a pressing from the crate.
 *
 * @param {?string} token
 * @param {string} releaseId
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ ok: true, removed: number }}
 */
export function removeFromCrate(token, releaseId, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const removed = store.crateItems.remove(
    (c) => c.user_id === user.id && c.release_id === releaseId,
  );
  return { ok: true, removed };
}

// ------------------------------------------------------- wantlist and price

/**
 * The price watch: everything the user is hunting, with the current spread and
 * whether it has crossed their target.
 *
 * `hit` is computed here rather than on the client because "has this crossed"
 * is a product rule, and a rule that lives in two clients is a rule that will
 * disagree with itself.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export function listPriceWatch(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return store.wantlistItems
    .filter((w) => w.user_id === user.id)
    .map((want) => {
      const release = store.releases.find((r) => r.id === want.release_id);
      const price = store.latestPrice(want.release_id);
      return {
        ...want,
        release,
        artist: store.artists.find((a) => a.id === release?.artist_id) ?? null,
        price,
        hit: Boolean(price && want.target_price_cents && price.low_cents <= want.target_price_cents),
      };
    })
    .sort((a, b) => Number(b.hit) - Number(a.hit));
}

// ------------------------------------------------------------------ watches

/** Free accounts may watch this many artists. */
export const FREE_WATCH_LIMIT = 3;

/**
 * The user's standing watch instructions, joined to their artists.
 *
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export function listWatches(token, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return store.watches
    .filter((w) => w.user_id === user.id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((w) => ({
      ...w,
      artist: store.artists.find((a) => a.id === w.artist_id) ?? null,
      alert_count: store.alerts.filter(
        (al) => al.user_id === user.id && al.watch_id === w.id,
      ).length,
    }));
}

/**
 * Start watching an artist.
 *
 * The free-tier cap is enforced here, in the handler, and not as a database
 * constraint: it is a pricing decision that will change, and pricing decisions
 * do not belong in DDL.
 *
 * @param {?string} token
 * @param {object} input
 * @param {string} input.artist_id
 * @param {string[]} [input.merch_types]
 * @param {?number} [input.target_price_cents]
 * @param {import('./types.js').Channel[]} [input.channels]
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Watch}
 */
export function addWatch(token, { artist_id, merch_types = [], target_price_cents = null, channels = ['push'] }, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  if (!store.artists.find((a) => a.id === artist_id)) throw notFound('Artist');

  const existing = store.watches.find((w) => w.user_id === user.id && w.artist_id === artist_id);
  if (existing) return existing;

  const count = store.watches.filter((w) => w.user_id === user.id).length;
  if (user.plan === 'free' && count >= FREE_WATCH_LIMIT) {
    throw new ApiError(
      402,
      'watch_limit',
      `The free tier watches ${FREE_WATCH_LIMIT} artists. Upgrade to watch more.`,
    );
  }

  return store.watches.insert({
    id: newId('wch'),
    user_id: user.id,
    artist_id,
    watch_vinyl: true,
    merch_types,
    target_price_cents,
    channels,
    created_at: new Date().toISOString(),
  });
}

/**
 * Stop watching an artist.
 *
 * @param {?string} token
 * @param {string} watchId
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ ok: true, removed: number }}
 */
export function removeWatch(token, watchId, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  const removed = store.watches.remove((w) => w.id === watchId && w.user_id === user.id);
  return { ok: true, removed };
}

// ----------------------------------------------------------------- profiles

/**
 * Strip a user down to what the world may see.
 * @param {import('./types.js').User} user
 * @returns {import('./types.js').PublicUser}
 */
const publicUser = (user) => ({
  id: user.id,
  handle: user.handle,
  display_name: user.display_name,
  avatar_url: user.avatar_url,
  plan: user.plan,
});

/**
 * Everything the profile screen renders, in one response: the user, their
 * stats, the collectors whose crates overlap theirs, and recent activity.
 *
 * The neighbour calculation is the social layer's whole premise — people
 * connect over shared collections, not over a follower count — so it is
 * computed server-side and returned with the profile rather than being a
 * separate call the client might skip.
 *
 * @param {?string} token
 * @param {string} [handle] Whose profile. Defaults to the signed-in user.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').ProfileView}
 */
export function getProfile(token, handle, { store = defaultStore } = {}) {
  const viewer = requireUser(token, { store });
  const user = handle
    ? store.users.find((u) => u.handle === handle || u.id === handle)
    : viewer;
  if (!user) throw notFound('Profile');

  const profile = store.profiles.find((p) => p.user_id === user.id);
  const crate = store.crateItems.filter((c) => c.user_id === user.id);
  const alerts = store.alerts.filter((a) => a.user_id === user.id);
  const owned = new Set(crate.map((c) => c.release_id));

  // What the crate cost against what it is currently worth, at median spread.
  const crate_paid = crate.reduce((sum, c) => sum + (c.paid_cents ?? 0), 0);
  const crate_value = crate.reduce((sum, c) => {
    const price = store.latestPrice(c.release_id);
    return sum + (price?.median_cents ?? c.paid_cents ?? 0);
  }, 0);

  // Genres, ranked by how many records in the crate carry them.
  const genreCounts = new Map();
  for (const item of crate) {
    const release = store.releases.find((r) => r.id === item.release_id);
    const artist = store.artists.find((a) => a.id === release?.artist_id);
    for (const genre of artist?.genres ?? []) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  const top_genres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([genre]) => genre);

  // Collectors sharing pressings with this one. `overlap` is the share of
  // *this* user's crate the neighbour also owns, so it reads as "they have 60%
  // of what you have" rather than as a symmetric similarity score.
  const neighbours = store.users
    .filter((u) => u.id !== user.id)
    .map((other) => {
      const theirs = store.crateItems.filter((c) => c.user_id === other.id);
      const shared = theirs.filter((c) => owned.has(c.release_id)).length;
      return {
        user: publicUser(other),
        shared,
        overlap: owned.size ? shared / owned.size : 0,
      };
    })
    .filter((n) => n.shared > 0)
    .sort((a, b) => b.shared - a.shared);

  return {
    user: publicUser(user),
    profile,
    stats: {
      crate_count: crate.length,
      watch_count: store.watches.filter((w) => w.user_id === user.id).length,
      caught_count: alerts.filter((a) => a.state === 'caught').length,
      missed_count: alerts.filter((a) => a.state === 'sold_out' || a.state === 'missed').length,
      crate_paid,
      crate_value,
      follower_count: store.follows.filter((f) => f.followee_id === user.id).length,
      following_count: store.follows.filter((f) => f.follower_id === user.id).length,
      top_genres,
    },
    neighbours,
    activity: store.activity
      .filter((a) => a.user_id === user.id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 12),
  };
}

/**
 * Update the signed-in user's own profile. Only the fields a user is allowed
 * to set are read off `patch`; anything else on it is ignored rather than
 * rejected, so an over-eager client cannot fail a save by sending extra keys.
 *
 * @param {?string} token
 * @param {Partial<import('./types.js').Profile>} patch
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Profile}
 */
export function updateProfile(token, patch = {}, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  /** @type {Partial<import('./types.js').Profile>} */
  const allowed = {};
  if (typeof patch.bio === 'string') allowed.bio = patch.bio;
  if (typeof patch.location === 'string') allowed.location = patch.location;
  if (['vermilion', 'cyan', 'chartreuse', 'ultramarine'].includes(patch.ink)) allowed.ink = patch.ink;
  if (Array.isArray(patch.genres)) allowed.genres = patch.genres.map(String);
  if (typeof patch.crate_public === 'boolean') allowed.crate_public = patch.crate_public;
  allowed.updated_at = new Date().toISOString();

  const updated = store.profiles.update((p) => p.user_id === user.id, allowed);
  if (!updated) throw notFound('Profile');
  return updated;
}

/**
 * Record that a track was played. Feeds the activity list and, later, taste
 * matching. Fire-and-forget from the client's point of view.
 *
 * @param {?string} token
 * @param {string} trackId
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {{ ok: true }}
 */
export function recordPlay(token, trackId, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  if (!store.tracks.find((t) => t.id === trackId)) throw notFound('Track');
  store.activity.insert({
    id: newId('act'),
    user_id: user.id,
    verb: 'played',
    object_type: 'track',
    object_id: trackId,
    created_at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * Everything the app needs at launch, in a single call.
 *
 * A cold start otherwise fires six requests before it can draw anything, and
 * on a phone that is the difference between the app feeling instant and
 * feeling like a website. The screens all read from this one payload.
 *
 * @param {?string} token
 * @param {object} [options]
 * @param {?string} [options.streamBase]
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export function bootstrap(token, { streamBase = null } = {}, { store = defaultStore } = {}) {
  const user = requireUser(token, { store });
  return {
    user,
    profile: store.profiles.find((p) => p.user_id === user.id),
    alerts: listAlerts(token, { state: 'all' }, { store }),
    counts: alertCounts(token, { store }),
    crate: listCrate(token, { store }),
    watches: listWatches(token, { store }),
    price_watch: listPriceWatch(token, { store }),
    tracks: listTracks({ streamBase }, { store }),
    profile_view: getProfile(token, undefined, { store }),
  };
}
