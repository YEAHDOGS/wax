/**
 * @file Per-site tracking configuration for the alert engine (plan gates 3+).
 *
 * `handlers.js` already owns per-artist config (`addWatch`/`removeWatch` —
 * what to tell me about). This module owns per-site config: which merch
 * sites the user asked Wax to scan, each site's probe verdict, and the
 * per-site scan behaviour (pause, interval override).
 *
 * Two hard rules from docs/ALERT-ENGINE-PLAN.md §1:
 *
 * 1. Never silently accept an unscannable site. `addSource` refuses to store
 *    a site the probe verdicts NOT SCANNABLE unless the caller passes
 *    `accept_unscannable: true` — the UI's "add it anyway" checkbox. The
 *    verdict reason is always persisted so the dashboard can show *why*.
 * 2. Fetching is not this module's job. The caller fetches the page (or a
 *    fixture in tests) and passes the HTML in; the probe decision stays pure.
 *
 * Like every handler, these take a session token and are transport-blind:
 * the API adapters and the app call the same functions.
 */

import { store as defaultStore, newId } from './store.js';
import { ApiError, requireUser } from './handlers.js';
import { effectivePlan } from './plan.js';
import { probeScannability } from './probe.js';

/** Free accounts may track this many merch sites. Mirrors FREE_WATCH_LIMIT. */
export const FREE_SOURCE_LIMIT = 3;

/** The scan interval may never go below this many seconds — Wax is polite. */
export const MIN_SCAN_INTERVAL_SECS = 30;

/**
 * Only http(s) URLs are accepted. Anything else is either a typo or an
 * attempt to get the worker to fetch something it should not touch.
 * @param {string} url
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new ApiError(422, 'invalid_url', 'Give me a URL like https://shop.example/new-arrivals.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(422, 'invalid_url', 'That is not a URL I can parse.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(422, 'invalid_url', 'Only http:// and https:// URLs can be scanned.');
  }
  return parsed;
}

/**
 * Normalize the probe verdict into the columns on `sources`.
 * @param {ReturnType<typeof probeScannability>} verdict
 */
function verdictToColumns(verdict) {
  return {
    scannable: verdict.scannable,
    scan_method: verdict.scannable ? verdict.method : null,
    scannable_reason: verdict.scannable
      ? `${verdict.confidence} confidence — ${verdict.detail}`
      : `${verdict.reason} — ${verdict.detail}`,
    platform: verdict.scannable && verdict.method === 'platform-api' ? verdict.detail.split(' ')[0].toLowerCase() : 'unknown',
  };
}

/**
 * Add a merch site to the user's scan list.
 *
 * The probe runs synchronously against `html` (the fetched page, or a
 * fixture in tests) and its verdict is stored on the row. When the probe
 * says NOT SCANNABLE, this throws 422 unless `accept_unscannable` is set —
 * the site is never quietly filed away as if it worked.
 *
 * @param {?string} token
 * @param {object} input
 * @param {string} input.url
 * @param {?string} [input.label]
 * @param {?string} [input.html] Fetched page HTML; empty means "not probed yet".
 * @param {boolean} [input.accept_unscannable] Explicit user opt-in.
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 * @returns {import('./types.js').Source}
 */
export async function addSource(token, { url, label = null, html = null, accept_unscannable = false }, { store = defaultStore } = {}) {
  const user = await requireUser(token, { store });
  const parsed = validateUrl(url);
  const canonical = parsed.toString();

  const existing = await store.sources.find((s) => s.user_id === user.id && s.url === canonical);
  if (existing) return existing;

  const count = (await store.sources.filter((s) => s.user_id === user.id)).length;
  // Same read-path trial enforcement as the watch gate in handlers.js.
  if (effectivePlan(user) === 'free' && count >= FREE_SOURCE_LIMIT) {
    throw new ApiError(
      402,
      'source_limit',
      `The free tier tracks ${FREE_SOURCE_LIMIT} merch sites. Upgrade to track more.`,
    );
  }

  let columns;
  if (html === null || html === undefined) {
    columns = {
      scannable: false,
      scan_method: null,
      scannable_reason: 'not-probed-yet — the page has not been fetched and probed.',
      platform: 'unknown',
    };
  } else {
    const verdict = probeScannability({ url: canonical, html });
    if (!verdict.scannable && !accept_unscannable) {
      throw new ApiError(
        422,
        'not_scannable',
        `Wax cannot scan that site yet: ${verdict.reason} — ${verdict.detail}`,
      );
    }
    columns = verdictToColumns(verdict);
  }

  return store.sources.insert({
    id: newId('src'),
    user_id: user.id,
    url: canonical,
    label,
    ...columns,
    snapshot_hash: null,
    scan_interval_secs: 60,
    paused: false,
    last_scan_at: null,
    consecutive_failures: 0,
    created_at: new Date().toISOString(),
  });
}

/**
 * Change a site's config: pause it, change its interval, override the scan
 * method, relabel it. `scan_interval_secs` is floored at
 * MIN_SCAN_INTERVAL_SECS — a user typo must not turn Wax into a hammer.
 *
 * @param {?string} token
 * @param {string} sourceId
 * @param {object} patch
 * @param {boolean} [patch.paused]
 * @param {number} [patch.scan_interval_secs]
 * @param {string} [patch.scan_method]
 * @param {?string} [patch.label]
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export async function updateSource(token, sourceId, patch, { store = defaultStore } = {}) {
  const user = await requireUser(token, { store });
  const clean = {};
  if ('paused' in patch) clean.paused = Boolean(patch.paused);
  if ('label' in patch) clean.label = patch.label;
  if ('scan_method' in patch) {
    const valid = ['feed', 'platform-api', 'structured-data', 'sitemap', 'heuristic'];
    if (!valid.includes(patch.scan_method)) {
      throw new ApiError(422, 'invalid_scan_method', `scan_method must be one of ${valid.join(', ')}.`);
    }
    clean.scan_method = patch.scan_method;
  }
  if ('scan_interval_secs' in patch) {
    const secs = Number(patch.scan_interval_secs);
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new ApiError(422, 'invalid_interval', 'scan_interval_secs must be a positive number.');
    }
    clean.scan_interval_secs = Math.max(MIN_SCAN_INTERVAL_SECS, Math.floor(secs));
  }
  const updated = await store.sources.update(
    (s) => s.id === sourceId && s.user_id === user.id,
    clean,
  );
  if (!updated) {
    throw new ApiError(404, 'not_found', 'Source not found.');
  }
  return updated;
}

/**
 * Stop tracking a site. Idempotent.
 * @param {?string} token
 * @param {string} sourceId
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export async function removeSource(token, sourceId, { store = defaultStore } = {}) {
  const user = await requireUser(token, { store });
  const removed = await store.sources.remove((s) => s.id === sourceId && s.user_id === user.id);
  return { ok: true, removed };
}

/**
 * The user's sites, newest first, with the probe verdict ready to render.
 * @param {?string} token
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store]
 */
export async function listSources(token, { store = defaultStore } = {}) {
  const user = await requireUser(token, { store });
  return (await store.sources
    .filter((s) => s.user_id === user.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
