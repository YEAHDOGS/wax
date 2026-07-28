---
name: Wax
description: A record label whose catalog is drop alerts — every release Wax catches gets a sleeve cut for it.
colors:
  ink: "#14110E"
  stock: "#E4E2DA"
  vermilion: "#F03C0B"
  vermilion-deep: "#A82404"
  cyan: "#0089A8"
  chartreuse: "#C8D420"
  ultramarine: "#1B2E8C"
  ink-70: "#5A544D"
  stock-60: "#9A968C"
typography:
  sleeve-title:
    fontFamily: "Archivo, Archivo Expanded, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(3rem, 13vw, 9.5rem)"
    fontWeight: 900
    lineHeight: 0.82
    letterSpacing: "-0.045em"
    fontVariation: "'wdth' 118"
  display:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2rem, 5.5vw, 4rem)"
    fontWeight: 800
    lineHeight: 0.94
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 105"
  headline:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.375rem, 2.6vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.06
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1rem, 1.15vw, 1.125rem)"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  label:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.16em"
  data:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.01em"
rounded:
  none: "0px"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "12px"
  md: "24px"
  lg: "48px"
  xl: "96px"
  band: "clamp(64px, 9vw, 152px)"
components:
  button-primary:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "20px 36px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.vermilion}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "18px 34px"
    typography: "{typography.label}"
  button-ghost-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
  input-field:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "18px 0"
    typography: "{typography.headline}"
  sleeve:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    rounded: "{rounded.none}"
    width: "min(92vw, 640px)"
    height: "min(92vw, 640px)"
  catalog-mark:
    backgroundColor: "transparent"
    textColor: "{colors.stock-60}"
    typography: "{typography.data}"
---

# Design System: Wax

## Overview

**Creative North Star: "The Sleeve Program"**

Wax is built as a record label, not as an app with a record theme. The system descends from Reid Miles' Blue Note program (1956–67), whose real invention was not jazz nostalgia but a doctrine: a record sleeve is an information poster. The facts carry the composition at architectural scale on the front; the back cover sets dense session data — personnel, dates, engineers, catalog numbers — as carefully as the front sets the title. Wax is an information product about records, so it inherits that doctrine literally. Every drop Wax catches is a release in its own catalog, cut its own sleeve, and stamped with its own number in the WAX 4000 series.

The system is drenched, not accented. Saturated printing inks own whole regions of a surface — a full vermilion field, a full ultramarine field — rather than appearing as small accents over a neutral ground. Photography is duotone: one ink plus black, never full color. Type is the primary image; when a composition needs a picture, heavy gothic capitals set at sleeve scale are the picture. Corners are square everywhere, without exception, because a printed sleeve has square corners.

The confirmed anti-reference is the `wax1` prototype: dark glassmorphism, purple-to-pink gradient text, neon halo shadows, and Outfit. Every one of those devices is rejected by name below. The second, subtler failure mode is soft mid-century pastiche — muted mustard and teal, faux-vintage distressing, jazz-bar nostalgia. Wax's inks run acid and contemporary; the data density is present-tense.

**Key Characteristics:**
- Saturated ink fields at page scale, one ink per region
- Type as architecture; the headline is the image
- Square corners and hard rules, universally
- Duotone photography only, never full color
- Typewritten data blocks carrying real information density
- A catalog number on every object in the system

## Colors

Four printing inks over a dense black and an uncoated board stock — the ink range of a mid-century sleeve program pushed acid rather than muted.

### Primary
- **Vermilion** (`#F03C0B`): The action ink. Primary buttons, the live alert state, the detection pulse, and the single most important number on any surface. It is the only ink permitted to mean "act now."
- **Deep Vermilion** (`#A82404`): The same ink laid heavier. Vermilion at small sizes on board stock only reaches 3.02:1; this reaches 5.51:1. Use it for any vermilion text below 24px on a light ground, and nowhere else.

### Secondary
- **Process Cyan** (`#0089A8`): Live data in motion — timestamps counting up, listing prices being watched, feed activity. Wherever a figure is changing, cyan owns the region.
- **Acid Chartreuse** (`#C8D420`): Confirmation and possession. A drop successfully caught, a record in your crate, a plan you are on. The least-used Blue Note ink and the one that keeps this palette out of pastiche.

### Tertiary
- **Ultramarine** (`#1B2E8C`): Depth and quiet. Long-form passages, the liner-notes back cover, and any region that needs to recede between two loud ones.

### Neutral
- **Ink Black** (`#14110E`): The default ground and the default body text on any light ink. Warm-shifted, because offset black on board is never neutral.
- **Board Stock** (`#E4E2DA`): The paper. Body text on dark grounds, and the ground for back-cover data blocks. Cool-shifted so it reads as uncoated board, never as cream.
- **Ink 70** (`#5A544D`) and **Stock 60** (`#9A968C`): Secondary text only, and only as a tint of the surface's own ink family.

### Named Rules

**The One Ink Rule.** A region carries exactly one ink plus black and stock. Two saturated inks never share a field; they meet at a hard edge between fields.

