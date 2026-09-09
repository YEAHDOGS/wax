-- Wax — relational schema.
--
-- Plain Postgres DDL. No ORM, no generated resolvers, no migration framework:
-- this file is the schema, and every table here has a matching factory in
-- ./types.js and a matching collection in ./store.js. When you change one,
-- change all three.
--
-- Conventions, applied without exception:
--   * ids are text, human-readable where a human will ever read them
--     ('usr_kestrel', 'WAX 4118'), uuid-shaped only where they are opaque
--   * money is integer cents, never float, never a formatted string
--   * timestamps are timestamptz, always UTC, always named *_at
--   * enumerated values are text + CHECK, not native enum types, so adding a
--     value is an ordinary migration instead of a lock
--   * every foreign key names its on-delete behaviour explicitly

BEGIN;

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id            text        PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  handle        text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  avatar_url    text,
  -- 'free' tracks three artists; 'series' is the $10/mo unlimited plan.
  plan          text        NOT NULL DEFAULT 'free'
                            CHECK (plan IN ('free', 'series', 'trial')),
  trial_ends_at timestamptz,
  -- Where alerts are allowed to reach this user. Verified separately from
  -- stored, because an unverified number must never receive a dispatch.
  phone         text,
  phone_verified  boolean   NOT NULL DEFAULT false,
  email_verified  boolean   NOT NULL DEFAULT false,
  -- Quiet hours the user set, "HH:MM" in UTC (the UI converts the user's
  -- local bedtime before storing). The rule engine defers alerts inside the
  -- window to the digest; null on either side disables quiet hours.
  quiet_hours_start text,
  quiet_hours_end   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token       text        PRIMARY KEY,
  user_id     text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- The public face of a user. Split from `users` because everything here is
