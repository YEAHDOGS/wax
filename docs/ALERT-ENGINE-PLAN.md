# Wax Alert Engine — Build Plan

Brandon's directive (2026-09-09): users add favorite artists AND favorite merch
websites. The backend probes each site for scannability, then a cron scans
everything ~every minute for new releases. This doc is the build plan.

## Data model

- `artists` — user-followed: name, discogs_artist_id, aliases[]
- `sources` — user-submitted merch sites: url, user_id, platform guess,
  scan_method, scannable (bool), scannable_reason, snapshot_hash,
  last_scan_at, consecutive_failures
- `releases` — detected items: title, artist, url, image, price,
  detected_at, source_id
- `alerts` — user_id, release_id, channel (email/sms), sent_at

## 1. Source onboarding + scannability probe

User pastes a merch site URL. The probe runs synchronously (answers in
seconds) and returns a verdict the user sees immediately:

Probe order (cheapest reliable signal first):

1. **Feed discovery** — `<link rel="alternate" type="application/rss+xml">`
   / Atom. If a shop has a "new arrivals" feed, scanning is trivial.
2. **Platform APIs** — Shopify (`/products.json`), Bandcamp (public
   `discography` endpoints), Bigcartel. Structured JSON, no scraping.
3. **JSON-LD structured data** — `Product` / `ItemList` blocks in HTML.
4. **Sitemap** — `sitemap.xml` product URLs, diffed on each scan.
5. **HTML heuristic** — product-grid detection (price + title + image
   patterns). Lowest confidence, flagged as fragile.

Verdict: `SCANNABLE (method, confidence)` or `NOT SCANNABLE (reason)` —
reasons: JS-rendered SPA with no SSR, bot wall (Cloudflare/IAM), login
required, no product structure found. Never silently accept an unscannable
site; the user must know.

## 2. Scan loop (cron)

Target cadence is every minute per Brandon. Implementation is a scan queue
with **adaptive per-site intervals**:

- Start at 60s for cheap structured sources (Shopify JSON, feeds).
- Back off exponentially on HTTP 429 / 5xx / consecutive failures.
- Respect `robots.txt` and `crawl-delay`; identify with a real user-agent
  (`WaxBot/1.0; +https://wax.wearedogs.net/bot`).
- Getting IP-banned helps nobody — the backoff is what keeps the
  every-minute promise sustainable.

Each scan: fetch → normalize product list → hash → diff against
`snapshot_hash` → new items become candidate releases → match against
followed artists (name/alias match, Discogs ID when present) → dedupe
across sources (same release on 3 sites = 1 alert) → queue alerts.

Keep a per-source scan log (attempts, failures, new-item counts) — the
same transparency pattern as DOGS Remote's attempt log.

## 3. Alert delivery

- Resend (email) + Twilio (SMS) — same providers the wax1 prototype aimed at.
  - **BUILT (2026-09-09, jack/wax-provider-adapters):** `createResendChannel`
    and `createTwilioChannel` in `packages/core/src/dispatch.js` are fully
    wired — Resend `POST /emails` with Bearer key, Twilio Messages API with
    Basic auth + form encoding. Both take a loopback `baseUrl` for tests;
    constructor throws without live keys (no fake sends, ever); provider
    4xx/transport failures return `{ ok: false }` receipts, never throw;
    invalid email addresses and non-E.164 phone numbers are refused before
    any socket opens. Pinned by `packages/core/test-dispatch-providers.mjs`
    (9 tests, loopback stubs only).
  - **LIVE SENDS PENDING:** Brando still needs to supply `RESEND_API_KEY`
    and `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` — nothing in the codebase
    carries real credentials, by design.
  - **BUILT (2026-09-09, jack/wax-alert2):** the dispatch stage —
    `packages/core/src/alert-dispatcher.js` (`createAlertDispatcher`) drains
    the queue (priority order) and delivers through pluggable adapters
    registered by channel name via `registerAdapter` — the future Resend
    email adapter plugs in with one call, no dispatcher changes. The
    DEFAULT adapter is the dry-run printer (`createDryRunAdapter`, new in
    `send-adapters.js`): it prints exactly what would be sent and returns
    `{ ok: true, dryRun: true }` receipts — dev/staging send nothing, ever.
    Exactly-once: the queue's seen-set dedupes, the dispatcher re-marks it
    after delivery, and every success writes a durable `alerts` row
    (`recordAlert`) — the per-user delivery log (user_id, release_id,
    dispatched_at, adapter name in `channels`) — which `restoreQueueSeen`
    replays after a restart, so nothing re-delivers across reboots.
    Failures never lose alerts: `{ ok: false }` receipts, thrown errors,
    and garbage receipts all retry in-process up to `maxAttempts`, then
    dead-letter (inspectable via `deadLetter()`, revivable via
    `redispatchDead()`); a missing channel is a loud NO ADAPTER refusal,
    never a silent drop. CLI: `node packages/core/bin/wax alert dispatch
    --dry-run` runs tick → dispatch → prints the delivery log; `--live`
    resolves the NOT-WIRED stubs and dead-letters loudly. Pinned by
    `packages/core/test-alert-dispatcher.mjs` (19 tests).
