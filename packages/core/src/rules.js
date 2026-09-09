/**
 * @file Alert rule engine — the decision layer between the scan worker and
 * dispatch (plan §4 item 4, "Artist matching + cross-source dedupe", the
 * build-order item after dispatch).
 *
 * `scanner.js` matches candidates to artists by name/alias; `notify.js`
 * decides *whether a message may leave right now* (rate caps, free-tier SMS
 * gate). This module owns everything in between, as pure functions the
 * worker calls per pass:
 *
 * 1. **Rule evaluation** — `evaluateWatchRule` scores one candidate product
 *    against one watch rule: artist match (required), optional
 *    `title_contains` / `label_contains` matchers, and the
 *    `target_price_cents` condition. A rule that does not match never
 *    becomes an alert, so a collector watching "MF DOOM — test pressings
 *    under $200" is never woken by a DOOM tee at $40.
 * 2. **Dedupe** — `routeAlerts` guarantees no double-alert: the same release
 *    appearing twice in one pass, or re-appearing in a later pass after it
 *    already went out, routes to exactly one decision and never to two
 *    sends. The persisted `alerts` rows are the exactly-once marker.
 * 3. **Quiet hours** — `isQuietHour` + routing: alerts during a user's
 *    quiet window are *deferred to the digest*, never dropped and never
 *    sent at 3am.
 * 4. **Digest batching** — `buildDigestBatch` folds deferred alerts into
 *    one digest message; `shouldFlushDigest` tells the worker when the
 *    queue may leave.
 *
 * Zero network I/O, zero store writes — the worker persists. Routing never
 * throws: a malformed rule is a `drop` with a reason, not a crash, because
 * one bad watch row must not take down the whole pass.
 */

import { matchArtists } from './scanner.js';
import { shouldDispatch, formatDigest } from './notify.js';

/* ------------------------------------------------------------------ *
 * Matching primitives
 * ------------------------------------------------------------------ */

/**
 * Normalize a string for matcher comparison: lowercase, collapse
 * whitespace, strip punctuation. Deliberately separate from the scanner's
 * identity normalization — this is matcher text, not a dedupe key.
 * @param {?string} s
 * @returns {string}
 */
export function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The dedupe key for one user-facing alert: user + normalized artist +
 * normalized title. Two rows with the same key are the same news, whether
 * they surfaced from one source or three, one pass or five.
 * @param {object} input
 * @param {string} input.user_id
 * @param {?string} input.artist_name
 * @param {?string} input.title
 * @returns {string}
 */
export function alertDedupeKey({ user_id, artist_name, title }) {
  return [user_id ?? '', normText(artist_name), normText(title)].join('\u001f');
}

/**
 * Parse a `"HH:MM"` quiet-hours bound. Returns minutes past midnight UTC,
 * or `null` when the value is missing or malformed — malformed input is
 * "no quiet hours", never a crash.
 * @param {?string} hhmm
 * @returns {?number}
 */
