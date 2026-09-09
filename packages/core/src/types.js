/**
 * @file Record shapes for every table in `./schema.sql`, expressed as JSDoc
 * typedefs.
 *
 * There is no TypeScript in Wax and no build step here. These typedefs are the
 * whole type system: editors read them for completion and inline errors, and
 * `//  @ts-check` in a consuming file turns them into real diagnostics without
 * ever producing a `.ts` file or a `tsc` invocation.
 *
 * The contract this file maintains:
 *
 *   schema.sql column  ->  typedef property, same name, snake_case preserved
 *   NULL-able column   ->  `?type` (so `?string` means "string or null")
 *   integer cents      ->  `number`, always cents, never dollars
 *   timestamptz        ->  `string`, always an ISO-8601 UTC instant
 *   text[]             ->  `string[]`
 *   CHECK (x IN (...)) ->  a string-union typedef, declared next to the record
 *
 * A column that exists in the SQL and not here is a bug, and the reverse is a
 * worse one. Change the two files in the same commit.
 */

// ------------------------------------------------------------------ scalars

/**
 * An ISO-8601 instant in UTC, e.g. `'2026-07-28T05:14:28.000Z'`. Every
 * `timestamptz` column in the schema arrives on the JS side as one of these.
 * Never a `Date`: these cross the serverless boundary as JSON, and a `Date`
 * would survive that round trip as a string anyway.
 * @typedef {string} Timestamp
 */

/**
 * An integer number of cents. Money is never a float and never a formatted
 * string in this codebase — `1999` is $19.99, and formatting happens at the
 * last possible moment, in the view.
 * @typedef {number} Cents
 */

/**
 * One of the four press inks, plus the two grounds. The design system permits
 * no other fill on any surface, so this union is the complete set of legal
 * region colours.
 * @typedef {'ink'|'board'|'vermilion'|'cyan'|'chartreuse'|'ultramarine'} Ink
 */

/**
 * The subset of {@link Ink} allowed on a profile header — grounds excluded,
 * because a profile field must carry a saturated ink.
 * @typedef {'vermilion'|'cyan'|'chartreuse'|'ultramarine'} AccentInk
 */

// ----------------------------------------------------------------- identity

/**
 * Which plan a user is on.
 * - `free`   — three watches, forever, no card
 * - `trial`  — 30 days of `series`, reverts to `free` at `trial_ends_at`
 * - `series` — $10/month, unlimited watches
 * @typedef {'free'|'trial'|'series'} Plan
 */

/**
 * A user account. Private — never serialise one of these straight to a client
 * that is not the owner; use {@link PublicUser} for anyone else's row.
 *
 * @typedef {object} User
 * @property {string}    id             Stable id, e.g. `'usr_kestrel'`.
 * @property {string}    email          Unique, lowercased on write.
 * @property {string}    handle         Unique, no `@`, lowercase, e.g. `'kestrel'`.
 * @property {string}    display_name   What the UI prints. Free-form.
 * @property {?string}   avatar_url     Square image. Null renders as initials.
 * @property {Plan}      plan
 * @property {?Timestamp} trial_ends_at When `plan === 'trial'`, the reversion date.
 * @property {?string}   phone          E.164. Present does not mean usable — see below.
 * @property {boolean}   phone_verified An SMS dispatch requires this to be true.
 * @property {boolean}   email_verified An email dispatch requires this to be true.
 * @property {?string}   quiet_hours_start "HH:MM" UTC; alerts inside the quiet
 *           window defer to the digest. Null disables quiet hours.
 * @property {?string}   quiet_hours_end   "HH:MM" UTC, exclusive bound.
 * @property {Timestamp} created_at
 */

/**
 * The subset of a {@link User} that is safe to show to anybody. This is what
 * the social layer traffics in.
 *
 * @typedef {object} PublicUser
 * @property {string}  id
 * @property {string}  handle
 * @property {string}  display_name
 * @property {?string} avatar_url
 * @property {Plan}    plan
 */

/**
 * A bearer token row. The token itself is the primary key: there is no
 * separate id, because looking a session up by anything other than its token
 * is not an operation this product needs.
 *
 * @typedef {object} Session
 * @property {string}    token       Opaque. Sent as `Authorization: Bearer <token>`.
 * @property {string}    user_id
 * @property {Timestamp} created_at
 * @property {Timestamp} expires_at  Past this instant the token is dead; the
 *                                   store checks on read rather than sweeping.
 */

