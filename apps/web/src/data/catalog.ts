/**
 * DEMONSTRATION DATA — SYNTHETIC.
 *
 * Every artist, title, label and pressing figure below is authored for this
 * surface. None of it is a real release, and the page labels it as sample data
 * wherever a visitor could mistake it for a live feed. Replace this module with
 * the Convex `releases` query once the Discogs watcher is running.
 *
 * The one real reference on the page — BT's *This Binary Universe* — lives in
 * `theMiss` below and carries no invented figures.
 */

export type InkField = 'vermilion' | 'cyan' | 'chartreuse' | 'ultramarine' | 'ink' | 'board';

export interface Release {
  /** Wax's own catalog number. Every object in the system carries one. */
  cat: string;
  artist: string;
  title: string;
  variant: string;
  format: string;
  label: string;
  /** The label's catalog number, as printed on the sleeve spine. */
  labelCat: string;
  pressing: number;
  street: string;
  price: string;
  ink: InkField;
  /** Seconds between the release appearing on Discogs and Wax dispatching. */
  detectedIn: number;
  /** Minutes from dispatch until the pressing sold through. */
  soldOutIn: number | null;
}

export const releases: Release[] = [
  {
    cat: 'WAX 4001',
    artist: 'Nadja Solveig',
    title: 'Ostinato Weather',
    variant: 'Clear with black smoke',
    format: '2×LP / 45RPM / Gatefold',
    label: 'Halberd Editions',
    labelCat: 'HAL-072',
    pressing: 500,
    street: '2026-08-14',
    price: '$41.00',
    ink: 'cyan',
    detectedIn: 38,
    soldOutIn: 26,
  },
  {
    cat: 'WAX 4002',
    artist: 'The Copper Field',
    title: 'Long Player For An Empty Room',
    variant: 'Chartreuse marble, numbered',
    format: 'LP / 180g',
    label: 'Fen & Lantern',
    labelCat: 'FL-018',
    pressing: 300,
    street: '2026-08-09',
    price: '$36.00',
    ink: 'chartreuse',
    detectedIn: 51,
    soldOutIn: 12,
  },
  {
    cat: 'WAX 4003',
    artist: 'Hollow Coast',
    title: 'Transmission Debris',
    variant: 'Ultramarine translucent',
    format: '2×LP / Gatefold',
    label: 'Weather Report Editions',
    labelCat: 'WRE-204',
    pressing: 400,
    street: '2026-08-21',
    price: '$48.00',
    ink: 'ultramarine',
    detectedIn: 29,
    soldOutIn: null,
  },
  {
    cat: 'WAX 4004',
    artist: 'Margit Löwe',
    title: 'Tape Hiss Cathedral',
    variant: 'Clear, hand-stamped labels',
    format: 'LP / 180g',
    label: 'Aphelion Press',
    labelCat: 'APH-006',
    pressing: 250,
    street: '2026-07-31',
    price: '$39.00',
    ink: 'vermilion',
    detectedIn: 44,
    soldOutIn: 9,
  },
  {
    cat: 'WAX 4005',
    artist: 'Sunken Orchard',
    title: 'Fieldwork, Vol. Two',
    variant: 'Olive and black split',
    format: 'LP / 140g',
    label: 'Deadwax Social',
    labelCat: 'DWS-311',
    pressing: 600,
    street: '2026-09-04',
    price: '$34.00',
    ink: 'chartreuse',
    detectedIn: 62,
    soldOutIn: null,
  },
  {
    cat: 'WAX 4006',
    artist: 'Yusef Abara Trio',
    title: 'Nightwork',
    variant: 'Black, tip-on jacket',
    format: 'LP / 180g / Mono',
    label: 'Blue Room Recording Co.',
    labelCat: 'BRR-1149',
    pressing: 1000,
    street: '2026-08-28',
    price: '$32.00',
    ink: 'vermilion',
    detectedIn: 33,
    soldOutIn: 71,
  },
];

