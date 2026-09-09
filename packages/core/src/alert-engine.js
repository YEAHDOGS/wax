/**
 * @file Wantlist alert-matching engine — the Discogs-batch half of the
 * alert engine (plan §4 item 4, "Artist matching + cross-source dedupe").
 *
 * `scanner.js` matches scan-worker candidates to followed artists and
 * `rules.js` evaluates watch rules on shop products. This module owns the
 * other ingestion path: a batch of Discogs-shaped releases (new releases,
 * restocks, price changes — fixtures during dev, the Discogs probe later)
 * matched against a user's wantlist, emitting typed alert events:
 *
 * - `new`        — first sight of a release passing all of a want's filters
 * - `restock`    — previously seen out-of-stock, now back in stock
 * - `price_drop` — previously seen price fell below the want's threshold
 *
 * Matching is fuzzy, never exact: artist names match by normalized
 * containment or shared tokens ("MF DOOM" matches "Mf Doom"; "Doom"
 * matches nothing on its own — the tokens must cover the want name).
 * Title matches by normalized substring; format and pressing filters
 * match the Discogs `formats` block. All filters on a want entry are
 * conjunctive — one miss and the release stays quiet.
 *
 * Price semantics: `max_price_cents` gates `new` and `restock` events
 * outright, and a `price_drop` fires only when the new price is both
 * lower than the last-seen price AND at or under the threshold. A release
 * with no known price never fires when a threshold is set — an unknown
 * price is not a deal.
 *
 * Pure functions, zero I/O. The caller owns `prevStates` (a map of
 * `user+release` → `{ price_cents, in_stock, seen_at }`); the engine
 * returns an updated copy so the state can persist wherever the caller
 * keeps it (store today, Postgres later).
 */

import { normText } from './rules.js';

/** The event kinds the engine emits, in priority order. */
export const EVENT_KINDS = Object.freeze(['price_drop', 'restock', 'new']);

/**
 * The key that identifies one user+release pair in the prior-state map.
 * Null ids fall back to normalized artist+title, so fixture data without
 * Discogs ids still keys correctly.
 * @param {string} userId
 * @param {object} release
 * @returns {string}
 */
export function prevStateKey(userId, release) {
  const releaseKey =
    release?.id != null
      ? String(release.id)
      : `${normText(releaseArtistName(release))}::${normText(release?.title)}`;
  return `${userId ?? ''}\u001f${releaseKey}`;
}

/**
 * @param {object} release
 * @returns {string} "MF DOOM / Madvillain" style artist line.
 */
export function releaseArtistName(release) {
  const artists = release?.artists ?? [];
  return artists
    .map((a) => a?.name ?? a?.anv ?? '')
    .filter(Boolean)
    .join(' / ');
}

/**
 * Fuzzy containment: normalized needle is a substring of the haystack,
 * or every token of the needle appears somewhere in the haystack.
 * Case/punctuation-insensitive via {@link normText}.
 * @param {?string} haystack
 * @param {?string} needle
 * @returns {boolean}
 */
export function fuzzyContains(haystack, needle) {
  const h = normText(haystack);
  const n = normText(needle);
  if (!n) return false;
  if (h.includes(n)) return true;
  const hayTokens = new Set(h.split(' ').filter(Boolean));
  return n
    .split(' ')
    .filter(Boolean)
    .every((t) => hayTokens.has(t));
}

/**
 * Whether any of the release's artists (by name or anv) fuzzily match the
 * want's artist or any of its aliases.
 * @param {object} want `{ artist, aliases? }`
 * @param {object} release
 * @returns {boolean}
 */
export function artistMatches(want, release) {
  const names = (release?.artists ?? []).map((a) => a?.name ?? a?.anv ?? '').filter(Boolean);
  const terms = [want?.artist, ...(want?.aliases ?? [])].filter(Boolean);
  return terms.some((term) => names.some((name) => fuzzyContains(name, term)));
}

