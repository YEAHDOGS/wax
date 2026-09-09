/**
 * @file Scan worker — the orchestrating half of the alert engine (plan §2).
 *
 * `scanner.js` is the pure pipeline (normalize → hash → diff → match →
 * dedupe); it performs zero network I/O and owns no scheduling state. This
 * module is the worker that *drives* it on a schedule: which sources are due,
 * what a fetch means, where the snapshot and scan state persist, how a
 * failure backs off, and how a new drop turns into a queued alert.
 *
 * The worker performs zero network I/O itself. Fetching is an injected
 * `fetcher` because the plan's fetch contract is demanding — `WaxBot/1.0`
 * user-agent, `robots.txt` + `crawl-delay` respected, per-method parsers —
 * and the HTTP implementation is a separate build. The contract the fetcher
 * must honour:
 *
 * - Send `WaxBot/1.0; +https://wax.wearedogs.net/bot` as the user-agent.
 * - Respect the source's `robots.txt`, including `crawl-delay`.
 * - Parse the response according to `source.scan_method` and return the raw
 *   records the scanner normalizes (Shopify JSON, feed items, JSON-LD
 *   nodes, sitemap URLs, heuristic cards — the `test-scan.mjs` fixtures).
 * - Resolve `{ status, rawList }` on any HTTP response, and reject/throw on
 *   network failure. A 429 or 5xx `status` is a *failure* for backoff.
 * - Never be called for a source this module did not hand it: due,
 *   scannable, unpaused, http(s) only. The URL guard here is defense in
 *   depth; the fetcher must enforce it again.
 *
 * Failure policy (plan §2): consecutive failures double the source's
 * `scan_interval_secs` up to `MAX_SCAN_INTERVAL_SECS`. A success clears the
 * failure counter but leaves the interval where it is — the engine never
 * silently re-arms a flaky source to the fast lane; the user lowers it
 * deliberately via the tracking config. The first scan of a source is a
 * *baseline*: it stores the snapshot and logs, and never alerts, so adding a
 * site does not fire one text per item already on the shelf.
 *
 * The worker never sends anything. Each new drop becomes an *alert feed
 * item* carrying its formatted content and the notify path's dispatch
 * verdict (`shouldDispatch` — rate caps, free-tier SMS gate); persisting the
 * alert row and handing it to Resend/Twilio is the dispatch layer's job.
 */

/* node:crypto is imported by scanner.js, not here — this module hashes
 * nothing itself. */

import { newId } from './store.js';
import { MIN_SCAN_INTERVAL_SECS } from './tracking.js';
import { scanSnapshot, matchArtists, dedupeCandidates } from './scanner.js';
import { formatDropEmail, formatDropSms, shouldDispatch } from './notify.js';

/** The user-agent every fetch must identify with (plan §2). */
export const USER_AGENT = 'WaxBot/1.0; +https://wax.wearedogs.net/bot';

/** Cheap structured sources start here (plan §2). */
export const BASE_SCAN_INTERVAL_SECS = 60;

/** A dead source is still checked daily — never abandoned, never hammered. */
export const MAX_SCAN_INTERVAL_SECS = 24 * 60 * 60;

/** How many due sources one pass will touch. A minute is short. */
export const PASS_LIMIT = 25;

/** Trailing window the rate-limit gate counts dispatches over. */
export const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Whether a URL is fetchable at all. Only http(s) — anything else is a typo
 * or an attempt to get the worker to fetch something it must not touch.
 * @param {?string} url
 * @returns {boolean}
 */
