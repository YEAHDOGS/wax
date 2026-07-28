# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Web, iOS, and Android from one multi-release architecture, comparable to how Discord ships across platforms.

## Users

Primary user: a vinyl collector with a large, growing collection of vinyl, music, merch, and memorabilia, who wants a place to track, manage, and grow it. They've been burned by missing a limited release that sold out before they knew it existed (named example: BT's *This Binary Universe* vinyl) and don't want that to happen again. They also want to spend less by tracking listing prices for items they want.

Secondary/unconfirmed: collectors of other collectibles (e.g. Pokémon cards) — explicitly undecided, not yet scoped.

## Product Purpose

Wax is a vinyl collector's app that sends real-time email and text notifications the moment a followed artist releases a new album on vinyl, or releases a specific type of merchandise the user has asked to track — solving the problem that vinyl drops sell out very quickly. It also provides digital collection cataloging, Discogs-based price tracking on listings, and a social layer for connecting with other collectors around shared collections and music taste.

## Positioning

The combination of a real-time drop-alert pipeline (so collectors never miss a sellout) with social discovery and collection tools built on Discogs data — not just a catalog app, and not just a forum.

## Operating Context

- Built on the Discogs API for release metadata and listing/price data.
- An existing prototype (`wax1`, one directory up from this project, cloned as WaxOnWax) already integrates Discogs successfully for cataloging. Its alert pipeline (originally envisioned as Reddit scraping + Twilio/Resend notifications) does not currently work.
- Multi-platform delivery (web, iOS, Android) is a goal, not yet built.

## Capabilities and Constraints

- Paid product: free tier tracks up to 3 artists/items; $10/month unlocks unlimited tracking; 30-day free trial.
- Core alert mechanism: email and SMS/text notifications, triggered by new vinyl releases or specified merch types, per tracked artist.
- Price tracking against Discogs listings, to help users buy for less.
- Social features: users can connect based on collection/taste overlap, and comment on releases.
- Open question, not yet decided: whether/how to expand beyond vinyl into other collectibles (e.g. Pokémon cards).

## Brand Commitments

Wax is a product of DOGS, the parent tech company (see `projects/wearedogs` for DOGS's own logo, name, mission, and styling starter — reference only, not binding on Wax). Wax itself currently has **no logo and no established visual identity** — a blank canvas. The `wax1` prototype exists as a working functional reference ("the beginning of the dream") but its visual styling is explicitly considered too old-fashioned; new visual work must be completely new and cutting-edge, not an extension of that look.

## Evidence on Hand

- Prototype app: `C:\Users\Brando\Projects\wax1` — Svelte 5 + Vite, TailwindCSS + SCSS, SurrealDB backend, Discogs API integration (working). Reddit-scraping/Twilio/Resend alert pipeline exists in code but is not functional.
- DOGS parent brand: `C:\Users\Brando\Projects\wearedogs` — has logo, name, mission, and a general styling starter. Not yet reviewed in depth; treat as reference for the parent brand, not as Wax's identity.
- No existing testimonials, case studies, press, or pricing page beyond the $10/month + 3-free/30-day-trial terms stated above.

## Product Principles

1. Never let a user miss a drop — the real-time alert is the core promise the whole product is judged on.
2. Build on data collectors already trust — Discogs metadata and pricing, not invented catalogs.
3. Community forms around shared taste and collections, not generic social features bolted on.
4. Let the free tier prove the alert engine works before asking for $10/month.
5. Design and architect for vinyl first, but don't foreclose adjacent collectibles later.

## Accessibility & Inclusion

Not yet established.