**The Ink-Text Rule.** Vermilion, cyan, and chartreuse fields take Ink Black text (4.84:1, 4.65:1, 11.7:1). Ultramarine and Ink Black fields take Board Stock text (8.85:1 and 14.6:1). No other pairing ships; there is no combination in this system that requires gray text to work.

**The No-Headroom Rule.** On vermilion and cyan there is no room to tint: full Ink Black is already only 4.84:1 and 4.65:1, and any lift drops secondary text below 4.5:1. On those two fields secondary text stays full ink and separates by weight and size instead. Chartreuse (5.05:1 tinted), board (5.29:1) and ink black (7.56:1) do have headroom and use the `--f-dim` tint.

**The Duotone Rule.** Photographs are printed in black plus exactly one ink. A full-color photograph has not been art-directed yet.

## Typography

**Display Font:** Archivo (variable, `wght` 100–900 and `wdth` 62–125), with Helvetica Neue and Arial as fallbacks
**Body Font:** Archivo
**Label/Data Font:** Courier Prime, with Courier New as fallback

**Character:** Archivo is an American gothic in the News Gothic and Franklin Gothic line — the exact family Reid Miles set Blue Note in — but drawn with a real width axis, so a sleeve title can be pushed expanded to fill a square while a credit column stays narrow and dense. Courier Prime is not a costume for "technical"; Blue Note liner notes were genuinely typewritten, and it appears here only on data that is literally measured: catalog numbers, timestamps, prices, pressing quantities, and session-format credit blocks.

### Hierarchy
- **Sleeve Title** (900, `clamp(3rem, 13vw, 9.5rem)`, 0.82 line-height, `wdth` 118): The release name on a sleeve face. This is the only role permitted to exceed 6rem, and only inside a square sleeve module that clips it.
- **Display** (800, `clamp(2rem, 5.5vw, 4rem)`, 0.94): Section openings and the value proposition. Always fully legible, never clipped.
- **Headline** (700, `clamp(1.375rem, 2.6vw, 2rem)`, 1.06): Subsection headings and pricing tiers.
- **Body** (400, `clamp(1rem, 1.15vw, 1.125rem)`, 1.5): Running prose, held to a 62–70ch measure.
- **Label** (700, `0.6875rem`, `0.16em` tracking, uppercase): Field names, corner marks, and button text. Named, systemic marks — not a decorative eyebrow on every section.
- **Data** (Courier Prime 400, `0.8125rem`): Catalog numbers, timestamps, prices, quantities, credit blocks.

### Named Rules

**The Legible Hook Rule.** Reid Miles clipped titles because the buyer already held the record. A visitor does not. The value proposition, the primary action, and every navigational word are set fully within their box. Only a release title — information the composition repeats elsewhere in Data type — may run off an edge.

**The Measured Mono Rule.** Courier Prime appears only where the content is a measurement, an identifier, or a date. Prose never sets in mono.

## Layout

The module is the 12-inch square. A sleeve is `min(92vw, 640px)` on a side and never distorts; the page is a run of square modules and the full-bleed ink bands between them.

Sections are catalog entries, not feature blocks: each is introduced by its number in the WAX 4000 series set in Data type, because the run itself is the label's real information system. Bands alternate ink at full bleed, and the rhythm is deliberately uneven — a dense typewritten data band earns a near-empty ink field after it.

**One panel is one impression.** Each band is exactly `100dvh` and the page scroll-snaps to it (`y mandatory` with `scroll-snap-stop: always`), so a catalog run is read one plate at a time and a fast flick cannot skip an entry. The navigation band is `position: fixed`, not sticky — in the flow it would steal its own height from every panel and no panel could be exactly one screen.

Spacing runs on a 6px base (`2 / 6 / 12 / 24`), and every measure above that answers to **viewport height rather than width**: band padding is `clamp(24px, 4.2dvh, 64px)`, separation is `clamp(24px, 5dvh, 48px)`, and the sleeve is `min(88vw, 54dvh, 560px)`. Display type is bounded on both axes (`clamp(1.75rem, min(5.5vw, 7.6dvh), 4rem)`) so a wide, short screen never gets a headline that eats its own panel. Headings carry more space above than below, at a 2:1 ratio.

Breakpoints are `640px`, `900px`, and `1200px`, plus a height floor at `680px`. Below 900px wide or 680px tall the content cannot honestly fit one screen, so the lock and the snap are both released together and panels take the height they need — clipping real text to preserve a round number is the wrong trade. Below 900px the sleeve becomes the full column width, back-cover data blocks collapse from four typewritten columns to one, and the catalog run reads as a single stack. The square never becomes a rectangle at any width.

### Named Rules

**The One Impression Rule.** A panel is exactly one screen and never scrolls inside itself. If content will not fit, the content gets smaller or moves to another panel — the panel does not grow and the text is never clipped.

## Elevation & Depth

This system is flat by doctrine. Ink printed on board has no drop shadow, and no surface in Wax carries an ambient one. Depth comes from three sources instead: hard edges where two ink fields meet, real overprint (one ink laid over another at multiply blend, exactly as a second pass on press), and genuine 3D rotation when a sleeve is turned over.