/**
 * A user's public face. Split from {@link User} so that "everything readable
 * by the world" and "everything readable only by the owner" are separated by a
 * table boundary rather than by a field whitelist somebody has to remember.
 *
 * @typedef {object} Profile
 * @property {string}    user_id
 * @property {string}    bio          May be empty, never null.
 * @property {?string}   location     Free-form, e.g. `'Chicago, IL'`.
 * @property {AccentInk} ink          The ink this profile's header prints in.
 * @property {string[]}  genres       Self-declared, used for taste overlap.
 * @property {boolean}   crate_public Whether strangers may read the crate.
 * @property {Timestamp} updated_at
 */

/**
 * A directed follow edge. Composite primary key `(follower_id, followee_id)`;
 * there is no id column because the pair *is* the identity.
 *
 * @typedef {object} Follow
 * @property {string}    follower_id
 * @property {string}    followee_id
 * @property {Timestamp} created_at
 */

// ------------------------------------------------------------------ catalog

/**
 * A musical artist, keyed to Discogs where possible.
 *
 * @typedef {object} Artist
 * @property {string}   id
 * @property {string}   name
 * @property {?number}  discogs_artist_id Null for artists Wax knows about but
 *                                        has not yet resolved on Discogs.
 * @property {?string}  image_url
 * @property {string[]} genres
 * @property {Timestamp} created_at
 */

/**
 * One physical pressing.
 *
 * The important modelling decision in this whole schema: a release is a
 * *pressing*, not an album. The black repress and the 500-copy splatter
 * variant are two rows. They sell out independently, they are watched
 * independently, and a collector who owns one may still want the other.
 * Collapsing them into one row would make the core alert wrong.
 *
 * @typedef {object} Release
 * @property {string}   id
 * @property {string}   cat           WAX 4000-series number, e.g. `'WAX 4118'`.
 *                                    Unique, printed on the sleeve, quoted in alerts.
 * @property {string}   artist_id
 * @property {string}   title
 * @property {?number}  year
 * @property {?string}  label         The issuing label, e.g. `'Ghostly International'`.
 * @property {?string}  label_cat     The label's own catalog number, not Wax's.
 * @property {string}   format        `'LP'`, `'2xLP'`, `'7"'`, `'Box Set'`, …
 * @property {?string}  variant       `'Splatter /500'`, `'Black'`, `'Test Pressing'`, …
 * @property {?number}  pressing_qty  Copies pressed, when the label states it.
 * @property {?string}  cover_url
 * @property {Ink}      ink           Fallback sleeve ink when `cover_url` is null.
 * @property {?number}  discogs_release_id
 * @property {?Timestamp} released_at
 * @property {Timestamp} created_at
 */

/**
 * A playable audio file.
 *
 * `release_id` is nullable on purpose: the player's catalog is wider than the
 * set of pressings Wax has caught, and a track that is not attached to a
 * pressing is still a track.
 *
 * @typedef {object} Track
 * @property {string}   id
 * @property {?string}  release_id
 * @property {string}   title
 * @property {string}   artist       Denormalised from the release deliberately —
 *                                   a track's credited artist is often not the
 *                                   release's (features, compilations).
 * @property {?string}  album
 * @property {?number}  year
 * @property {?string}  genre
 * @property {?string}  cover_url
 * @property {string}   audio_url    Playable URL. See `/api/stream`.
 * @property {?number}  duration_sec Null until something has decoded the file.
 *                                   The player reports the true value back once
 *                                   it knows it, so this fills in over time.
 * @property {?string}  attrib_url   Where to send someone who wants to buy it.
 *                                   Rendered as the credit link in the player.
 * @property {number}   position     Sort order within the catalog.
 * @property {Timestamp} created_at
 */

// ------------------------------------------------------------------- alerts

/**
 * Delivery channels for a dispatch. `push` is the app itself; `email` and
 * `sms` require the corresponding `*_verified` flag on the user.
 * @typedef {'email'|'sms'|'push'} Channel
 */

/**
 * A user-submitted merch site the alert engine scans. The probe verdict is
 * stored here at onboarding; per-site config (pause, interval override)
 * lives here too so a flaky source can be quieted without deleting it.
 *
 * @typedef {object} Source
 * @property {string}     id
 * @property {string}     user_id
 * @property {string}     url
 * @property {?string}    label
 * @property {string}     platform             Probe's platform guess.
 * @property {?('feed'|'platform-api'|'structured-data'|'sitemap'|'heuristic')} scan_method
 * @property {boolean}    scannable
 * @property {?string}    scannable_reason     Verdict detail shown to the user.
 * @property {?string}    snapshot_hash        Hash of the last scan's product list.
 * @property {number}     scan_interval_secs   Adaptive interval; 60s default.
 * @property {boolean}    paused
 * @property {?Timestamp} last_scan_at
 * @property {number}     consecutive_failures
 * @property {Timestamp}  created_at
 */

