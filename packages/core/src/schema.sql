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

COMMIT;
