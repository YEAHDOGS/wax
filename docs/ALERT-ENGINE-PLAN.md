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
- Alert content: artist, title, price, source link, "buy" deep link.
- Per-user rate limit so a restock flood doesn't send 40 texts.

## 4. Build order

1. Data model (artists, sources, releases, alerts). — done
2. Scannability probe endpoint + UI verdict display. — done (`probe.js`)
3. Scan worker + queue + snapshot diffing. — done (`fetcher.js`, `poller.js`, `scanner.js`)
4. Artist matching + cross-source dedupe. — done (`scanner.js`, `rules.js`)
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
   - **NEXT:** wire List-Unsubscribe / List-Unsubscribe-Post headers into the
     Resend adapter once live sends begin (needs Brando's `RESEND_API_KEY`);
     add the per-address subscribe throttle counters alongside the
     Postgres migration of `alert_subscriptions`.

## 5. Free-tier mapping

Free (3 artists/items): email alerts only, scans count against the same
engine. $10/mo unlimited: SMS alerts + unlimited artists/sites. The free
tier's job is to prove the engine works — principle #4 in PRODUCT.md.