/**
 * One scan attempt against one merch site — the worker's attempt log
 * (ALERT-ENGINE-PLAN.md §2). Append-only: attempts, failures, new-item
 * counts, and the hash verdict that drove the queue.
 *
 * @typedef {object} ScanLog
 * @property {string}    id
 * @property {string}    source_id
 * @property {Timestamp} scanned_at
 * @property {'ok'|'fetch_failed'|'error'|'dispatch'|'digest'} outcome
 *   'dispatch' and 'digest' are delivery receipts, not scan attempts —
 *   they land here so every send is inspectable next to the attempts.
 * @property {?number}   status_code      HTTP status when the fetch answered.
 * @property {boolean}   baseline         First scan: snapshot stored, nothing alerted.
 * @property {number}    parsed           Raw records the fetch returned.
 * @property {number}    skipped          Records that could not normalize.
 * @property {boolean}   hash_changed
 * @property {number}    added            New products vs the stored snapshot.
 * @property {number}    removed
 * @property {number}    unchanged
 * @property {?string}   error            Failure detail, when outcome is not 'ok'.
 */

/**
 * The stored snapshot behind a source's `snapshot_hash`: the normalized
 * product list the next scan diffs against.
 *
 * @typedef {object} ScanSnapshot
 * @property {string}    source_id
 * @property {string}    hash
 * @property {Array<object>} products  Normalized products (jsonb in Postgres).
 * @property {Timestamp} updated_at
 */

/**
 * One held-back alert waiting for the next digest email. Written by the
 * digest queue (src/digest.js) when the notify gate holds a delivery
 * back; deleted when the digest is sent, when it expires, or when the
 * owning user/alert is deleted. Exactly one row per (user_id, alert_id).
 *
 * @typedef {object} DigestQueueItem
 * @property {string}    id
 * @property {string}    user_id
 * @property {string}    alert_id   The alert row that produced the held delivery.
 * @property {AlertKind} kind
 * @property {string}    artist_name
 * @property {string}    title
 * @property {?Cents}    price_cents
 * @property {?string}   listing_url
 * @property {?string}   source_label
 * @property {string}    reason     Why it was held back (joined with ' | ' when several).
 * @property {Timestamp} queued_at
 */

/**
 * A standing instruction: tell me about this artist.
 *
 * @typedef {object} Watch
 * @property {string}    id
 * @property {string}    user_id
 * @property {string}    artist_id
 * @property {boolean}   watch_vinyl        Alert on any new vinyl pressing.
 * @property {string[]}  merch_types        e.g. `['tee', 'poster']`. Empty means vinyl only.
 * @property {?Cents}    target_price_cents Alert when any listing crosses below this.
 * @property {?string}   title_contains Substring that must appear in the title.
 * @property {?string}   label_contains Substring that must appear in the label.
 * @property {Channel[]} channels
 * @property {Timestamp} created_at
 */

/**
 * Why an alert fired.
 * - `drop`    — a new pressing exists
 * - `price`   — a listing crossed the user's target
 * - `restock` — a dead listing came back
 * - `merch`   — a watched merch type appeared
 * @typedef {'drop'|'price'|'restock'|'merch'} AlertKind
 */

/**
 * Where an alert stands right now. This is the alert board's entire state
 * machine, and the only transitions that happen are:
 *
 *   watching -> live -> caught      (the user acted; the good ending)
 *   watching -> live -> sold_out    (the listing died first)
 *              live -> missed       (dispatched, expired unopened)
 *
 * @typedef {'live'|'caught'|'sold_out'|'watching'|'missed'} AlertState
 */

/**
 * One thing Wax told one user about.
 *
 * The gap between `detected_at` and `dispatched_at` is the number this whole
 * product is judged on, which is why both are stored rather than one.
 *
 * @typedef {object} Alert
 * @property {string}     id
 * @property {string}     user_id
 * @property {string}     release_id
 * @property {?string}    watch_id      Which standing instruction caught it.
 *                                      Null if the watch was since deleted.
 * @property {AlertKind}  kind
 * @property {AlertState} state
 * @property {Timestamp}  detected_at   When the watcher first saw it.
 * @property {?Timestamp} dispatched_at When the message actually left.
 * @property {?Timestamp} read_at       Null means unread; the board bolds it.
 * @property {Channel[]}  channels      Where it went.
 * @property {?string}    listing_url
 * @property {?Cents}     price_cents   The price at detection, not now.
 * @property {Timestamp}  created_at
 */