-- world-readable and everything in `users` is not.
CREATE TABLE profiles (
  user_id      text        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio          text        NOT NULL DEFAULT '',
  location     text,
  -- The ink a profile's header field is printed in. One of the four press
  -- inks; the design system forbids anything else.
  ink          text        NOT NULL DEFAULT 'vermilion'
                           CHECK (ink IN ('vermilion', 'cyan', 'chartreuse', 'ultramarine')),
  genres       text[]      NOT NULL DEFAULT '{}',
  crate_public boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE follows (
  follower_id text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX follows_followee_idx ON follows (followee_id);

-- ----------------------------------------------------------------- catalog --

CREATE TABLE artists (
  id                text   PRIMARY KEY,
  name              text   NOT NULL,
  discogs_artist_id integer UNIQUE,
  image_url         text,
  genres            text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artists_name_idx ON artists (lower(name));

-- A release is one physical pressing, not one album: the same record in black
-- and in splatter is two rows, because they sell out independently and a
-- collector wants an alert for exactly one of them.
CREATE TABLE releases (
  id                 text        PRIMARY KEY,
  -- WAX 4000-series catalog number. Every object a user can see has one; it is
  -- printed on the sleeve and quoted in alerts.
  cat                text        NOT NULL UNIQUE,
  artist_id          text        NOT NULL REFERENCES artists(id) ON DELETE RESTRICT,
  title              text        NOT NULL,
  year               integer,
  label              text,
  label_cat          text,
  format             text        NOT NULL DEFAULT '2xLP',
  variant            text,
  pressing_qty       integer,
  cover_url          text,
  -- The ink this release's sleeve is printed in when no artwork is available.
  ink                text        NOT NULL DEFAULT 'ink'
                                 CHECK (ink IN ('ink', 'board', 'vermilion', 'cyan', 'chartreuse', 'ultramarine')),
  discogs_release_id integer     UNIQUE,
  released_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX releases_artist_idx ON releases (artist_id);
CREATE INDEX releases_released_idx ON releases (released_at DESC);

-- Audio attached to a release. Nullable release_id because the player's
-- catalog is broader than the pressings Wax has caught.
CREATE TABLE tracks (
  id           text        PRIMARY KEY,
  release_id   text        REFERENCES releases(id) ON DELETE SET NULL,
  title        text        NOT NULL,
  artist       text        NOT NULL,
  album        text,
  year         integer,
  genre        text,
  cover_url    text,
  -- The playable file. Served through /api/stream so the client gets CORS and
  -- range support regardless of where the bytes actually live.
  audio_url    text        NOT NULL,
  -- Seconds. Null until something has actually decoded the file; the player
  -- reads the true duration from the audio element and reports it back.
  duration_sec integer,
  attrib_url   text,
  position     integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tracks_release_idx ON tracks (release_id);

-- ------------------------------------------------------------------ sources --

-- A user-submitted merch site the alert engine scans for new drops. The probe
-- (probe.js, alert engine gate 1) writes the verdict here at onboarding; the
-- scan queue reads scan_interval_secs/paused/snapshot_hash on every pass.
CREATE TABLE sources (
  id                 text        PRIMARY KEY,
  user_id            text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url                text        NOT NULL,
  label              text,
  -- Platform guess from the probe, e.g. 'shopify', 'bandcamp', 'bigcartel',
  -- 'unknown'. Feeds the fetch strategy the worker chooses.
  platform           text        NOT NULL DEFAULT 'unknown',
  scan_method        text        CHECK (scan_method IN
                        ('feed', 'platform-api', 'structured-data', 'sitemap', 'heuristic')),
  scannable          boolean     NOT NULL DEFAULT false,
  scannable_reason   text,
  snapshot_hash      text,
  -- Adaptive scan interval in seconds. Starts at 60 for cheap structured
  -- sources (ALERT-ENGINE-PLAN.md §2), backs off on failures.
  scan_interval_secs integer     NOT NULL DEFAULT 60,
  paused             boolean     NOT NULL DEFAULT false,
  last_scan_at       timestamptz,
  consecutive_failures integer   NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)
);

CREATE INDEX sources_user_idx ON sources (user_id);

-- ------------------------------------------------------------------ alerts --

-- What a user asked to be told about. The free tier caps this at three rows
-- per user; the cap is enforced in the handler, not here, because the limit is
-- a product decision and this table outlives it.
CREATE TABLE watches (
  id                 text        PRIMARY KEY,
  user_id            text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id          text        NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  watch_vinyl        boolean     NOT NULL DEFAULT true,
  -- Merch categories to watch, e.g. {'tee','poster','test-pressing'}. Empty
  -- means vinyl only.
  merch_types        text[]      NOT NULL DEFAULT '{}',
  -- Alert me if any listing for this artist's releases drops below this.
  target_price_cents integer,
  -- Optional text matchers narrowing the rule, e.g. 'test press' or a label
  -- name. Null means no constraint; the rule engine evaluates them in
  -- src/rules.js.
  title_contains text,
  label_contains text,
  channels           text[]      NOT NULL DEFAULT '{email}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, artist_id)
);

CREATE INDEX watches_artist_idx ON watches (artist_id);

-- One row per thing Wax told one user about. This is the alert board.
CREATE TABLE alerts (
  id            text        PRIMARY KEY,
  user_id       text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id    text        NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  watch_id      text        REFERENCES watches(id) ON DELETE SET NULL,
  kind          text        NOT NULL
                            CHECK (kind IN ('drop', 'price', 'restock', 'merch')),
  -- live      : listing is up and buyable right now
  -- caught    : user acted on it (bought, or added to crate from the alert)
  -- sold_out  : the listing died before the user acted
  -- watching  : known pressing, not yet listed anywhere
  -- missed    : dispatched, expired unopened
  state         text        NOT NULL DEFAULT 'live'
                            CHECK (state IN ('live', 'caught', 'sold_out', 'watching', 'missed')),
  -- When the watcher first saw it, and when the message actually left. The gap
  -- between these two is the number the whole product is judged on.
  detected_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  read_at       timestamptz,
  channels      text[]      NOT NULL DEFAULT '{}',
  listing_url   text,
  price_cents   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_board_idx ON alerts (user_id, detected_at DESC);
CREATE INDEX alerts_state_idx ON alerts (user_id, state);

-- Held-back alerts waiting for the next digest email. The notify gate
-- (src/notify.js) folds excess alerts into "the next digest instead of
-- dropping them"; this table is that promise. One row per (user, alert):
-- the same release is never queued twice. Rows die on success (flush),
-- on expiry (a week — the queue is a buffer, not an archive), or on
-- user/alert deletion.
CREATE TABLE digest_queue (
  id            text        PRIMARY KEY,
  user_id       text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id      text        NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  kind          text        NOT NULL DEFAULT 'drop'
                            CHECK (kind IN ('drop', 'price', 'restock', 'merch')),
  artist_name   text        NOT NULL,
  title         text        NOT NULL,
  price_cents   integer,
  listing_url   text,
  source_label  text,
  -- Why the alert was held back: rate cap, free-tier SMS denial,
  -- unverified phone, quiet hours. Joined ' | ' when several applied.
  reason        text        NOT NULL DEFAULT 'held for digest',
  queued_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, alert_id)
);

CREATE INDEX digest_queue_user_idx ON digest_queue (user_id, queued_at);

-- Alert subscriptions (double opt-in, src/subscriptions.js). One row per
-- (channel, recipient, filter): re-subscribing an active or pending row
-- returns it instead of duplicating. `confirm_token` is the proof of
-- ownership for both the confirmation link and one-click unsubscribe (the
-- plan's List-Unsubscribe flow). `filter_key` is the canonicalized filter
-- JSON, so idempotency compares exactly what the user asked to watch.
CREATE TABLE alert_subscriptions (
  id              text        PRIMARY KEY,
  email           text,
  phone           text,
  recipient       text        NOT NULL,
  channel         text        NOT NULL CHECK (channel IN ('email', 'sms')),
  filter          jsonb       NOT NULL DEFAULT '{}',
  filter_key      text        NOT NULL,
  state           text        NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'active', 'unsubscribed')),
  confirm_token   text        NOT NULL UNIQUE,
  confirm_receipt jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX alert_subscriptions_recipient_idx ON alert_subscriptions (recipient, state);

-- Subscribe/confirm attempt log (src/subscriptions.js rate-limit guard).
-- One row per attempt; the in-memory store holds these today and the
-- Postgres swap enforces them with the same sliding-window count:
-- per-address subscribe throttling plus per-token confirm-attempt caps,
-- so list-bombing and token probing both have a price.
CREATE TABLE subscribe_attempt (
  id   text        PRIMARY KEY,
  key  text        NOT NULL,  -- channel:address for subscribes, the presented token for confirms
  kind text        NOT NULL CHECK (kind IN ('subscribe', 'confirm')),
  at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscribe_attempt_key_idx ON subscribe_attempt (kind, key, at DESC);

-- ------------------------------------------------------- scan worker --

-- The scan worker's attempt log (ALERT-ENGINE-PLAN.md §2): one row per scan
-- attempt per source — attempts, failures, new-item counts. The same
-- transparency pattern as DOGS Remote's attempt log; the dashboard reads
-- this to show scan health.
CREATE TABLE scan_logs (
  id            text        PRIMARY KEY,
  source_id     text        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  -- 'dispatch' and 'digest' are the alert engine's delivery receipts
  -- (src/dispatch.js, src/digest.js) — logged here so every send is
  -- inspectable next to the scan attempts that found the drop.
  outcome       text        NOT NULL DEFAULT 'ok'
                            CHECK (outcome IN ('ok', 'fetch_failed', 'error', 'dispatch', 'digest')),
  status_code   integer,
  -- True on a source's first scan: the snapshot was stored, nothing alerted.
  baseline      boolean     NOT NULL DEFAULT false,
  parsed        integer     NOT NULL DEFAULT 0,
  skipped       integer     NOT NULL DEFAULT 0,
  hash_changed  boolean     NOT NULL DEFAULT false,
  added         integer     NOT NULL DEFAULT 0,
  removed       integer     NOT NULL DEFAULT 0,
  unchanged     integer     NOT NULL DEFAULT 0,
  error         text
);

CREATE INDEX scan_logs_source_idx ON scan_logs (source_id, scanned_at DESC);

-- The normalized product list behind each source's `snapshot_hash`. The
-- hash alone can only say "changed"; the worker needs the previous products
-- to diff product-by-product and find what is actually new. `products` is
-- jsonb in Postgres; the row is keyed by source so there is exactly one.
CREATE TABLE scan_snapshots (
  source_id   text        PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  hash        text        NOT NULL,
  products    text        NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- crate and pricing --

CREATE TABLE crate_items (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id  text        NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  -- Discogs grading, stored as given.
  condition   text        NOT NULL DEFAULT 'NM'
                          CHECK (condition IN ('M', 'NM', 'VG+', 'VG', 'G+', 'G', 'F', 'P')),
  paid_cents  integer,
  acquired_at timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, release_id)
);

CREATE INDEX crate_user_idx ON crate_items (user_id, created_at DESC);

CREATE TABLE wantlist_items (
  id                 text        PRIMARY KEY,
  user_id            text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id         text        NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  target_price_cents integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, release_id)
);

-- One observation of the Discogs listing spread for a release. Append-only:
-- the price history is the product, so nothing here is ever updated in place.
CREATE TABLE price_points (
  id            text        PRIMARY KEY,
  release_id    text        NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  low_cents     integer     NOT NULL,
  median_cents  integer     NOT NULL,
  high_cents    integer     NOT NULL,
  listing_count integer     NOT NULL DEFAULT 0,
  CHECK (low_cents <= median_cents AND median_cents <= high_cents)
);

CREATE INDEX price_points_release_idx ON price_points (release_id, observed_at DESC);

-- ---------------------------------------------------------------- activity --

-- The social layer's feed rows. Deliberately generic: a verb plus a pointer,
-- so adding a new kind of activity does not add a table.
CREATE TABLE activity (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verb        text        NOT NULL
                          CHECK (verb IN ('caught', 'added', 'wanted', 'followed', 'played', 'commented')),
  object_type text        NOT NULL
                          CHECK (object_type IN ('release', 'user', 'track', 'alert')),
  object_id   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_user_idx ON activity (user_id, created_at DESC);

-- ------------------------------------------------- alert engine state --

-- The matching engine's memory: the last-seen snapshot for every user+release
-- pair runEngine has ever observed. Without these rows, a scheduler restart
-- re-fires every known release as "new" — the flood that the
-- alert-persistence module prevents by loading this table into prevStates
-- before the first tick and upserting it after every tick.
--
-- The queue's durable seen-set is the `alerts` table itself: restoreQueueSeen
-- replays dispatched alert rows back into the queue, so an already-alerted
-- user+release is never queued again, across restarts. No second table.
CREATE TABLE engine_state (
  user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The release side of prevStateKey("user\us release"): the Discogs
  -- release id, or the normalized "artist::title" fallback when there is
  -- no id (fixture-shaped data).
  state_key  text        NOT NULL,
  -- Exactly the { price_cents, in_stock, seen_at } shape runEngine writes
  -- into prevStates. jsonb so the engine can grow it without a migration.
  state      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, state_key)
);

CREATE INDEX engine_state_updated_idx ON engine_state (updated_at DESC);

COMMIT;