- Alert content: artist, title, price, source link, "buy" deep link.
- Per-user rate limit so a restock flood doesn't send 40 texts.

## 4. Build order

1. Data model (artists, sources, releases, alerts). — done
2. Scannability probe endpoint + UI verdict display. — done (`probe.js`)
3. Scan worker + queue + snapshot diffing. — done (`fetcher.js`, `poller.js`, `scanner.js`)
4. Artist matching + cross-source dedupe. — done (`scanner.js`, `rules.js`)
   - **BUILT (2026-09-09, jack/wax-alert-engine):** wantlist alert-matching
     engine core — `packages/core/src/alert-engine.js` (`runEngine`,
     `classifyEvent`, `wantMatchesRelease`, `artistMatches`,
     `fuzzyContains`) matches a user wantlist against Discogs-shaped
     release batches and emits typed alert events (`new` / `restock` /
     `price_drop`): fuzzy artist/title matching (normalized containment +
     token coverage), conjunctive format/pressing filters, price-threshold
     gating, and prior-state comparison so the same release never fires
     twice. `packages/core/src/alert-queue.js` is the staging layer in
     front of dispatch: user+release dedupe across batches, per-user
     rolling-hour rate cap (refusals reported, folded into the digest —
     never silently dropped), priority drain order
     (price_drop → restock → new), oldest-first within a kind. Zero
     dependencies, pure functions, injectable clocks. The provider seam is
     `packages/core/src/send-adapters.js`: `createDisabledResendAdapter` /
     `createDisabledTwilioAdapter` are clearly marked NOT WIRED (every send
     returns a `{ ok: false }` receipt naming the missing keys — no socket
     is ever opened), `createConsoleAdapter` records sends in-memory for
     tests, and `resolveSendAdapters(config)` returns the fully-wired
     `dispatch.js` channels only when `enabled: true` AND live keys are
     present — keyless or `enabled`-without-keys config still resolves to
     stubs. No half-wired. Engine works against Discogs-shaped fixtures
     under `packages/core/fixtures/` — no live API calls. Pinned by
     `packages/core/test-alert-engine.mjs` (7 tests), `test-alert-queue.mjs`
     (10), `test-send-adapters.mjs` (10).
   - **NEXT:** persist `prevStates` + the queue's seen-set in Postgres with
     the `alerts` table.
   - **BUILT (2026-09-09, jack/wax-alert2):** engine-state persistence —
     `packages/core/src/alert-persistence.js` (`createAlertPersistence`):
     `savePrevStates`/`loadPrevStates` upsert `runEngine`'s prior-state map
     into the store's new `engineStates` collection (DDL in
     `schema.sql` as `engine_state`, typedef in `types.js` — one key per
     user+release, garbage keys never persisted), `restoreQueueSeen(queue)`
     replays dispatched `alerts` rows into the queue's seen-set (via the
     new `queue.markSeen`), and `recordAlert` writes durable `alerts` rows
     with the engine→board kind mapping (new→drop, price_drop→price,
     restock→restock). The scheduler takes an optional `persistence`:
     loads durable states before the first tick, upserts after every tick,
     and throws on save failure (loud beats a re-alert flood). Restart
     recipe: `restoreQueueSeen(queue)` → scheduler with `persistence` →
     an unchanged batch stays quiet, a price drop still fires exactly
     once. Works against the store interface, so the in-memory store gets
     it today and Postgres gets it free when `store.js` is swapped. Pinned
     by `packages/core/test-alert-persistence.mjs` (12 tests).
   - **NEXT:** the actual Postgres `store.js` swap (live DB + `pg` driver)
     — needs Brando's call on hosting; everything above is written to make
     that swap a one-file change.
   - **BUILT (2026-09-09, jack/wax-postgres-store):** that one file —
     `packages/core/src/store-postgres.js` (`createPostgresStore`,
     `sqlCollection`, `POSTGRES_TABLES`), exported from `@wax/core`'s
     index. All 20 collections run over SQL against the `schema.sql`
     tables (composite keys for `follows`/`engine_state`, token-keyed
     `sessions`, jsonb columns JSON-encoded, `text[]` passed through,
     `timestamptz` normalized to ISO strings so rows stay JSON-safe like
     the in-memory store), plus the async `createSession`/`userForToken`/
     `endSession`/`latestPrice` helpers mirroring `store.js`. The `pg`
     driver is *injected* (`{ client }` with `query(text, params)`), never
     imported — zero deps, nothing to install, and the fake-client test
     suite asserts every generated statement, so no live DB is needed to
     review it. All user data travels in `$n` parameters; identifiers come
     only from the fixed table map or validated row keys. The store is
     fully async: call sites `await` the same calls (handlers/routes are
     already async). Remaining before production: Brando's `pg` install +
     `DATABASE_URL` wiring at boot, and the mechanical `await` pass at the
     call sites that switch stores. Pinned by
     `packages/core/test-store-postgres.mjs` (16 tests: guards, table map,
     full Collection contract, injection resistance, JSON-safety, store
     helpers).
   - **BUILT (2026-09-09, jack/wax-postgres-pipeline):** the await-pass for
     the worker pipeline — every store call in the per-minute cron path is
     now awaited: `poller.js` (`watchedArtists`, `sentThisWindow`,
     `recordScanLog`, `failSource`, `succeedSource`, `buildAlerts`,
     `runScanPass`), `alert-persistence.js` (`loadPrevStates`,
     `savePrevStates`, `restoreQueueSeen`, `recordAlert`),
     `digest.js` (`queueHeldAlerts`, `flushDigestQueue`), `dispatch.js`
     (`dispatchScanAlerts`), `rules.js` (`alreadyAlerted`, `routeAlert`,
     `routeAlerts`), `closeout.js` (`filterAlreadyAlerted`), and the
     dispatcher's `persistence.recordAlert`. `createAlertScheduler` no
     longer loads durable state in its constructor — the async
     `loadPrevStates` runs lazily on the first tick. `resolveStore()`
     (new `packages/core/src/store-resolve.js`, exported from `@wax/core`)
     wires boot: `DATABASE_URL` set → `createPostgresStore` over a lazily
     loaded `pg` client (connected before the store is returned; a missing
     driver is a loud install-hint error, never a silent demo fallback);
     unset → the in-memory store, unchanged. `bin/wax` (`alert dispatch`,
     `billing sweep`, `status`) resolves its store at boot via
     `resolveStore()`, inert here since `DATABASE_URL` is unset. Pinned by
     `packages/core/test-async-store-pipeline.mjs` (5 tests: an
     `asAsyncStore` shim proving the full worker tick, the restart recipe,
     and dispatch behave identically against a promise-returning store —
     it caught a real missed `await` in `runScanPass` on the first run)
     and `packages/core/test-store-resolve.mjs` (4 tests: memory default,
     Postgres boot with an injected fake driver, loud driver failures).
     Full core suite: 328/328 green.
   - **BUILT (2026-09-09, jack/wax-api-await):** the await-pass for the
     HTTP/API layer — every handler in `handlers.js` (auth, catalog,
     alerts, crate, watches, profiles, playback, bootstrap),
     `subscriptions.js`, `tracking.js`, `billing.js`, the HTML renderers
     (`renderAlertHistory`, `renderAlertDetail`, `renderDashboard`), the
     serverless routes (`api/*`, incl. `api/stream.js`), `bin/wax`
     (`status`, trial sweep), and the app's local client (`apps/app/src/
     data/client.js` — `local()` now awaits the handler promise so
     `ApiError`s still normalize to `ClientError`, and the
     `alerts()`/`crate()`/`watches()`/`tracks()` aggregators await each
     property instead of returning Promises inside the object).
     Pinned by `packages/core/test-async-api-surface.mjs` (5 tests: an
     `asAsyncStore` shim proving the full API scenario — auth, catalog,
     watches, alerts, history renderers, subscriptions, tracking,
     billing, dashboard, bootstrap, sign-out — behaves identically
     against a promise-returning store, free-tier gate pins, and a
     no-Promise-leak walk of the scenario output; the first runs caught
     a real 4-arg `catchAlert` call-order slip in the test itself, and
     the surface sweep caught two real missed awaits in `api/tracks.js`
     and the app client aggregators). Full core suite: 333/333 green
     (29 files, run individually).
   - **NEXT:** the `pg` install (Brando's call — default-deny means the
     machine never installs it unprompted), then the Postgres boot smoke
     test: `resolveStore()` with a real `DATABASE_URL` against a scratch
     database, running `test-async-store-pipeline` and
     `test-async-api-surface` semantics on top. The engine cron path and
     the API path are both done; the remaining surface is the actual
     driver and hosting.
   - **BUILT (2026-09-09, jack/wax-alert-engine):** tick scheduler —
     `packages/core/src/alert-scheduler.js` (`createAlertScheduler`)
     hooks `runEngine` into the wantlist batch path: each tick pulls a
     Discogs-shaped batch from the injected `getReleases()` provider
     (fixtures in dev, Discogs probe later — the scheduler itself never
     touches the network), runs the engine against `getWantlist()` and
     the scheduler-owned `prevStates`, and enqueues events into the
     alert queue where dedupe + the per-user rate cap still hold.
     State survives between ticks, so an unchanged batch goes quiet
     and an alert fires once. `start(intervalMs)`/`stop()` run the
     sweep on an interval without overlapping in-flight ticks. Sending
     stays behind the send-adapter seam — disabled stubs still return
     `{ ok: false }` NOT-WIRED receipts. Exported from
     `packages/core/src/index.js`. Pinned by
     `packages/core/test-alert-scheduler.mjs` (10 tests: tick-to-queue
     wiring, steady-state quiet, price-drop re-fire, rate-cap flood,
     disabled adapters never send, console adapter in-memory sends,
     start/stop, constructor guards, onTick report).
5. Alert delivery (Resend, then Twilio). — done (adapters wired, key-gated; live keys pending from Brando)
6. UI: add artist, add site, scan status dashboard, alert history. — done (`dashboard.js`, `alert-history.js`)
   - **BUILT (2026-09-09, jack/wax-alert-history):** `renderAlertHistory(store, userId, { state })` in
     `packages/core/src/alert-history.js` renders the full alert history as a standalone static HTML page —
     zero JS, zero CSS framework. Joined rows (release + artist + channels + detection price), `?state=` filter
     row with per-state counts (`live/caught/sold_out/watching/missed`) mirroring the board's filter row,
     unread markers (from `read_at`), listing links for http(s) URLs only (hostile URLs like `javascript:`
     render as inert text — alerts are the wrong place to learn what an href can do), every user string
     HTML-escaped, deleted releases fall back to the raw id, and rows are scoped to the requesting user.
     Pinned by `packages/core/test-alert-history.mjs` (8 tests).
   - **BUILT (2026-09-09, jack/wax-routes):** route wiring done — `GET /api/alerts/history?state=`
     in `api/alerts/history.js` serves the page as standalone static HTML, following the `/api/alerts`
     session conventions (Bearer <redacted> → 401). Core has an `alertHistory(token, { state })` handler;
     `api/_lib/http.js` has an `html()` responder next to `json()`. Pinned by
     `packages/core/test-alert-routes.mjs`.
   - **BUILT (2026-09-09, jack/wax-routes):** alert detail view — `GET /api/alerts/history?id=alr_...`
     renders one alert as a standalone static HTML page (`renderAlertDetail` in
     `packages/core/src/alert-detail.js`, same zero-deps static-page contract as the history page).
     History rows link to their detail page with relative `?id=` links; the `alertDetail(token, id)`
     handler 404s unknown ids and other users' ids identically (no id oracle). Pinned by the same
     `test-alert-routes.mjs` (15 tests).
   - **NEXT:** unsubscribe flow for email alerts (one-click List-Unsubscribe) — the missing piece
     before real sends, and it needs Brando's `RESEND_API_KEY` anyway.
   - **BUILT (2026-09-09, jack/wax-routes):** alert-subscription HTTP routes —
     `POST /api/alerts/subscribe` (email/phone + release filter, strict
     validation, idempotent re-subscribe returns the existing row),
     `GET /api/alerts/confirm?token=` (double-opt-in activation), and
     `POST /api/alerts/unsubscribe` (token, or email/phone + filter). Domain
     logic in `packages/core/src/subscriptions.js`: filter allowlist
     (`artist_id`, `title_contains`, `max_price_cents`, `source_id` — unknown
     fields rejected, never ignored), address validation (email format,
     E.164 for SMS), confirmation dispatched through the existing
     Resend/Twilio adapters when live keys are present and never attempted
     without them — keyless or failing sends become a `{ ok: false }`
     receipt on the row, never a throw. Rate-limit guard documented in the
     module (per-address subscribe throttling + the notify caps, counters
     move to Postgres with the table). The confirm token doubles as the
     one-click unsubscribe token, so the plan's List-Unsubscribe flow is
     the same endpoint. Subscriptions are keyed by address, not session —
     no account needed to subscribe. Pinned by
     `packages/core/test-subscription-routes.mjs` (26 tests: happy path,
     idempotency, validation, never-throw delivery, adapter mapping).
   - **BUILT (2026-09-09, jack/wax-list-unsubscribe):** List-Unsubscribe /
     List-Unsubscribe-Post wiring — `createResendChannel` takes an optional
     `unsubscribeUrl` (a static http(s) URL, or a `(envelope) => ?string`
     resolver for per-recipient links); when set, every email payload
     carries `headers: { 'List-Unsubscribe': '<url>',
     'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }` per
     RFC 2369 / RFC 8058. A set-but-malformed URL refuses the send as
     `{ ok: false }` before any socket opens — Gmail/Outlook require a
     working unsubscribe on bulk mail, so a bad value is a loud refusal,
     never a silent send. `buildUnsubscribeUrl(baseUrl, token)` (exported
     from `@wax/core`) builds the tokenized URL, http(s)-only. The
     dispatcher threads `event.unsubscribe_token` into the send envelope,
     so the resolver form can call `buildUnsubscribeUrl(endpoint,
     envelope.unsubscribe_token)` per recipient. And `POST
     /api/alerts/unsubscribe` now accepts `?token=` from the query string
     (body still wins) — that's the actual one-click path, since email
     clients POST the List-Unsubscribe URL with an empty body.
   - **NEXT (unchanged):** the actual live sends still wait on Brando's
     `RESEND_API_KEY`.
   - **BUILT (2026-09-09, jack/wax-list-unsubscribe):** per-address
     subscribe throttle counters — `MAX_SUBSCRIBE_ATTEMPTS_PER_WINDOW`
     (5) new subscribes per rolling hour per channel+address, unknown
     confirm-token probes capped per token (`MAX_CONFIRM_ATTEMPTS_PER_WINDOW`,
     10/hour), both refused as 429 `rate_limited` — idempotent duplicates
     never burn budget, valid confirms never count, and refused subscribes
     create no row. Counters live in the store's `subscribeAttempts`
     collection (`subscribe_attempt` table in `schema.sql`), so the
     Postgres swap inherits the guards with the subscriptions table.
     Pinned by `packages/core/test-subscription-throttle.mjs` (8 tests).

## 5. Free-tier mapping

Free (3 artists/items): email alerts only, scans count against the same
engine. $10/mo unlimited: SMS alerts + unlimited artists/sites. The free
tier's job is to prove the engine works — principle #4 in PRODUCT.md.
  - **BUILT (2026-09-09, jack/wax-list-unsubscribe):** free-tier enforcement + the trial-expiry entry point — `FREE_WATCH_LIMIT` 402s a 4th watch on `free` in `handlers.js` (the paywall `/api/checkout`'s copy names), `shouldDispatch` in `notify.js` refuses `sms` for `plan === 'free'`, and the previously-schedule-only `expireTrials` sweeper from `billing.js` is now runnable: `node packages/core/bin/wax billing sweep [--json]` — the cron's entry point (hourly, idempotent; runs against whatever store `createStore()` resolves to, so the Postgres swap inherits it). Pinned by `packages/core/test-billing-sweep.mjs` (4 tests: text summary, `--json` shape, idempotency, dashboard/dispatch paths untouched).
  - **BUILT (2026-09-09, jack/wax-trial-enforcement):** trial-expiry enforcement on the *read* path — `effectivePlan(user, { now })` in new leaf module `packages/core/src/plan.js` (no imports, so no `handlers`↔`billing` cycle; re-exported from `billing.js` for a stable import path). A `trial` past `trial_ends_at` returns `'free'` — exactly what the sweep will write — so a trial that ends at 2:00 cannot keep series features (SMS sends, unlimited watches/sources) until the 3:00 sweep lands. Wired into the dispatch path: `poller.js` `buildAlerts` hands `effectivePlan` to `shouldDispatch` (expired trial → SMS refused, folds to digest), plus the free-tier gates (`handlers.js` `addWatch` `FREE_WATCH_LIMIT`, `tracking.js` `addSource` `FREE_SOURCE_LIMIT`) and the profile response (`publicUser.plan`) so the client agrees with the gates even before the sweep writes. Pure, clock-injectable, never touches the store. Pinned by `packages/core/test-trial-expiry-enforcement.mjs` (10 tests: unit, read-vs-sweep agreement, SMS/email verdicts, both 402 gates, live trial uncapped).
