/**
 * @file The in-memory store.
 *
 * This is the only place in Wax that knows how rows are physically kept. Every
 * handler talks to the interface below and nothing else, so replacing this
 * module with one that runs SQL against Postgres is a self-contained change:
 * the handlers, the API functions and the app do not move.
 *
 * The interface is deliberately dumb. It has `find`, `filter`, `insert`,
 * `update`, `remove` and nothing resembling a query language, a relation
 * mapper, or a resolver. Joins are done in `handlers.js`, in plain JavaScript,
 * where you can read them.
 *
 * ## Lifetime
 *
 * On Vercel each serverless invocation may get a cold module, so writes here
 * survive only as long as the instance does. That is correct for a demo and
 * wrong for production, and it is exactly the seam the Postgres implementation
 * fills. Nothing else has to change.
 *
 * ## Cloning
 *
 * Reads return structural clones. Callers get to mutate what they are handed
 * without corrupting the store, which removes an entire category of bug that
 * an in-memory store otherwise invites.
 */

import { seed } from './seed.js';

/** How long a freshly minted session lives, in milliseconds. Thirty days. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Structural clone that works on plain data in every runtime Wax targets
 * (Node, Hermes, browsers). `structuredClone` exists in all of them now, but
 * JSON round-tripping is faster for these shapes and they are strictly
 * JSON-safe by schema — no Dates, no Maps, no undefined.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/**
 * Generate an id with a readable prefix, e.g. `alr_l4k2j9x1`.
 * @param {string} prefix
 * @returns {string}
 */
export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Generate an opaque session token. Uses `crypto.getRandomValues` where it
 * exists — which is everywhere Wax runs — and never falls back to `Math.random`
 * for something that authenticates a request.
 *
 * @returns {string}
 */
export const newToken = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * @typedef {object} Collection
 * @property {() => any[]}                       all    Every row, cloned.
 * @property {(pred: (row: any) => boolean) => any} find First match, cloned, or undefined.
 * @property {(pred: (row: any) => boolean) => any[]} filter All matches, cloned.
 * @property {(row: any) => any}                 insert Adds a row, returns it cloned.
 * @property {(pred: (row: any) => boolean, patch: object) => any} update
 *           Merges `patch` into the first match. Returns the updated row, or
 *           undefined if nothing matched.
 * @property {(pred: (row: any) => boolean) => number} remove Deletes matches, returns the count.
 * @property {() => number}                      count
 */

/**
 * Wrap a raw array as a {@link Collection}.
 * @param {any[]} rows
 * @returns {Collection}
 */
function collection(rows) {
  return {
    all: () => clone(rows),
    find: (pred) => clone(rows.find(pred)),
    filter: (pred) => clone(rows.filter(pred)),
    insert: (row) => {
      rows.push(clone(row));
      return clone(row);
    },
    update: (pred, patch) => {
      const i = rows.findIndex(pred);
      if (i === -1) return undefined;
      rows[i] = { ...rows[i], ...clone(patch) };
      return clone(rows[i]);
    },
    remove: (pred) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (pred(rows[i])) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    count: () => rows.length,
  };
}

/**
 * Build a store over a dataset.
 *
 * @param {typeof seed} [data] Defaults to the demo seed.
 * @returns {ReturnType<typeof buildStore>}
 */
export function createStore(data = seed) {
  return buildStore(clone(data));
}

/**
 * @param {typeof seed} data
 */
function buildStore(data) {
  /** Sessions are minted at runtime, so they start empty rather than seeded. */
  const sessionRows = [];

  const store = {
    users: collection(data.users),
    profiles: collection(data.profiles),
    follows: collection(data.follows),
    artists: collection(data.artists),
    releases: collection(data.releases),
    tracks: collection(data.tracks),
    sources: collection(data.sources ?? []),
    scanLogs: collection(data.scanLogs ?? []),
    scanSnapshots: collection(data.scanSnapshots ?? []),
    digestQueue: collection(data.digestQueue ?? []),
    subscriptions: collection(data.subscriptions ?? []),
    watches: collection(data.watches),
    alerts: collection(data.alerts),
    crateItems: collection(data.crateItems),
    wantlistItems: collection(data.wantlistItems),
    pricePoints: collection(data.pricePoints),
    activity: collection(data.activity),
    engineStates: collection(data.engineStates ?? []),
    sessions: collection(sessionRows),

    /**
     * Mint a session for a user.
     *
     * @param {string} userId
     * @returns {import('./types.js').Session}
     */
    createSession(userId) {
      const now = Date.now();
      return store.sessions.insert({
        token: newToken(),
        user_id: userId,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
      });
    },

    /**
     * Resolve a bearer token to its user, checking expiry on read.
     *
     * Expired rows are swept lazily here rather than on a timer: a serverless
     * instance has no reliable timer, and a token nobody presents costs
     * nothing to leave sitting.
     *
     * @param {?string} token
     * @returns {?import('./types.js').User} Null when absent, unknown or expired.
     */
    userForToken(token) {
      if (!token) return null;
      const session = store.sessions.find((s) => s.token === token);
      if (!session) return null;
      if (Date.parse(session.expires_at) <= Date.now()) {
        store.sessions.remove((s) => s.token === token);
        return null;
      }
      return store.users.find((u) => u.id === session.user_id) ?? null;
    },

    /**
     * Drop a session. Idempotent.
     * @param {?string} token
     */
    endSession(token) {
      if (token) store.sessions.remove((s) => s.token === token);
    },

    /**
     * The most recent price observation for a release.
     * @param {string} releaseId
     * @returns {?import('./types.js').PricePoint}
     */
    latestPrice(releaseId) {
      const points = store.pricePoints
        .filter((p) => p.release_id === releaseId)
        .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
      return points[0] ?? null;
    },
  };

  return store;
}

/**
 * The process-wide store.
 *
 * A module-level singleton so that a write in one request is visible to the
 * next one on the same instance — which is what makes "play a track, then see
 * it on your profile" work in the demo.
 */
export const store = createStore();
