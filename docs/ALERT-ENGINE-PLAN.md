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
- Alert content: artist, title, price, source link, "buy" deep link.
- Per-user rate limit so a restock flood doesn't send 40 texts.

## 4. Build order

1. Data model (artists, sources, releases, alerts).
2. Scannability probe endpoint + UI verdict display.
3. Scan worker + queue + snapshot diffing.
4. Artist matching + cross-source dedupe.
5. Alert delivery (Resend, then Twilio).
6. UI: add artist, add site, scan status dashboard, alert history.

## 5. Free-tier mapping

Free (3 artists/items): email alerts only, scans count against the same
engine. $10/mo unlimited: SMS alerts + unlimited artists/sites. The free
tier's job is to prove the engine works — principle #4 in PRODUCT.md.
