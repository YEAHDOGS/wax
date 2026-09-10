# Crate Digger mode — in-store price check

Status: spec (2026-09-09). Origin: Brandon standing in a record store asking
"how much does that cost?" — the answer should be a Wax feature.

## The moment

Collector holds a record. They want one verdict in under 10 seconds:
**live market median, the condition-driven spread, and Good deal / Fair /
Overpriced against the asking price.**

## Non-negotiable: no login

Open the app, scan, get the verdict. No account, no signup wall, no
"create an account to continue" — ever. Crate Digger works for the person
holding the record, not for a user database. (Brandon, 2026-09-09:
"I love apps with no login. Just let me use the fucking app.")

## Example (real data, 2026-09-09)

Snoop Dogg — Doggystyle, original US 1993 pressing (cat# 92279-1).
See `docs/market-notes/2026-09-09-doggystyle-93-pressing.md`.

- Market median: ~$204. Spread: $29–$618.
- Beat-up G+: ~$89. Typical VG: $130–$150.
- 2023 reissue sealed: ~$40 — **not** the same release.
- Store asking $150 for a VG copy → **Fair** (median band).
- Store asking $150 for a VG+ original → **Good deal**.
- Store asking $150 for the reissue → **Overpriced**.

## V1 — barcode / catalog# lookup

1. Input: UPC/EAN barcode scan or typed catalog # (e.g. `92279-1`).
2. Resolve to Discogs release ID (Discogs database search; barcode is a
   first-class search field).
3. Pull marketplace stats for that release ID (lowest/median/highest,
   condition-segmented when available).
4. Render the verdict card:
   - Median + spread, by condition tier.
   - Reissue guardrail: if the resolved release is a reissue while the user
     expected an original (or vice versa), say so loudly — the 5x median
     gap between original and reissue is the #1 way buyers get burned.
   - Verdict vs entered asking price: Good deal (≥15% under median for the
     graded condition) / Fair (within ±15%) / Overpriced (>15% over).

## The condition-grading problem

G+ vs VG+ is a 2–3x price swing on the same release. V1 takes the user's
honest grade as input and shows the verdict for THAT grade (plus the
"if it's really VG+, not VG" adjacent row — teaches grading while
pricing). Never auto-grade from a photo in V1.

## V2 — cover-art photo lookup

Photo → artwork fingerprint → release candidate list (original vs
reissues disambiguated by label/catalog # on the back cover). Hard;
explicitly not V1.

## Feed into the alert engine

The price check is the top of a funnel into Wax's existing machinery:

- One tap on the verdict card: "Alert me when a VG+ '93 Doggystyle lists
  under $120" → creates a wantlist entry + a max-price watch rule.
- That rule already exists: `runEngine`/`wantMatchesRelease` in
  `packages/core/src/alert-engine.js` fires `price_drop` events on
  Discogs-shaped batches with price-threshold gating; the drop scheduler
  (`drop-scheduler.js`) adds the cooldown + dispatch. Crate Digger only
  needs to *write the watch*, not build new alert plumbing.
- Missed-deal loop: every price check logs the release + asking price;
  if a watched release later lists under the user's threshold, the
  existing `price_drop` path fires.

## Data source

Discogs marketplace (same source as the alert engine's fixtures).
Marketplace stats are asking prices, not solds — label the verdict
accordingly ("sellers are asking…"). Sold-history is the v2 upgrade for
both this card and the alert engine.

## Build order

1. Release resolution from barcode/catalog# (Discogs search).
   - **BUILT (2026-09-09, jack/wax-checkout-v1):** the scan pipeline —
     `packages/core/src/crate-scan.js` (`normalizeCode`,
     `createReleaseResolver`, `createMarketplaceStatsCache`,
     `runCrateScan`), exported from `@wax/core`. UPC-A/EAN-8/EAN-13 vs
     catalog# classification (digits-only barcodes, dashes kept on cat#s);
     the resolution seam takes an injected `search` (the live Discogs
     call lives in the service layer — core opens zero sockets) and
     resolves loud statuses: `found`, `ambiguous` (multiple pressings
     matched → the buyer picks, the engine never guesses), `not_found`.
     `createFixtureResolver()` resolves the Doggystyle fixture so tests
     stay hermetic. Pinned by `packages/core/test-crate-scan.mjs`
     (14 tests). The live Discogs `/database/search` adapter for the
     service layer is still pending — Brando's call on wiring keys there.
2. Marketplace stats pull per release ID, cached per scan session.
   - **BUILT (2026-09-09, jack/wax-checkout-v1):** `createMarketplaceStatsCache`
     — exactly one pull per release per scan session (grade/price
     what-ifs re-render from cache, no re-pull), and every result carries
     `is_asking_prices: true` because Discogs stats are what sellers are
     *asking*, never solds — the card must label them that way.
3. Verdict card UI (mobile-first — this is used standing in a store).
   - **BUILT (2026-09-09, jack/wax-price-verdict):** the verdict engine —
     `packages/core/src/price-verdict.js` (`summarizeMarketplaceStats`,
     `verdictForAskingPrice`, `adjacentGradeVerdicts`,
     `checkPressingMatch`, `watchRuleFromVerdict`), exported from
     `@wax/core`. Grade-segmented medians, ±15% Good deal / Fair /
     Overpriced bands, the "if it's really VG+, not VG" teaching row, and
     the reissue guardrail — all pure, all fixture-driven (no network).
     Pinned by `packages/core/test-price-verdict.mjs` (11 tests) on a
     `fixtures/doggystyle-marketplace.json` snapshot drawn from the
     2026-09-09 Doggystyle market note. Barcode/catalog# resolution is now built
     (`crate-scan.js` — build-order steps 1–2); the verdict card UI is still pending.
4. "Alert me" handoff → existing watch-rule creation.
   - **BUILT (2026-09-09, jack/wax-price-verdict):** `watchRuleFromVerdict`
     in `price-verdict.js` converts a price check into a `Watch`-shaped
     standing rule (artist + title_contains + target_price_cents) for the
     drop path's `evaluateWatchRule` + cooldown + dispatch. The engine
     *writes the watch*; existing machinery owns the rest. Caller inserts
     into `store.watches` — no-login path keys on the session user id.
5. (V2) sold-history medians; (V3) cover-art lookup.
