# Wax Alert Engine Plan

The alert engine is the core of Wax — the thing the whole product is judged on
(see PRODUCT.md principle 1: *never let a user miss a drop*). This document
describes what it is, how it decides to alert, and how it is kept honest and
quiet when it should be.

**Status: MVP spec.** The pure evaluation core lives in `packages/engine/` —
fully deterministic, fixture-tested, zero network. The Discogs polling loop and
email/SMS delivery adapters are specified here but not yet built.

## Alert types

Alert kinds match the `alerts` table `CHECK` constraint in
`packages/core/src/schema.sql` — the engine never invents new kinds, so every
alert it emits fits the board today:

| Kind      | Trigger                                                        | User-facing name   |
|-----------|----------------------------------------------------------------|--------------------|
| `drop`    | A new vinyl pressing of a watched artist/release appears      | "New pressing"     |
| `price`   | A listing for a watched release crossed the user's target price | "Price drop"      |
| `restock` | A listing that died came back                                  | "Back in stock"    |
| `merch`   | An item of a watched merch type appeared                       | "Merch drop"       |

A **wantlist match** is a *rule scope*, not a new kind: a `drop` alert with
`source: 'wantlist'` means the release was on the user's wantlist when the
pressing appeared. The board renders it as "On your wantlist".

## Rule model

A rule is a standing instruction (persisted as a row in `watches`):

```js
{
  id: 'wtc_...',
  user_id: 'usr_...',
  artist_id: 'art_...',        // or release_id for per-release rules
  watch_vinyl: true,           // drop alerts on new pressings
  merch_types: ['tee'],        // [] = vinyl only
  target_price_cents: 4000,    // null = no price alerts
  cooldown_hours: 24,          // per-rule minimum between same-kind refires
  channels: ['email', 'push'],
}
```

Rule types the evaluator supports:

1. `price-drop` — any listing for the release crosses **at or below**
   `target_price_cents`, compared against the previous poll snapshot.
2. `new-listing` — a listing id appears in the snapshot that was not there
   before (for a watched release). Surfaces as kind `drop` on new pressings,
   or folds into the existing alert if the pressing is already known.
3. `back-in-stock` — a listing previously observed as sold/dead is available
   again → kind `restock`.
4. `wantlist-match` — the release entered the user's wantlist scope and a new
   pressing appeared since the last scan → kind `drop` with
   `source: 'wantlist'`.

## Evaluation flow

```
poll(source) -> snapshots -> evaluate(rules, prev, next, now) -> alerts
     ^                                                          |
     |                      delivery adapters (email/sms/push)   |
     +-------------------- alert board (persist) ---------------+
```

1. **Poll.** The Discogs adapter fetches, per watched artist/release, the
   listing spread (listing id, price, currency, condition, availability,
   seller, url) and the release catalog for new pressings. Never more than the
   budget allows (see cadence).
2. **Snapshot.** Each poll produces an immutable `Snapshot`:
   `{ listings: Map<listingId, Listing>, pressings: Map<pressingId, Pressing>,
     taken_at }`. Snapshots are stored so every evaluation is a pure diff.
3. **Evaluate.** `evaluate()` is pure: same rules + same prev/next snapshots +
   same `now` ⇒ same alerts. It runs each rule's matchers, then passes
   candidates through the anti-noise gate.
4. **Persist.** Surviving alerts are written to `alerts` as `state: 'watching'`
   (known pressing, not yet dispatched) or `state: 'live'` with
   `detected_at = now`.
5. **Deliver.** Delivery adapters read live alerts and send them over the
   user's verified channels, then stamp `dispatched_at`. The gap
   `dispatched_at − detected_at` is the product's headline metric — keep it
   under five minutes for drop alerts.

## Polling cadence

Discogs enforces ~60 requests/minute unauthenticated. Cadence is per rule
temperature, not per user, so the budget scales with watched artists, not
accounts:

| Tier | What it watches                    | Cadence  | Reason                                   |
|------|------------------------------------|----------|------------------------------------------|
| Hot  | `watch_vinyl` rules on active artists | 5 min  | Drops sell out in minutes                |
| Warm | price-drop rules with a live board | 15 min   | Prices move slower than pressings appear |
| Cool | merch rules                        | 60 min   | Merch restocks are daily events          |
| Cold | rules with no recent activity      | 6 hours  | Back-off; re-warms on any signal         |