export function canFetch(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The scan queue: which sources are due right now.
 *
 * A source is due when it is scannable, not paused, has a scan method the
 * probe assigned, has a fetchable URL, and its last scan is at least
 * `scan_interval_secs` in the past. A never-scanned source is due
 * immediately — onboarding answers in seconds, per the plan.
 *
 * @param {Array<object>} sources Raw source rows.
 * @param {number} [nowMs] Defaults to `Date.now()`; tests pass a fixed clock.
 * @returns {Array<object>} The due sources, oldest `last_scan_at` first.
 */
export function selectDueSources(sources, nowMs = Date.now()) {
  return (sources ?? [])
    .filter((s) => s && s.scannable === true && s.paused !== true && s.scan_method && canFetch(s.url))
    .filter((s) => {
      if (!s.last_scan_at) return true;
      const interval = saneIntervalSecs(s.scan_interval_secs);
      return Date.parse(s.last_scan_at) + interval * 1000 <= nowMs;
    })
    .sort((a, b) => {
      const ka = a.last_scan_at ?? '';
      const kb = b.last_scan_at ?? '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/**
 * Clamp a stored interval to something the worker will actually honour.
 * @param {*} secs
 * @returns {number}
 */
function saneIntervalSecs(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return BASE_SCAN_INTERVAL_SECS;
  return Math.max(MIN_SCAN_INTERVAL_SECS, Math.floor(n));
}

/**
 * The failure side of the adaptive interval: double it, bounded.
 *
 * Pure so the escalation curve is unit-testable without running scans.
 *
 * @param {number} currentSecs The source's current `scan_interval_secs`.
 * @returns {number} The escalated interval.
 */
export function escalateIntervalSecs(currentSecs) {
  return Math.min(saneIntervalSecs(currentSecs) * 2, MAX_SCAN_INTERVAL_SECS);
}

/**
 * The artists one user is watching, as `matchArtists` wants them.
 * @param {object} store A `@wax/core` store.
 * @param {string} userId
 * @returns {Array<{ id: string, name: string, aliases?: string[], watch: object }>}
 */
export function watchedArtists(store, userId) {
  const watches = store.watches.filter((w) => w.user_id === userId);
  const out = [];
  for (const watch of watches) {
    const artist = store.artists.find((a) => a.id === watch.artist_id);
    if (artist) out.push({ id: artist.id, name: artist.name, aliases: artist.aliases, watch });
  }
  return out;
}

/**
 * What this user was already told in the trailing rate window, shaped for
 * `shouldDispatch`. Each dispatched alert contributes one entry per channel
 * it left on.
 * @param {object} store
 * @param {string} userId
 * @param {number} [nowMs]
 * @returns {Array<{ channel: string, sent_at: string }>}
 */
export function sentThisWindow(store, userId, nowMs = Date.now()) {
  const cutoff = nowMs - RATE_WINDOW_MS;
  const out = [];
  for (const alert of store.alerts.filter((a) => a.user_id === userId && a.dispatched_at)) {
    if (Date.parse(alert.dispatched_at) < cutoff) continue;
    for (const channel of alert.channels ?? []) out.push({ channel, sent_at: alert.dispatched_at });
  }
  return out;
}

/** Short human label for a source: its label, else its hostname. */
function sourceLabel(source) {
  if (source.label) return source.label;
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.url;
  }
}

/**
 * Append one scan attempt to the per-source scan log (plan §2: "attempts,
 * failures, new-item counts — the same transparency pattern as DOGS Remote's
 * attempt log").
 * @param {object} store
 * @param {object} entry Fields of a `scan_logs` row minus `id`.
 */
export function recordScanLog(store, entry) {
  return store.scanLogs.insert({ id: newId('scl'), scanned_at: new Date().toISOString(), ...entry });
}

/**
 * Scan one source end to end: fetch (injected), diff against the stored
 * snapshot, match against the owner's watched artists, dedupe, and feed new
 * drops into the notify path. Persists the snapshot, the source's scan
 * state, and the scan log row. Never throws — a failure is a row, not a
 * crash, because one dead site must not take down the whole pass.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {object} input.source The source row to scan.
 * @param {(source: object) => Promise<{ status: number, rawList: Array<object> }>} input.fetcher
 * @param {number} [input.nowMs]
 * @returns {Promise<{ source_id: string, ok: boolean, matches: object[], log: object }>}
 *   `matches` are this source's new drops, matched against the owner's
 *   watched artists and deduped within the source. Cross-source dedupe
 *   happens in `runScanPass`, which sees every source's matches at once.
 */
export async function scanOneSource({ store, source, fetcher, nowMs = Date.now() }) {
  const isoNow = new Date(nowMs).toISOString();
  try {
    const { status, rawList } = await fetcher(source);
    if (status === 429 || status >= 500) {
      return failSource(store, source, isoNow, `fetch_failed`, `HTTP ${status}`);
    }
    return succeedSource(store, source, { rawList, status }, isoNow);
  } catch (err) {
    return failSource(store, source, isoNow, 'fetch_failed', err?.message ?? String(err));
  }
}

/**
 * The failure path: back the interval off, count the failure, log it.
 * The source is marked scanned *now* so the doubled interval is measured
 * from this attempt — otherwise a failing source would be retried every
 * pass until the clock caught up.
 */
function failSource(store, source, isoNow, outcome, error) {
  const failures = (source.consecutive_failures ?? 0) + 1;
  const interval = escalateIntervalSecs(source.scan_interval_secs);
  store.sources.update(
    (s) => s.id === source.id,
    { consecutive_failures: failures, scan_interval_secs: interval, last_scan_at: isoNow },
  );
  const log = recordScanLog(store, {
    source_id: source.id,
    outcome,
    error: String(error).slice(0, 500),
    parsed: 0,
    skipped: 0,
    hash_changed: false,
    added: 0,
    removed: 0,
    unchanged: 0,
  });
  return { source_id: source.id, ok: false, matches: [], log };
}

/** The success path: diff, match, persist everything. New drops are returned
 * as *matches*; the pass turns them into alerts after cross-source dedupe. */
function succeedSource(store, source, { rawList, status }, isoNow) {
  const prev = store.scanSnapshots.find((s) => s.source_id === source.id);
  const { candidates, snapshot, log } = scanSnapshot({
    source_id: source.id,
    method: source.scan_method,
    prevSnapshot: prev ? { products: prev.products, hash: prev.hash } : null,
    rawList,
  });

  const baseline = !prev;
  const newCandidates = baseline ? [] : candidates;

  const artists = watchedArtists(store, source.user_id);
  const matches = dedupeCandidates(
    matchArtists(newCandidates, artists).map((m) => ({ ...m, source_id: source.id })),
  );

  if (prev) {
    store.scanSnapshots.update((s) => s.source_id === source.id, {
      hash: snapshot.hash,
      products: snapshot.products,
      updated_at: isoNow,
    });
  } else {
    store.scanSnapshots.insert({ source_id: source.id, hash: snapshot.hash, products: snapshot.products, updated_at: isoNow });
  }
  store.sources.update(
    (s) => s.id === source.id,
    { snapshot_hash: snapshot.hash, last_scan_at: isoNow, consecutive_failures: 0 },
  );
  const row = recordScanLog(store, {
    ...log,
    source_id: source.id,
    scanned_at: isoNow,
    outcome: 'ok',
    status_code: status,
    baseline,
  });
  return { source_id: source.id, ok: true, matches, log: row };
}

/**
 * Turn deduped matches into alert feed items: the content each channel would
 * send plus the notify path's dispatch verdict. Items whose verdict says
 * `dispatch: false` fold into the next digest — they are returned, never
 * dropped.
 *
 * `alreadySent` accumulates the pass's own dispatches so a restock flood
 * spread across sources folds into the digest instead of slipping past the
 * rate gate one source at a time.
 */
function buildAlerts(store, matches, nowMs) {
  // One rate-window ledger per user: the store's recent dispatches plus this
  // pass's own, so a flood spread across sources folds into the digest
  // instead of slipping past the gate one source at a time.
  const ledgers = new Map();
  const ledgerFor = (userId) => {
    if (!ledgers.has(userId)) ledgers.set(userId, sentThisWindow(store, userId, nowMs));
    return ledgers.get(userId);
  };
  const out = [];

  for (const m of matches ?? []) {
    const source = store.sources.find((s) => s.id === m.source_id);
    if (!source) continue;
    const user = store.users.find((u) => u.id === source.user_id);
    const plan = user?.plan ?? 'free';
    const watch = m.artist.watch ?? store.watches.find((w) => w.user_id === source.user_id && w.artist_id === m.artist.id);
    const channels = watch?.channels?.length ? watch.channels : ['email'];
    const label = sourceLabel(source);
    const sent = ledgerFor(source.user_id);
    const alertShape = { kind: 'drop', listing_url: m.product.url || source.url, price_cents: m.product.price_cents };
    const deliveries = [];

    if (channels.includes('email')) {
      const message = formatDropEmail({
        alert: alertShape,
        artistName: m.artist.name,
        releaseTitle: m.product.title,
        sourceLabel: label,
      });
      const verdict = shouldDispatch({ channel: 'email', plan, sentThisWindow: sent, now: nowMs });
      deliveries.push({ channel: 'email', message, verdict });
      if (verdict.dispatch) sent.push({ channel: 'email', sent_at: new Date(nowMs).toISOString() });
    }
    if (channels.includes('sms')) {
      if (user?.phone_verified === true) {
        const message = formatDropSms({
          alert: alertShape,
          artistName: m.artist.name,
          releaseTitle: m.product.title,
          sourceLabel: label,
        });
        const verdict = shouldDispatch({ channel: 'sms', plan, sentThisWindow: sent, now: nowMs });
        deliveries.push({ channel: 'sms', message, verdict });
        if (verdict.dispatch) sent.push({ channel: 'sms', sent_at: new Date(nowMs).toISOString() });
      } else {
        deliveries.push({
          channel: 'sms',
          message: null,
          verdict: { dispatch: false, reason: 'phone not verified — queued for the email digest instead' },
        });
      }
    }

    out.push({
      kind: 'drop',
      user_id: source.user_id,
      artist_id: m.artist.id,
      artist_name: m.artist.name,
      title: m.product.title,
      price_cents: m.product.price_cents,
      currency: m.product.currency,
      listing_url: m.product.url || source.url,
      source_label: label,
      sources_seen: m.sources_seen,
      detected_at: new Date(nowMs).toISOString(),
      deliveries,
    });
  }
  return out;
}

/**
 * Run one pass of the scan queue: every due source, in oldest-first order.
 *
 * This is the cron entry point — one invocation per tick, no timers, no
 * global state, so it fits a serverless cron or a one-minute systemd timer
 * equally well. Snapshot state lives in the store, not in memory, so a cold
 * start loses nothing but the in-flight pass.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {(source: object) => Promise<{ status: number, rawList: Array<object> }>} input.fetcher
 * @param {number} [input.nowMs]
 * @param {number} [input.limit] Max sources this pass. Defaults to `PASS_LIMIT`.
 * @returns {Promise<{ now: string, due: number, succeeded: number, failed: number, newAlerts: number, alerts: object[], results: object[] }>}
 */
export async function runScanPass({ store, fetcher, nowMs = Date.now(), limit = PASS_LIMIT }) {
  const due = selectDueSources(store.sources.all(), nowMs).slice(0, Math.max(0, limit));
  const results = [];
  const allMatches = [];

  for (const source of due) {
    const result = await scanOneSource({ store, source, fetcher, nowMs });
    results.push(result);
    allMatches.push(...result.matches);
  }

  // One release on three sites is one alert, not three — dedupe across the
  // whole pass, then feed the survivors into the notify path.
  const alerts = buildAlerts(store, dedupeCandidates(allMatches), nowMs);

  return {
    now: new Date(nowMs).toISOString(),
    due: due.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    newAlerts: alerts.length,
    alerts,
    results,
  };
}
