/**
 * Pure matchers: each takes a rule and two snapshots and returns alert
 * candidates. No I/O, no clock — the caller supplies `now` so tests can pin
 * time. Matchers never dedupe or rate-limit; that is the evaluator's job.
 */

import { KIND_PRIORITY } from './types.js';

const byId = (obj) => obj ?? {};

/**
 * Fire when any listing for the rule's scope crosses at or below the user's
 * target price. The listing must be *newly* at-or-below target: it was absent
 * last poll, or it was above target last poll. A listing that was already
 * under target is not news.
 *
 * @param {import('./types.js').AlertRule} rule
 * @param {import('./types.js').Snapshot} prev
 * @param {import('./types.js').Snapshot} next
 * @param {string} now ISO timestamp
 * @returns {import('./types.js').AlertCandidate[]}
 */
export function matchPriceDrop(rule, prev, next, now) {
  if (rule.target_price_cents == null) return [];
  const out = [];
  const prevListings = byId(prev.listings);
  for (const listing of Object.values(byId(next.listings))) {
    if (!listing.available) continue;
    if (!inScope(rule, listing.release_id)) continue;
    if (listing.price_cents > rule.target_price_cents) continue;
    const before = prevListings[listing.id];
    const wasBelow = before && before.available && before.price_cents <= rule.target_price_cents;
    if (wasBelow) continue; // already under target — not news
    out.push({
      kind: 'price',
      rule_id: rule.id,
      user_id: rule.user_id,
      release_id: listing.release_id,
      listing_id: listing.id,
      price_cents: listing.price_cents,
      listing_url: listing.url ?? null,
      source: null,
      detected_at: now,
      dedup_key: dedupKey(
        rule.id,
        'price',
        listing.release_id,
        listing.id,
        priceBucket(listing.price_cents),
        prev.taken_at, // per crossing — a re-cross after rising above is new news
      ),
    });
  }
  return out;
}

/**
 * Fire when a pressing appears in the catalog that was not there last poll.
 * For wantlist-scope rules the candidate is tagged `source: 'wantlist'` so
 * the board can render "On your wantlist" while keeping kind 'drop'.
 */
export function matchNewPressing(rule, prev, next, now) {
  if (!rule.watch_vinyl) return [];
  const out = [];
  const prevPressings = byId(prev.pressings);
  for (const pressing of Object.values(byId(next.pressings))) {
    if (prevPressings[pressing.id]) continue;
    if (!inScope(rule, pressing.release_id)) continue;
    out.push({
      kind: 'drop',
      rule_id: rule.id,
      user_id: rule.user_id,
      release_id: pressing.release_id,
      listing_id: null,
      price_cents: null,
      listing_url: null,
      source: rule.scope_type === 'wantlist' ? 'wantlist' : null,
      detected_at: now,
      dedup_key: dedupKey(rule.id, 'drop', pressing.release_id, pressing.id),
    });
  }
  return out;
}

/**
 * Fire when a listing that was previously observed as dead is available
 * again. A listing that never existed before is a *new* listing, not a
 * restock — it belongs to the price matcher, not this one.
 */
export function matchRestock(rule, prev, next, now) {
  const out = [];
  const prevListings = byId(prev.listings);
  for (const listing of Object.values(byId(next.listings))) {
    if (!listing.available) continue;
    if (!inScope(rule, listing.release_id)) continue;
    const before = prevListings[listing.id];
    if (!before || before.available) continue; // new or still alive — not a restock
    out.push({
      kind: 'restock',
      rule_id: rule.id,
      user_id: rule.user_id,
      release_id: listing.release_id,
      listing_id: listing.id,
      price_cents: listing.price_cents,
      listing_url: listing.url ?? null,
      source: null,
      detected_at: now,
      dedup_key: dedupKey(
        rule.id,
        'restock',
        listing.release_id,
        listing.id,
        prev.taken_at, // per dead->live transition — each restock is its own event
      ),
    });
  }
  return out;
}

/**
 * Fire when an item of a watched merch type appears that was not there last
 * poll. Rules with empty `merch_types` watch vinyl only and never fire here.
 */
export function matchMerch(rule, prev, next, now) {
  if (!rule.merch_types || rule.merch_types.length === 0) return [];
  const wanted = new Set(rule.merch_types);
  const out = [];
  const prevMerch = byId(prev.merch);
  for (const item of Object.values(byId(next.merch))) {
    if (prevMerch[item.id]) continue;
    if (!wanted.has(item.merch_type)) continue;
    out.push({
      kind: 'merch',
      rule_id: rule.id,
      user_id: rule.user_id,
      release_id: item.release_id ?? null,
      listing_id: item.id,
      price_cents: item.price_cents ?? null,
      listing_url: item.url ?? null,
      source: null,
      detected_at: now,
      dedup_key: dedupKey(rule.id, 'merch', item.release_id ?? 'merch', item.id),
    });
  }
  return out;
}

/**
 * A release is in scope when the rule watches its artist (artist rules cover
 * every release), the release itself, or the user's whole wantlist.
 * In the MVP the caller pre-filters snapshots to the rule's scope, so this
 * is a safety net rather than the primary filter — snapshots arriving from
 * the catalog source may contain a whole artist's spread.
 */
function inScope(rule, releaseId) {
  if (rule.scope_type === 'release') return rule.scope_id === releaseId;
  return true; // 'artist' and 'wantlist' rules match any release in the snapshot
}

/** Dollar-bucket the price so a $0.50 wiggle does not defeat dedup. */
function priceBucket(cents) {
  if (cents == null) return 'none';
  return `b${Math.floor(cents / 100)}`;
}

function dedupKey(...parts) {
  return parts.map((p) => String(p ?? '')).join('|');
}

/** Sort candidates by dispatch priority (drops first). Stable. */
export function byPriority(candidates) {
  return [...candidates].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}
