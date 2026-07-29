/**
 * @file The Sleeve Program, as React Native values.
 *
 * `DESIGN.md` at the repo root is the authority; this file is that document
 * expressed in numbers a `StyleSheet` can use. Where the web tokens
 * (`packages/design/tokens.css`) use `clamp()` and viewport units, these use
 * plain numbers, because React Native has neither.
 *
 * The rules from the design system that this file exists to enforce:
 *
 * - **The Square Corner Rule.** There is no radius token. A printed sleeve has
 *   square corners and so does everything in Wax, without exception.
 * - **The Flat Press Rule.** There is no shadow token either, except the one
 *   the sleeve casts mid-flip. Separation comes from a hard rule or a
 *   different ink field, never from a shadow.
 * - **The One Ink Rule.** A region carries exactly one ink plus black and
 *   stock. Two saturated inks never share a field.
 * - **The Ink-Text Rule.** Light inks take ink-black text; dark inks take
 *   board-stock text. {@link onInk} encodes the whole table, so nobody has to
 *   remember it.
 */

/**
 * The four press inks, the two grounds, and their tints.
 *
 * Vermilion is the only ink permitted to mean "act now". Cyan owns any figure
 * that is changing. Chartreuse means possession — caught, owned, on-plan.
 * Ultramarine recedes between two loud regions.
 */
export const ink = {
  /** The default ground and default body text on any light ink. Warm-shifted. */
  ink: '#14110E',
  /** The paper. Cool-shifted so it reads as uncoated board, never as cream. */
  stock: '#E4E2DA',
  /** The action ink. Buttons, live states, the single most important number. */
  vermilion: '#F03C0B',
  /** The same ink laid heavier — for vermilion text below 24px on a light ground. */
  vermilionDeep: '#A82404',
  /** Live data in motion: timestamps counting, prices being watched. */
  cyan: '#0089A8',
  /** Confirmation and possession. The ink that keeps this palette out of pastiche. */
  chartreuse: '#C8D420',
  /** Depth and quiet. Long-form passages and regions that must recede. */
  ultramarine: '#1B2E8C',

  /** Secondary text on a dark ground. A tint of stock, never a gray. */
  onDark: 'rgba(228, 226, 218, 0.70)',
  /** Secondary text on a light ground. A tint of ink, never a gray. */
  onLight: 'rgba(20, 17, 14, 0.66)',
  /** Hairlines on a dark ground. */
  ruleDark: 'rgba(228, 226, 218, 0.22)',
  /** Hairlines on a light ground. */
  ruleLight: 'rgba(20, 17, 14, 0.20)',
};

/**
 * The foreground for a given ink field, per The Ink-Text Rule.
 *
 * Vermilion, cyan and chartreuse fields take ink-black text (4.84:1, 4.65:1,
 * 11.7:1). Ultramarine and ink-black fields take board stock (8.85:1, 14.6:1).
 * No other pairing ships.
 *
 * @param {keyof typeof ink | string} field
 * @returns {string}
 */
export const onInk = (field) =>
  field === 'ultramarine' || field === 'ink' ? ink.stock : ink.ink;

/**
 * The secondary-text colour for a given ink field.
 *
 * **The No-Headroom Rule.** On vermilion and cyan there is no room to tint:
 * full ink-black is already only 4.84:1 and 4.65:1, so any lift drops
 * secondary text below 4.5:1. Those two fields return the *full* foreground
 * and separate by weight and size instead. Chartreuse, board and ink black do
 * have headroom and get the real tint.
 *
 * @param {keyof typeof ink | string} field
 * @returns {string}
 */
export const dimOn = (field) => {
  if (field === 'vermilion' || field === 'cyan') return ink.ink;
  if (field === 'ultramarine' || field === 'ink') return ink.onDark;
  return ink.onLight;
};

/** The hairline colour that reads on a given field. */
export const ruleOn = (field) =>
  field === 'ultramarine' || field === 'ink' ? ink.ruleDark : ink.ruleLight;

/** 6px base. Everything in the system is a multiple of these. */
export const space = {
  hair: 2,
  xs: 6,
  sm: 12,
  md: 24,
  lg: 36,
  xl: 64,
};

/**
 * Rules are hard hairlines at 1.5px and structural rules at 3px, always in ink
 * or stock, never in a tint of a third colour.
 */
export const rule = { hair: 1.5, structural: 3 };

/**
 * Type roles. Archivo is the gothic — the same family Reid Miles set Blue Note
 * in — and Courier Prime appears *only* on data that is literally measured:
 * catalog numbers, timestamps, prices, durations, quantities.
 *
 * `letterSpacing` is in points here, not ems, because that is what React
 * Native takes. The values are the em figures from `DESIGN.md` multiplied
 * through at each size.
 */
export const type = {
  /** The release name on a sleeve face. The only role permitted past 48px. */
  sleeveTitle: { fontFamily: 'Archivo_900Black', fontSize: 44, lineHeight: 38, letterSpacing: -2 },
  /** Section openings and the value proposition. Always fully legible. */
  display: { fontFamily: 'Archivo_800ExtraBold', fontSize: 32, lineHeight: 31, letterSpacing: -1 },
  /** Subsection headings and pricing tiers. */
  headline: { fontFamily: 'Archivo_700Bold', fontSize: 20, lineHeight: 22, letterSpacing: -0.4 },
  /** Running prose. */
  body: { fontFamily: 'Archivo_400Regular', fontSize: 15, lineHeight: 22, letterSpacing: -0.1 },
  /** Field names, corner marks, button text. Uppercase, always. */
  label: { fontFamily: 'Archivo_700Bold', fontSize: 11, lineHeight: 12, letterSpacing: 1.7 },
  /** Catalog numbers, timestamps, prices, quantities, credit blocks. */
  data: { fontFamily: 'CourierPrime_400Regular', fontSize: 13, lineHeight: 18, letterSpacing: 0.15 },
  /** Data that carries emphasis — the caught count, the live price. */
  dataBold: { fontFamily: 'CourierPrime_700Bold', fontSize: 13, lineHeight: 18, letterSpacing: 0.15 },
};

/**
 * Motion.
 *
 * `flip` is the sleeve turning over — the system's one genuinely physical
 * gesture, and the only thing permitted to cast a shadow while it moves.
 * `state` is a hover or press inversion. `press` is the re-press interval on
 * the landing page's sleeve.
 */
export const motion = {
  state: 140,
  flip: 720,
  press: 1100,
  /** The exponential ease-out every transition in the system uses. */
  ease: [0.16, 1, 0.3, 1],
};

/**
 * The one shadow in the system: a sleeve mid-rotation, which is a physical
 * object moving in space and therefore casts a real, directional shadow. It
 * resolves to nothing when the sleeve lands flat. Never used at rest.
 */
export const flipShadow = {
  shadowColor: '#14110E',
  shadowOffset: { width: 0, height: 24 },
  shadowOpacity: 0.45,
  shadowRadius: 24,
  elevation: 18,
};

/**
 * Map a release or profile's stored `ink` value to a real colour.
 * @param {string} name
 * @returns {string}
 */
export const inkValue = (name) => ink[name === 'ink' ? 'ink' : name] ?? ink.ink;