export function parseQuietBound(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Whether `nowMs` falls inside the user's quiet window. Windows wrap
 * overnight (`22:00`–`07:00` is nine quiet hours); a missing or malformed
 * bound disables quiet hours entirely. Hours are UTC — the UI converts the
 * user's local bedtime before storing.
 * @param {object} input
 * @param {?string} input.quiet_start `"HH:MM"` UTC, inclusive.
 * @param {?string} input.quiet_end   `"HH:MM"` UTC, exclusive.
 * @param {number} [input.nowMs]
 * @returns {boolean}
 */
export function isQuietHour({ quiet_start, quiet_end, nowMs = Date.now() }) {
  const start = parseQuietBound(quiet_start);
  const end = parseQuietBound(quiet_end);
  if (start === null || end === null || start === end) return false;
  const d = new Date(nowMs);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/* ------------------------------------------------------------------ *
 * Rule evaluation
 * ------------------------------------------------------------------ */

/**
 * A watch rule: the stored `watches` row plus the artist it watches, plus
 * the optional text matchers. Fields the worker does not know yet
 * (`title_contains`, `label_contains`) are plain nullable strings — the
 * schema carries them, the UI fills them.
 *
 * @typedef {object} WatchRule
 * @property {string}    id
 * @property {string}    user_id
 * @property {string}    artist_id
 * @property {{ name: string, aliases?: string[] }} artist
 * @property {?string}   title_contains  Substring that must appear in the title.
 * @property {?string}   label_contains  Substring that must appear in the label.
 * @property {?number}   target_price_cents Alert only at or under this price.
 * @property {string[]}  [channels]
 */

/**
 * Score one candidate product against one watch rule.
 *
 * - The artist match is required and reuses the scanner's
 *   `matchArtists`, so the rule engine and the scan pass can never
 *   disagree about who "MF DOOM" is.
 * - `title_contains` / `label_contains` narrow the rule; a product with
 *   no label cannot satisfy a label rule.
 * - `target_price_cents` only fires at or under the target. An unknown
 *   price still alerts — missing data suppresses nothing.
 *
 * @param {object} input
 * @param {object} input.product Normalized product (see `scanner.js`).
 * @param {WatchRule} input.rule
 * @returns {{ match: boolean, reasons: string[] }}
 */
export function evaluateWatchRule({ product, rule }) {
  const reasons = [];
  if (!product || typeof product !== 'object') return { match: false, reasons: ['no product'] };
  if (!rule || typeof rule !== 'object') return { match: false, reasons: ['no rule'] };

  const artist = rule.artist;
  if (!artist || !artist.name) return { match: false, reasons: ['rule has no artist'] };
  // Accept both shapes: scanner products carry `artist`, feed items carry
  // `artist_name`. The rule engine sits between them, so it speaks both.
  const productForMatch = { ...product, artist: product.artist ?? product.artist_name ?? '' };
  const artistHit = matchArtists([productForMatch], [{ id: rule.artist_id, name: artist.name, aliases: artist.aliases }]);
  if (artistHit.length === 0) {
    return { match: false, reasons: [`artist "${productForMatch.artist}" does not match "${artist.name}"`] };
  }
  reasons.push(`artist match: ${artist.name}`);

  const titleNeedle = normText(rule.title_contains);
  if (titleNeedle) {
    if (!normText(product.title).includes(titleNeedle)) {
      return { match: false, reasons: [...reasons, `title lacks "${rule.title_contains}"`] };
    }
    reasons.push(`title match: "${rule.title_contains}"`);
  }

  const labelNeedle = normText(rule.label_contains);
  if (labelNeedle) {
    const label = normText(product.label);
    if (!label) {
      return { match: false, reasons: [...reasons, `label rule "${rule.label_contains}" but product has no label`] };
    }
    if (!label.includes(labelNeedle)) {
      return { match: false, reasons: [...reasons, `label lacks "${rule.label_contains}"`] };
    }
    reasons.push(`label match: "${rule.label_contains}"`);
  }

  const target = rule.target_price_cents;
  if (target !== null && target !== undefined && Number.isFinite(Number(target))) {
    const cents = product.price_cents;
    if (Number.isFinite(cents) && cents > Number(target)) {
      return { match: false, reasons: [...reasons, `price $${(cents / 100).toFixed(2)} above target $${(Number(target) / 100).toFixed(2)}`] };
    }
    reasons.push(Number.isFinite(cents) ? `price within target ($${(cents / 100).toFixed(2)})` : 'price unknown — alerting anyway');
  }

  return { match: true, reasons };
}

/* ------------------------------------------------------------------ *
 * Dedupe
 * ------------------------------------------------------------------ */

/**
 * Has this user already been told about this release? A persisted alert row
 * with `dispatched_at` set and at least one channel in `channels` is the
 * exactly-once marker — rows where every send failed do NOT count, so a
 * failed dispatch may retry on the next pass instead of going silent.
 * @param {object} store A `@wax/core` store.
 * @param {string} key From {@link alertDedupeKey}.
 * @returns {boolean}
 */
export function alreadyAlerted(store, key) {
  if (!store || !key) return false;
  return store.alerts
    .filter((a) => a && a.dispatched_at && (a.channels ?? []).length > 0)
    .some((a) => alertDedupeKey({ user_id: a.user_id, artist_name: a.artist_name, title: a.title }) === key);
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

/** The three places a candidate alert can go. */
export const ROUTE = Object.freeze({
  SEND_NOW: 'send-now',
  DEFER_DIGEST: 'defer-digest',
  DROP: 'drop',
});

/**
 * Route one candidate alert to its destination.
 *
 * Decision order, each step final:
 *
 * 1. The rule does not match → `drop` (should not happen when the worker
 *    pre-filters, but the engine never trusts its caller).
 * 2. The user was already told → `drop`, dedupe holds.
 * 3. Quiet hours → `defer-digest`. A 3am drop is news for breakfast, not
 *    a 3am text.
 * 4. The notify gate (`shouldDispatch` — rate caps, free-tier SMS gate):
 *    `dispatch: false` folds into the digest, `true` sends now.
 *
 * @param {object} input
 * @param {object} input.item Candidate: `{ user_id, artist_name, title, price_cents, ... }`.
 * @param {WatchRule} input.rule
 * @param {object} input.user The user row (carries quiet hours).
 * @param {object} input.store A `@wax/core` store.
 * @param {import('./types.js').Channel} input.channel
 * @param {'free'|'trial'|'series'} input.plan
 * @param {Array<{ channel: string, sent_at: string }>} input.sentThisWindow
 * @param {number} [input.nowMs]
 * @returns {{ route: string, reasons: string[] }}
 */
export function routeAlert({ item, rule, user, store, channel, plan, sentThisWindow, nowMs = Date.now() }) {
  const evalResult = evaluateWatchRule({ product: item, rule });
  if (!evalResult.match) {
    return { route: ROUTE.DROP, reasons: ['rule did not match', ...evalResult.reasons] };
  }

  const key = alertDedupeKey({ user_id: item?.user_id, artist_name: item?.artist_name, title: item?.title });
  if (alreadyAlerted(store, key)) {
    return { route: ROUTE.DROP, reasons: [...evalResult.reasons, 'dedupe: user was already alerted about this release'] };
  }

  if (isQuietHour({ quiet_start: user?.quiet_hours_start, quiet_end: user?.quiet_hours_end, nowMs })) {
    return {
      route: ROUTE.DEFER_DIGEST,
      reasons: [...evalResult.reasons, `quiet hours (${user.quiet_hours_start}–${user.quiet_hours_end} UTC) — deferred to digest`],
    };
  }

  const verdict = shouldDispatch({ channel, plan, sentThisWindow: sentThisWindow ?? [], now: nowMs });
  if (verdict.dispatch) {
    return { route: ROUTE.SEND_NOW, reasons: [...evalResult.reasons, 'notify gate: ok'] };
  }
  return { route: ROUTE.DEFER_DIGEST, reasons: [...evalResult.reasons, `notify gate held it: ${verdict.reason}`] };
}

/**
 * Route a whole pass of candidate alerts. Batch-level dedupe runs first:
 * the same release matched twice in one pass (two sources, two rules) is
 * one decision, not two — the first keeps its routing, the second is a
 * `drop` marked `duplicate in batch`.
 *
 * @param {object} input
 * @param {Array<object>} input.items Candidate alerts, each with `user_id`, `artist_name`, `title`.
 * @param {Array<WatchRule>} input.rules Rules parallel to `items`.
 * @param {object} input.user The user row (one user per batch).
 * @param {object} input.store A `@wax/core` store.
 * @param {import('./types.js').Channel} input.channel
 * @param {'free'|'trial'|'series'} input.plan
 * @param {Array<{ channel: string, sent_at: string }>} input.sentThisWindow
 * @param {number} [input.nowMs]
 * @returns {{ sendNow: Array<{ item: object, reasons: string[] }>, digest: Array<{ item: object, reasons: string[] }>, dropped: Array<{ item: object, reasons: string[] }> }}
 */
export function routeAlerts({ items, rules, user, store, channel, plan, sentThisWindow, nowMs = Date.now() }) {
  const sendNow = [];
  const digest = [];
  const dropped = [];
  const seen = new Set();

  const list = items ?? [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const rule = rules?.[i];
    const key = alertDedupeKey({ user_id: item?.user_id, artist_name: item?.artist_name, title: item?.title });
    if (seen.has(key)) {
      dropped.push({ item, reasons: ['duplicate in batch: same release already routed this pass'] });
      continue;
    }
    seen.add(key);
    const { route, reasons } = routeAlert({ item, rule, user, store, channel, plan, sentThisWindow, nowMs });
    if (route === ROUTE.SEND_NOW) sendNow.push({ item, reasons });
    else if (route === ROUTE.DEFER_DIGEST) digest.push({ item, reasons });
    else dropped.push({ item, reasons });
  }
  return { sendNow, digest, dropped };
}

/* ------------------------------------------------------------------ *
 * Digest batching
 * ------------------------------------------------------------------ */

/**
 * Whether the worker may flush this user's digest queue right now: yes
 * whenever it is NOT quiet hours. Deferred alerts wait for morning; they
 * never wait past it.
 * @param {object} input
 * @param {object} input.user
 * @param {number} [input.nowMs]
 * @returns {boolean}
 */
export function shouldFlushDigest({ user, nowMs = Date.now() }) {
  return !isQuietHour({ quiet_start: user?.quiet_hours_start, quiet_end: user?.quiet_hours_end, nowMs });
}

/**
 * Fold routed digest items into one digest email, reusing the notify
 * layer's `formatDigest` — one subject, one body, every deferred alert in
 * it. Nothing here sends; the worker hands the result to the dispatch
 * layer's email channel.
 *
 * @param {object} input
 * @param {Array<{ item: object }>} input.items Routed items (from `routeAlerts`' `digest` bucket).
 * @param {string} [input.windowLabel] e.g. `'overnight'` or `'the last hour'`.
 * @returns {{ subject: string, text: string, count: number }}
 */
export function buildDigestBatch({ items, windowLabel = 'the last hour' }) {
  const list = items ?? [];
  const { subject, text } = formatDigest({
    items: list.map(({ item }) => ({
      alert: { kind: item?.kind ?? 'drop', price_cents: item?.price_cents ?? null, listing_url: item?.listing_url ?? null },
      artistName: item?.artist_name ?? 'Unknown artist',
      releaseTitle: item?.title ?? 'Untitled',
      sourceLabel: item?.source_label ?? null,
    })),
    windowLabel,
  });
  return { subject, text, count: list.length };
}