The single exception is the sleeve flip, which is a physical object moving in space and therefore casts a real, directional, moving shadow while it turns — offset and softly blurred, resolving to nothing when the sleeve lands flat.

### Shadow Vocabulary
- **Flip shadow** (`box-shadow: 0 24px 48px -12px rgba(20,17,14,0.45)`): Only on a sleeve mid-rotation. Never at rest.

### Named Rules

**The Flat Press Rule.** No shadow at rest, anywhere. If an element needs separation, it gets a hard rule or a different ink field, not a shadow. A zero-offset colored halo is forbidden outright — it is the prototype's signature and this system's anti-reference.

## Shapes

Zero radius everywhere, including buttons, inputs, sleeves, chips, avatars, and images. Rules are hard hairlines at 1.5px (`--rule`) and structural rules at 3px, always in ink or stock, never in a tint.

The recurring silhouette is the square sleeve and the rectangle divided by rules into labeled fields — a solicitation form's geometry. Corner marks (catalog number, `STEREO`, timestamp) sit in the true corners of a module with a consistent 24px inset.

### Named Rules

**The Square Corner Rule.** Radius is `0` on every element in this system, with no exception. A printed sleeve has square corners, and so does everything in Wax.

## Components

### Buttons
- **Shape:** Square (`0` radius), no border on primary, 3px ink rule on ghost.
- **Primary:** Vermilion ground with Ink Black label type, `20px 36px` padding, `0.16em` tracking, uppercase.
- **Hover / Focus:** Inverts to Ink Black ground with Vermilion text in 140ms. Focus-visible adds a 3px offset stock rule; the inversion alone never carries focus.
- **Ghost:** Transparent with a 3px ink rule, inverting to solid ink with stock text on hover.

### Cards / Containers
- **Corner Style:** Square (`0`).
- **Background:** One ink field, or board stock for data blocks.
- **Shadow Strategy:** None — see The Flat Press Rule.
- **Border:** 1.5px hairline in the field's own foreground ink, or none where two fields meet at an edge.
- **Internal Padding:** `24px`, rising to `48px` at container widths above 900px.

### Inputs / Fields
- **Style:** No box. A single 3px ink rule underneath, with the field name set above in Label type — a form to be filled in by hand.
- **Focus:** The underrule switches to vermilion and thickens to 4px; the field name goes vermilion with it.
- **Error:** The rule and label go vermilion, and the message sets in Data type directly beneath, naming both the problem and the fix.

### Navigation
- **Style:** A single hairline-ruled band with the WAX lockup at left and Label-type links at right. No background blur, no shrink-on-scroll, no pill.
- **States:** Links carry a 3px vermilion underrule on hover and on the active section.
- **Mobile:** The band keeps the lockup and the single primary action; secondary links collapse into the footer catalog index rather than into a hamburger drawer.

### Sleeve (signature component)
The system's defining object. A square module with a full-bleed ink field or duotone photograph, the release title in Sleeve Title type, and four corner marks in Data type: catalog number top-left, `STEREO` top-right, detection timestamp bottom-left, format bottom-right.

Its behavior is the flip. Turning a sleeve rotates it in real 3D about the Y axis over 720ms on an exponential ease-out, revealing a back cover: board stock ground, a typewritten credit block in three columns, and the same catalog number. Front is the hook, back is the data. This is the whole system's navigation metaphor, and the app inherits it — a release is a sleeve, an alert is a catalog number, the collection is a crate of spines, settings is a back cover.

### Catalog Mark
Every object in Wax carries a number in the WAX 4000 series, set in Data type at `0.8125rem` in a 60% tint of the field's foreground. It is an identifier, not decoration; it is quotable, searchable, and appears again in the footer's catalog index.

## Do's and Don'ts

### Do:
- **Do** let one ink own an entire full-bleed region. Color commits at page scale in this system.
- **Do** set every catalog number, timestamp, price, and pressing quantity in Courier Prime.
- **Do** keep every corner square (`0` radius), on every element without exception.
- **Do** print photographs as duotone — black plus exactly one ink.
- **Do** give a data-dense band a quiet ink field after it; the run's rhythm is deliberately uneven.
- **Do** pair light inks with Ink Black text and dark inks with Board Stock text, per The Ink-Text Rule.
- **Do** hold running prose to a 62–70ch measure.

### Don't:
- **Don't** use gradient text. Emphasis comes from weight, width, and scale.
- **Don't** use glassmorphism, backdrop blur as decoration, or neon halo shadows. These are the `wax1` prototype's signature and this system's named anti-reference.
- **Don't** ship a rounded corner, a soft drop shadow at rest, or a colored `border-left` accent.
- **Don't** render a photograph in full color.
- **Don't** set body prose in Courier Prime, or use it to signal "technical."
- **Don't** soften the palette toward muted mustard, dusty teal, or faux-vintage distressing. The inks run acid; nostalgia is the failure mode.
- **Don't** let the sleeve module become a rectangle at any breakpoint.
- **Don't** clip any text a first-time visitor must read — only a release title may run off an edge.