/**
 * Whether the release passes every filter on the want entry. Artist match
 * is required (evaluated first and cheapest to fail fast); title/format/
 * pressing/price filters are optional per want.
 * @param {object} want
 * @param {object} release
 * @returns {{ match: boolean, reasons: string[] }} Failed filter names.
 */
export function wantMatchesRelease(want, release) {
  const reasons = [];
  if (!artistMatches(want, release)) {
    reasons.push('artist');
    return { match: false, reasons };
  }
  if (want?.title && !fuzzyContains(release?.title, want.title)) reasons.push('title');
  if (want?.format) {
    const formats = release?.formats ?? [];
    if (!formats.some((f) => fuzzyContains(f?.name, want.format))) reasons.push('format');
  }
  if (want?.pressing) {
    const descriptions = (release?.formats ?? []).flatMap((f) => f?.descriptions ?? []);
    if (!descriptions.some((d) => fuzzyContains(d, want.pressing))) reasons.push('pressing');
  }
  if (want?.max_price_cents != null) {
    const price = release?.price_cents;
    if (price == null || !Number.isFinite(price) || price > want.max_price_cents) {
      reasons.push('price');
    }
  }
  return { match: reasons.length === 0, reasons };
}

/**
 * Classify one want-matching release against its prior state.
 * Returns the event kind or `null` when nothing alert-worthy changed
 * (price rose, same price, already-seen-in-stock — all quiet).
 *
 * @param {object} input
 * @param {object} input.want
 * @param {object} input.release
 * @param {?{ price_cents: ?number, in_stock: ?boolean }} input.prev Prior state, `null` on first sight.
 * @returns {'new'|'restock'|'price_drop'|null}
 */
export function classifyEvent({ want, release, prev }) {
  const price = release?.price_cents ?? null;
  const inStock = release?.in_stock ?? null;

  if (!prev) {
    return 'new';
  }
  if (prev.in_stock === false && inStock === true) {
    return 'restock';
  }
  const threshold = want?.max_price_cents;
  if (
    prev.price_cents != null &&
    price != null &&
    price < prev.price_cents &&
    (threshold == null || price <= threshold)
  ) {
    return 'price_drop';
  }
  return null;
}

/**
 * Run one engine pass: match every want against every release, classify
 * against prior state, emit alert events, and return an updated
 * `prevStates` covering everything this pass observed.
 *
 * @param {object} input
 * @param {Array<object>} input.wantlist
 * @param {Array<object>} input.releases Discogs-shaped release batch.
 * @param {Record<string, { price_cents: ?number, in_stock: ?boolean, seen_at: string }>} [input.prevStates]
 * @param {number} [input.nowMs]
 * @returns {{ events: Array<object>, prevStates: Record<string, object> }}
 */
export function runEngine({ wantlist, releases, prevStates = {}, nowMs = Date.now() }) {
  const events = [];
  const nextStates = { ...prevStates };
  const matchedAt = new Date(nowMs).toISOString();

  for (const want of wantlist ?? []) {
    for (const release of releases ?? []) {
      const { match } = wantMatchesRelease(want, release);
      if (!match) continue;

      const key = prevStateKey(want.user_id, release);
      const prev = nextStates[key] ?? null;
      const kind = classifyEvent({ want, release, prev });
      const next = {
        price_cents: release?.price_cents ?? null,
        in_stock: release?.in_stock ?? null,
        seen_at: matchedAt,
      };
      nextStates[key] = next;

      if (kind) {
        events.push({
          kind,
          user_id: want.user_id,
          want_id: want?.id ?? null,
          release_id: release?.id ?? null,
          artist_name: releaseArtistName(release),
          title: release?.title ?? null,
          price_cents: release?.price_cents ?? null,
          prev_price_cents: prev?.price_cents ?? null,
          currency: release?.currency ?? null,
          in_stock: release?.in_stock ?? null,
          listing_url: release?.uri ?? null,
          matched_at: matchedAt,
        });
      }
    }
  }

  return { events, prevStates: nextStates };
}