A rule re-warms one tier whenever it fires or the user opens the alert board
for its artist. Free tier (3 watches) always polls at its natural tier;
unlimited is a paid-tier convenience, never a correctness knob.

## Delivery channels (adapters)

Delivery is an interface, not a vendor:

```js
interface ChannelAdapter {
  name: 'email' | 'sms' | 'push';
  send(alert) -> Promise<{ ok: true, messageId } | { ok: false, error }>;
}
```

- `push` — the app itself; always available.
- `email` — requires `email_verified`; Resend is the planned provider.
- `sms` — requires `sms_verified`; Twilio is the planned provider.

The MVP ships a `RecordingAdapter` (test double) and a stub that logs. Real
provider adapters land when the polling loop does. **No network calls in the
evaluation core, ever** — tests and matchers run on fixtures only.

## Anti-noise / rate limits

An alert engine that spams is an engine users mute. Every candidate alert
passes this gate before dispatch:

1. **Dedup key.** `(watch_id, kind, listing_id, price_bucket)` — the same
   thing at the same price never fires twice.
2. **Cooldown.** A rule may not refire the same kind for the same release
   within `cooldown_hours` (default 24). Price drops are exempt from cooldown
   *only* when the price fell at least 10% further — a genuinely better deal
   is new information.
3. **Flap suppression.** A listing that oscillates available/sold three times
   within an hour is quarantined for 6 hours (restock alerts only). Flaky
   sellers should not page anyone.
4. **Per-user dispatch budget.** Max 25 dispatches per user per day, drops
   always win ties: priority order is `drop` > `price` > `restock` > `merch`.
   Over-budget alerts stay on the board as `watching` — visible, not sent.
5. **Tier caps.** Free tier: 3 watches, push only until an email is verified.
   `$10/mo`: unlimited watches, all channels.

## Data model

Existing tables (unchanged): `watches`, `alerts` — see
`packages/core/src/schema.sql` and the `Watch` / `Alert` typedefs in
`packages/core/src/types.js`.

New tables (future migration, specified now so the core doesn't paint us in):

```sql
-- One stored snapshot per (artist or release) per poll, kept 30 days.
CREATE TABLE listing_snapshots (
  id          text PRIMARY KEY,
  scope_type  text NOT NULL CHECK (scope_type IN ('artist','release')),
  scope_id    text NOT NULL,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  listings    jsonb NOT NULL,   -- { listing_id: { price_cents, currency,
                               --   condition, available, url, seller } }
  pressings   jsonb NOT NULL    -- { pressing_id: { title, format, released_at } }
);

-- Per-rule memory the evaluator needs between polls.
CREATE TABLE rule_state (
  watch_id        text PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  last_fired_at   jsonb NOT NULL DEFAULT '{}',  -- kind -> timestamptz
  tier            text NOT NULL DEFAULT 'warm'
                  CHECK (tier IN ('hot','warm','cool','cold')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

## MVP scope (this branch)

- [x] Pure, deterministic matcher + evaluator modules in `packages/engine/`
- [x] Fixture-based regression suite (`npm test` in `packages/engine`),
      runnable with zero new dependencies via Node's built-in test runner
- [x] `ChannelAdapter` interface + `RecordingAdapter` test double
- [ ] Discogs polling adapter (live adapter shape defined, stubbed with fixtures)
- [ ] Snapshot persistence + `rule_state` migration
- [ ] Email/SMS provider adapters (Resend/Twilio)
- [ ] Polling scheduler with tier cadence

## Open questions

- Should price-drop alerts consider *median* listing price, not just the
  cheapest listing? (Median resists one sketchy undercut; cheapest is what the
  buyer pays.)
- Wantlist scope is per-release today. Should a user's whole wantlist act as
  one implicit rule, or stay per-release opt-in?
- SMS cost per alert vs. the $10/mo price — at what volume does an SMS-heavy
  user go unprofitable?

---
*This product was made by DOGS — https://wearedogs.net*
