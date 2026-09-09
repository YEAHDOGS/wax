# Crate Digger mode — in-store price check

Status: spec (2026-09-09). Origin: Brandon standing in a record store asking
"how much does that cost?" — the answer should be a Wax feature.

## The moment

Collector holds a record. They want one verdict in under 10 seconds:
**live market median, the condition-driven spread, and Good deal / Fair /
Overpriced against the asking price.**

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
2. Marketplace stats pull per release ID, cached per scan session.
3. Verdict card UI (mobile-first — this is used standing in a store).
4. "Alert me" handoff → existing watch-rule creation.
5. (V2) sold-history medians; (V3) cover-art lookup.