// -------------------------------------------------------- crate and pricing

/**
 * Discogs media grading, stored exactly as the grader gave it.
 * @typedef {'M'|'NM'|'VG+'|'VG'|'G+'|'G'|'F'|'P'} Condition
 */

/**
 * A record the user actually owns.
 *
 * @typedef {object} CrateItem
 * @property {string}     id
 * @property {string}     user_id
 * @property {string}     release_id
 * @property {Condition}  condition
 * @property {?Cents}     paid_cents   What they paid, for the "what your crate
 *                                     cost vs. what it's worth" figure.
 * @property {?Timestamp} acquired_at
 * @property {?string}    notes
 * @property {Timestamp}  created_at
 */

/**
 * A record the user is still hunting.
 *
 * @typedef {object} WantlistItem
 * @property {string}    id
 * @property {string}    user_id
 * @property {string}    release_id
 * @property {?Cents}    target_price_cents The number they would happily pay.
 * @property {Timestamp} created_at
 */

/**
 * One observation of the Discogs listing spread for a release.
 *
 * Append-only. The price *history* is the product, so a row here is never
 * updated in place — a new observation is a new row, always.
 *
 * @typedef {object} PricePoint
 * @property {string}    id
 * @property {string}    release_id
 * @property {Timestamp} observed_at
 * @property {Cents}     low_cents
 * @property {Cents}     median_cents
 * @property {Cents}     high_cents
 * @property {number}    listing_count How many listings the spread was taken from.
 */

// ----------------------------------------------------------------- activity

/**
 * @typedef {'caught'|'added'|'wanted'|'followed'|'played'|'commented'} ActivityVerb
 */

/**
 * A feed row. Deliberately generic — a verb plus a typed pointer — so that a
 * new kind of activity is a new `verb` value rather than a new table.
 *
 * @typedef {object} Activity
 * @property {string}       id
 * @property {string}       user_id
 * @property {ActivityVerb} verb
 * @property {'release'|'user'|'track'|'alert'} object_type
 * @property {string}       object_id
 * @property {Timestamp}    created_at
 */

// ------------------------------------------------------------- view models

/**
 * The shape the API actually returns for an alert board row: the alert, joined
 * to the release and artist it points at, so the client renders a row without
 * a second request.
 *
 * Joins happen here, in one place, rather than being assembled ad hoc per
 * screen. There is no resolver layer and there is not going to be one.
 *
 * @typedef {Alert & {
 *   release: Release,
 *   artist: Artist,
 *   in_crate: boolean,
 *   price: ?PricePoint
 * }} AlertRow
 */

/**
 * A crate row joined to what it points at, plus the current spread so the UI
 * can show paid-versus-worth without a second call.
 *
 * @typedef {CrateItem & {
 *   release: Release,
 *   artist: Artist,
 *   price: ?PricePoint
 * }} CrateRow
 */

/**
 * Everything the profile screen needs, in one response.
 *
 * @typedef {object} ProfileView
 * @property {PublicUser} user
 * @property {Profile}    profile
 * @property {object}     stats
 * @property {number}     stats.crate_count
 * @property {number}     stats.watch_count
 * @property {number}     stats.caught_count   Alerts that ended in `caught`.
 * @property {number}     stats.missed_count
 * @property {Cents}      stats.crate_paid     Sum of what they paid.
 * @property {Cents}      stats.crate_value    Sum of current median spread.
 * @property {number}     stats.follower_count
 * @property {number}     stats.following_count
 * @property {string[]}   stats.top_genres
 * @property {Array<{user: PublicUser, shared: number, overlap: number}>} neighbours
 *           Collectors with crate overlap, `overlap` being the share of this
 *           user's crate they also own, 0–1.
 * @property {Activity[]} activity
 */

/**
 * What `/api/auth/login` and `/api/auth/session` return.
 *
 * @typedef {object} SessionView
 * @property {string}     token
 * @property {Timestamp}  expires_at
 * @property {User}       user
 * @property {Profile}    profile
 */

// This module is documentation, not code. The export exists so that a bundler
// treats the file as a module and so `import '@wax/core/types'` is legal for
// its side effect of pulling the typedefs into scope.
// Version 3: digest_queue table + 'dispatch'/'digest' scan-log outcomes.
export const TYPES_VERSION = 3;
