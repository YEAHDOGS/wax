/**
 * Wax design tokens — single source of truth.
 *
 * Consumed as plain values by the Expo app (React Native has no CSS) and
 * mirrored into custom properties by ./tokens.css for the web surface.
 * Any change here must be reflected there; DESIGN.md is the prose contract.
 */

/** The four printing inks, over a dense offset black and an uncoated board stock. */
export const ink = {
  ink: '#14110E',
  stock: '#E4E2DA',
  vermilion: '#F03C0B',
  cyan: '#0089A8',
  chartreuse: '#C8D420',
  ultramarine: '#1B2E8C',
  /** Secondary text only, and only as a tint of its own surface's family. */
  ink70: '#5A544D',
  stock60: '#9A968C',
} as const;

export type InkName = keyof typeof ink;

/**
 * The Ink-Text Rule, encoded. Light inks take Ink Black, dark inks take Board
 * Stock. Every pair below clears 4.5:1; nothing in this system needs gray text.
 */
export const fieldPairs: Record<string, { ground: string; text: string; secondary: string; contrast: number }> = {
  vermilion: { ground: ink.vermilion, text: ink.ink, secondary: 'rgba(20,17,14,0.72)', contrast: 4.84 },
  cyan: { ground: ink.cyan, text: ink.ink, secondary: 'rgba(20,17,14,0.74)', contrast: 4.65 },
  chartreuse: { ground: ink.chartreuse, text: ink.ink, secondary: 'rgba(20,17,14,0.68)', contrast: 11.7 },
  ultramarine: { ground: ink.ultramarine, text: ink.stock, secondary: 'rgba(228,226,218,0.74)', contrast: 8.85 },
  black: { ground: ink.ink, text: ink.stock, secondary: 'rgba(228,226,218,0.70)', contrast: 14.6 },
  board: { ground: ink.stock, text: ink.ink, secondary: 'rgba(20,17,14,0.66)', contrast: 14.6 },
};

export const type = {
  display: "'Archivo', 'Helvetica Neue', Arial, sans-serif",
  data: "'Courier Prime', 'Courier New', monospace",
  weight: { regular: 400, medium: 500, bold: 700, heavy: 800, black: 900 },
  /** Archivo's width axis: narrow for credit columns, expanded for sleeve titles. */
  width: { condensed: 84, normal: 100, wide: 105, expanded: 118 },
} as const;

/** 6px base. Tight groups, generous separation. */
export const space = {
  hair: 2,
  xs: 6,
  sm: 12,
  md: 24,
  lg: 48,
  xl: 96,
} as const;

export const rule = { hair: 1.5, structural: 3 } as const;

/** The Square Corner Rule. There is no other radius in this system. */
export const radius = 0;

export const motion = {
  /** Exponential ease-out — everything decelerates into place. */
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** A sleeve turning over in the hand. */
  flip: 720,
  state: 140,
  press: 1100,
} as const;

export const breakpoints = { sm: 640, md: 900, lg: 1200 } as const;