/** The pipeline, set as liner-note session credits. */
export const pipeline = [
  {
    n: 'A1',
    title: 'Watch',
    role: 'Discogs API',
    body: 'You name the artists and the variants that matter — coloured, numbered, box set, picture disc, or a merch type you specify. Wax holds that list against the Discogs database and checks it continuously, not on a daily digest.',
    detail: ['Artists tracked', 'Variant keywords', 'Merch types', 'Marketplace listings'],
  },
  {
    n: 'A2',
    title: 'Detect',
    role: 'Release watcher',
    body: 'A new master, a new pressing, a new listing on a release you follow — the watcher sees the record appear and reads its variant, pressing size, label and street date before anyone has posted about it.',
    detail: ['New master release', 'New pressing / variant', 'Repress detected', 'Listing under target'],
  },
  {
    n: 'B1',
    title: 'Dispatch',
    role: 'Push · Email · SMS',
    body: 'The alert goes out on every channel you have switched on, carrying the variant, the pressing count and a direct link. Push arrives first. Email and text follow so it reaches you when your phone is face down.',
    detail: ['Push notification', 'Email', 'SMS / text', 'Direct listing link'],
  },
  {
    n: 'B2',
    title: 'Catalogue',
    role: 'Your crate',
    body: 'What you buy goes into the crate with its variant, pressing and what you paid. What you are still hunting stays on the want list with its price watched, so you learn what a fair number looks like before you pay it.',
    detail: ['Collection', 'Want list', 'Price history', 'Condition & notes'],
  },
];

/** Price watch rows — synthetic, matching the catalog above. */
export const priceWatch = [
  { cat: 'WAX 4004', artist: 'Margit Löwe', title: 'Tape Hiss Cathedral', low: 39, high: 128, now: 74, target: 60, dir: 'down' as const },
  { cat: 'WAX 4002', artist: 'The Copper Field', title: 'Long Player For An Empty Room', low: 36, high: 210, now: 189, target: 90, dir: 'up' as const },
  { cat: 'WAX 4001', artist: 'Nadja Solveig', title: 'Ostinato Weather', low: 41, high: 96, now: 52, target: 55, dir: 'hit' as const },
  { cat: 'WAX 4006', artist: 'Yusef Abara Trio', title: 'Nightwork', low: 32, high: 61, now: 44, target: 40, dir: 'down' as const },
];

/** Spines for the crate. Synthetic. */
export const spines = [
  { artist: 'Nadja Solveig', title: 'Ostinato Weather', ink: 'cyan' as InkField, cat: 'HAL-072' },
  { artist: 'Hollow Coast', title: 'Transmission Debris', ink: 'ultramarine' as InkField, cat: 'WRE-204' },
  { artist: 'The Copper Field', title: 'Long Player For An Empty Room', ink: 'chartreuse' as InkField, cat: 'FL-018' },
  { artist: 'Margit Löwe', title: 'Tape Hiss Cathedral', ink: 'vermilion' as InkField, cat: 'APH-006' },
  { artist: 'Yusef Abara Trio', title: 'Nightwork', ink: 'vermilion' as InkField, cat: 'BRR-1149' },
  { artist: 'Sunken Orchard', title: 'Fieldwork, Vol. Two', ink: 'chartreuse' as InkField, cat: 'DWS-311' },
  { artist: 'Nadja Solveig', title: 'Second Weather', ink: 'ultramarine' as InkField, cat: 'HAL-081' },
  { artist: 'Hollow Coast', title: 'Coastal Static', ink: 'cyan' as InkField, cat: 'WRE-190' },
];

export const plans = [
  {
    cat: 'WAX 0001',
    name: 'The Single',
    price: 'Free',
    per: 'forever',
    ink: 'board' as const,
    line: 'Three artists, watched properly.',
    features: [
      'Track 3 artists or items',
      'Push, email and SMS alerts',
      'Full variant matching',
      'Collection cataloguing',
      'Discogs price history',
    ],
    action: 'Start tracking 3 artists',
  },
  {
    cat: 'WAX 0002',
    name: 'The Subscription Series',
    price: '$10',
    per: 'per month',
    ink: 'vermilion' as const,
    line: 'Every artist you have ever meant to follow.',
    features: [
      'Unlimited artists and items',
      'Unlimited merch-type watches',
      'Price targets with alerts',
      'Early-listing detection',
      'The full social crate',
    ],
    action: 'Start the 30-day trial',
    note: '30 days free. No card until it has caught you something.',
  },
];
