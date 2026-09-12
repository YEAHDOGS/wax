/**
 * Shared shapes for the alert engine.
 *
 * Everything here is plain data — no I/O, no network, no clock reads inside
 * the functions that consume these. That is what makes the evaluator pure and
 * the test suite fixture-only.
 */

/**
 * A single Discogs marketplace listing, as normalized by the catalog source.
 *
 * @typedef {object} Listing
 * @property {string}  id            Stable source id, e.g. `discogs:123456`.
 * @property {string}  release_id    The release this listing is for.
 * @property {number}  price_cents   Asking price, integer cents, source currency.
 * @property {string}  currency      ISO 4217, e.g. 'USD'.
 * @property {string}  condition     Media grade exactly as listed, e.g. 'NM'.
 * @property {boolean} available     False once the listing dies / sells out.
 * @property {?string} url           Deep link to the listing.
 * @property {?string} seller        Seller handle, for display only.
 */

/**
 * A pressing/variant of a release that exists in the catalog.
 *
 * @typedef {object} Pressing
 * @property {string}  id          Stable source id, e.g. `discogs:master:789`.
 * @property {string}  release_id  The parent release.
 * @property {string}  title       Human label, quoted in alerts.
 * @property {string}  format      e.g. 'LP', '2xLP', '7"'.
 * @property {?string} released_at ISO date, may be null for announced items.
 */

/**
 * A non-vinyl item of a watched merch type.
 *
 * @typedef {object} MerchItem
 * @property {string} id
 * @property {string} merch_type  e.g. 'tee', 'poster', 'test-pressing'.
 * @property {string} title
 * @property {?string} url
 */

/**
 * One observation of the market for a watched scope. Immutable — the
 * evaluator only ever diffs two of these.
 *
 * @typedef {object} Snapshot
 * @property {Object<string, Listing>}   listings   Keyed by listing id.
 * @property {Object<string, Pressing>}  pressings  Keyed by pressing id.
 * @property {Object<string, MerchItem>} merch      Keyed by merch item id.
 * @property {string} taken_at ISO timestamp of the poll.
 */

/**
 * A standing instruction to alert. Mirrors the `watches` row in
 * `packages/core/src/schema.sql`, plus engine-local fields.
 *
 * @typedef {object} AlertRule
 * @property {string}   id
 * @property {string}   user_id
 * @property {string}   scope_type   'artist' | 'release' | 'wantlist'
 * @property {string}   scope_id     artist id / release id / user id.
 * @property {boolean}  watch_vinyl
 * @property {string[]} merch_types
 * @property {?number}  target_price_cents
 * @property {number}   cooldown_hours   Min hours between same-kind refires.
 * @property {string[]} channels         'email' | 'sms' | 'push'.
 */

/**
 * An alert the engine decided to raise. Compatible with the `alerts` table:
 * `kind` is one of the CHECK-allowed values ('drop'|'price'|'restock'|'merch').
 *
 * @typedef {object} AlertCandidate
 * @property {'drop'|'price'|'restock'|'merch'} kind
 * @property {string}  rule_id
 * @property {string}  user_id
 * @property {string}  release_id
 * @property {?string} listing_id
 * @property {?number} price_cents
 * @property {?string} listing_url
 * @property {?string} source       'wantlist' for wantlist-scope drops.
 * @property {string}  detected_at  ISO timestamp.
 * @property {string}  dedup_key    Stable key for the anti-noise gate.
 */

/**
 * Memory the evaluator carries between polls. Plain JSON — the caller owns
 * persistence; the evaluator returns a new copy and never mutates the input.
 *
 * @typedef {object} EngineMemory
 * @property {Object<string, string>} fired_keys  dedup_key -> ISO fired at.
 * @property {Object<string, string>} last_fired  `${rule_id}:${kind}:${release_id}` -> ISO.
 * @property {Object<string, {count:number, window_start:string, quarantined_until:?string}>} flaps
 * @property {Object<string, number>} dispatched_by_day  'YYYY-MM-DD' -> count.
 */

export const ALERT_KINDS = ['drop', 'price', 'restock', 'merch'];

/** Dispatch priority: drops win, merch loses. Lower is more urgent. */
export const KIND_PRIORITY = { drop: 0, price: 1, restock: 2, merch: 3 };
