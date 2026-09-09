/**
 * Crate Digger price-check verdict engine (docs/features/crate-digger-price-check.md,
 * build-order step 3: the verdict logic behind the in-store verdict card).
 *
 * The moment: a collector holds a record and wants one verdict in under 10
 * seconds — live market median, the condition-driven spread, and Good deal /
 * Fair / Overpriced against the asking price. No login anywhere in this
 * path (Brandon 2026-09-09: "Just let me use the fucking app").
 *
 * What this module owns, as pure functions over Discogs-shaped marketplace
 * listings (fixtures only — the scheduler/service layer fetches; this file
 * never touches the network):
 *
 * 1. `summarizeMarketplaceStats(listings)` — median + spread, segmented by
 *    media grade (Discogs grades M/NM/VG+/VG/G+/G/F/P). Marketplace stats
 *    are asking prices, not solds — callers must label verdicts as such.
 * 2. `verdictForAskingPrice(...)` — Good deal (>=15% under the
 *    grade-specific median, falling back to the overall median) / Fair
 *    (within ±15%) / Overpriced (>15% over). The bands come from the Crate
 *    Digger spec, not from here.
 * 3. `adjacentGradeVerdicts(...)` — the teaching row: the verdict at the
 *    same asking price if the record is really graded one step better or
 *    worse, because G+ vs VG+ is a 2-3x swing and buyers misgrade.
 * 4. `checkPressingMatch(...)` — the reissue guardrail: a sealed 2023
 *    reissue at $40 is not a deal on a 1993 original at $204, and that is
 *    the #1 way buyers get burned. Says it loudly.
 * 5. `watchRuleFromVerdict(...)` — the "Alert me when a VG+ '93
 *    Doggystyle lists under $120" handoff: a pure converter from a price
 *    check into a `Watch`-shaped standing rule for the alert engine's drop
 *    path (`drop-scheduler.js`). This module only *writes the watch*; the
 *    existing cooldown + dispatch machinery does the rest.
 *
 * Nothing here throws on malformed input: a bad row is skipped, an empty
 * market yields `{ verdict: 'unknown' }` with a reason. A broken fixture
 * row must never break the card in the store aisle.
 */

import { normText } from './rules.js';

/* ------------------------------------------------------------------ *
 * Grade model
 * ------------------------------------------------------------------ */

/** Discogs media grades, worst to best. Only these codes are recognized. */
export const GRADES = ['P', 'F', 'G', 'G+', 'VG', 'VG+', 'NM', 'M'];

const GRADE_SYNONYMS = new Map([
  ['mint', 'M'],
  ['near mint', 'NM'],
  ['near-mint', 'NM'],
  ['m-', 'NM'],
  ['very good plus', 'VG+'],
  ['vg-plus', 'VG+'],
  ['very good', 'VG'],
  ['good plus', 'G+'],
  ['g-plus', 'G+'],
  ['good', 'G'],
  ['fair', 'F'],
  ['poor', 'P'],
]);

/**
 * Normalize a free-text media grade to a GRADES code, or null when it is
 * not a recognizable grade. Never throws.
 * @param {?string} raw
 * @returns {?string}
 */
export function normalizeGrade(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (GRADES.includes(s)) return s;
  const lower = s.toLowerCase();
  return GRADE_SYNONYMS.get(lower) ?? null;
}

/** @param {?string} grade @returns {?string} grade one step better, or null at the top */
export function betterGrade(grade) {
  const g = normalizeGrade(grade);
  if (!g) return null;
  const i = GRADES.indexOf(g);
  return i < GRADES.length - 1 ? GRADES[i + 1] : null;
}

/** @param {?string} grade @returns {?string} grade one step worse, or null at the bottom */
export function worseGrade(grade) {
  const g = normalizeGrade(grade);
  if (!g) return null;
  const i = GRADES.indexOf(g);
  return i > 0 ? GRADES[i - 1] : null;
}

/* ------------------------------------------------------------------ *
 * Summarization
 * ------------------------------------------------------------------ */

/**
 * Median of a number array (copies first — never mutates the caller's
 * array). Returns null for an empty array.
 * @param {number[]} values
 * @returns {?number}
 */
export function medianOf(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Summarize Discogs-shaped marketplace listings into median + spread.
 * A listing is `{ price_cents, media_condition?, ... }`; rows with a
 * missing, non-numeric, or non-positive price are skipped — a broken row
 * must never move the median.
 *
 * @param {Array<{price_cents?: number, media_condition?: ?string}>} listings
 * @returns {{ n: number, lowest_cents: ?number, median_cents: ?number,
 *             highest_cents: ?number, byGrade: Record<string,
 *             { n: number, median_cents: ?number }> }}
 */
export function summarizeMarketplaceStats(listings) {
  const rows = Array.isArray(listings) ? listings : [];
  const prices = [];
  const byGrade = {};
  for (const row of rows) {
    const cents = row?.price_cents;
    if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) continue;
    const c = Math.round(cents);
    prices.push(c);
    const grade = normalizeGrade(row?.media_condition);
    if (grade) {
      byGrade[grade] ??= [];
      byGrade[grade].push(c);
    }
  }
  const per = {};
  for (const [grade, vals] of Object.entries(byGrade)) {
    per[grade] = { n: vals.length, median_cents: medianOf(vals) };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  return {
    n: prices.length,
    lowest_cents: prices.length ? sorted[0] : null,
    median_cents: medianOf(prices),
    highest_cents: prices.length ? sorted[sorted.length - 1] : null,
    byGrade: per,
  };
}

/**
 * The median this verdict prices against: the user's grade when the
 * market has data for it, otherwise the overall median.
 * @param {object} summary from summarizeMarketplaceStats
 * @param {?string} grade
 * @returns {?number}
 */
export function referenceMedian(summary, grade) {
  const g = normalizeGrade(grade);
  const graded = g && summary?.byGrade?.[g];
  if (graded && graded.n > 0 && graded.median_cents != null) return graded.median_cents;
  return summary?.median_cents ?? null;
}

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

/** Verdict band edges from the Crate Digger spec (fractions of median). */
export const VERDICT_GOOD_DEAL_MAX = 0.85; // asking <= 85% of median
export const VERDICT_OVERPRICED_MIN = 1.15; // asking > 115% of median

export const VERDICT_LABELS = {
  good_deal: 'Good deal',
  fair: 'Fair',
  overpriced: 'Overpriced',
  unknown: 'Unknown',
};

/**
 * One verdict: the asking price against the reference median.
 *
 * @param {object} input
 * @param {number} input.asking_cents What the store wants.
 * @param {object} input.summary summarizeMarketplaceStats output.
 * @param {?string} [input.grade] The grade the user picked.
 * @returns {{ verdict: 'good_deal'|'fair'|'overpriced'|'unknown',
 *            label: string, asking_cents: ?number, median_cents: ?number,
 *            grade_used: ?string, pct_vs_median: ?number, note: ?string }}
 */
export function verdictForAskingPrice({ asking_cents, summary, grade = null }) {
  const asking = typeof asking_cents === 'number' && Number.isFinite(asking_cents) && asking_cents > 0
    ? Math.round(asking_cents)
    : null;
  if (asking == null) {
    return { verdict: 'unknown', label: VERDICT_LABELS.unknown, asking_cents: null,
             median_cents: null, grade_used: null, pct_vs_median: null,
             note: 'No asking price to judge.' };
  }
  const median = referenceMedian(summary, grade);
  if (median == null || median <= 0) {
    return { verdict: 'unknown', label: VERDICT_LABELS.unknown, asking_cents: asking,
             median_cents: null, grade_used: normalizeGrade(grade),
             pct_vs_median: null,
             note: 'Not enough market data for this release — no verdict.' };
  }
  const ratio = asking / median;
  const pct = Math.round((ratio - 1) * 1000) / 10; // +12.5 = 12.5% over median
  const verdict = ratio <= VERDICT_GOOD_DEAL_MAX ? 'good_deal'
    : ratio > VERDICT_OVERPRICED_MIN ? 'overpriced' : 'fair';
  const g = normalizeGrade(grade);
  const gradeUsed = g && summary?.byGrade?.[g]?.n > 0 ? g : null;
  const basis = gradeUsed ? `the ${gradeUsed} market median` : 'the overall market median';
  const direction = pct < 0 ? `${Math.abs(pct)}% under` : pct > 0 ? `${pct}% over` : 'right at';
  return {
    verdict,
    label: VERDICT_LABELS[verdict],
    asking_cents: asking,
    median_cents: median,
    grade_used: gradeUsed,
    pct_vs_median: pct,
    note: `Asking price is ${direction} ${basis}. Sellers are asking these prices — this is not sold history.`,
  };
}

/**
 * The teaching row: the same asking price judged one grade better and one
 * grade worse, so "if it's really VG+, not VG" is answered on the card.
 * @param {object} input same shape as verdictForAskingPrice
 * @returns {{ as_graded: object, if_better: ?object, if_worse: ?object }}
 */
export function adjacentGradeVerdicts({ asking_cents, summary, grade = null }) {
  const asGraded = verdictForAskingPrice({ asking_cents, summary, grade });
  const better = betterGrade(grade);
  const worse = worseGrade(grade);
  return {
    as_graded: asGraded,
    if_better: better ? verdictForAskingPrice({ asking_cents, summary, grade: better }) : null,
    if_worse: worse ? verdictForAskingPrice({ asking_cents, summary, grade: worse }) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Reissue guardrail
 * ------------------------------------------------------------------ */

/**
 * The #1 buyer trap: paying original-pressing money for a reissue (or
 * vice versa). Compare what the user thinks they're holding (from the
 * scan context) against the resolved release.
 *
 * @param {object} input
 * @param {object} input.release Resolved release: `{ id?, title?, artist?,
 *   year?, is_reissue?, reissue_year?, catnos?: string[], label? }`.
 * @param {object} [input.expected] What the user believes they hold:
 *   `{ year?, catno?, is_reissue? }`. Missing fields are simply not checked.
 * @returns {{ status: 'ok'|'mismatch'|'unknown', message: string,
 *            direction?: 'original_vs_reissue'|'reissue_vs_original'|'year_gap' }}
 */
export function checkPressingMatch({ release, expected = {} }) {
  if (!release || typeof release !== 'object') {
    return { status: 'unknown', message: 'No release to check the pressing against.' };
  }
  const catnos = Array.isArray(release.catnos)
    ? release.catnos.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
    : [];
  const expectedCatno = expected?.catno != null ? String(expected.catno).trim().toUpperCase() : null;

  // Catalog # is the strongest signal — both sides stated it, they disagree.
  if (expectedCatno && catnos.length > 0 && !catnos.includes(expectedCatno)) {
    return {
      status: 'mismatch',
      direction: 'year_gap',
      message: `Catalog # mismatch: you expected ${expectedCatno}, this release is ${catnos.join(' / ')}. Check the back cover — different pressing, different market.`,
    };
  }

  const releaseIsReissue = release.is_reissue === true;
  const expectedReissue = expected?.is_reissue;
  if (expectedReissue != null && Boolean(expectedReissue) !== releaseIsReissue) {
    const direction = releaseIsReissue ? 'reissue_vs_original' : 'original_vs_reissue';
    const loud = releaseIsReissue
      ? 'STOP: this is a REISSUE, not an original. Reissue medians can sit 5x below the original — price it against reissues, not the original market.'
      : 'STOP: this is an ORIGINAL pressing, not a reissue. Originals can run 5x a reissue — do not let a reissue price anchor this deal.';
    return { status: 'mismatch', direction, message: loud };
  }

  // Year gap with no reissue flag on either side: a 1993 resolve against a
  // 2023 expectation is still almost surely the wrong pressing.
  const ry = Number(release.year);
  const ey = Number(expected?.year);
  if (Number.isFinite(ry) && Number.isFinite(ey) && Math.abs(ry - ey) > 2) {
    return {
      status: 'mismatch',
      direction: 'year_gap',
      message: `Year mismatch: you expected ~${expected.year}, this release is ${release.year}. Likely a different pressing — re-check before you trust the verdict.`,
    };
  }

  return { status: 'ok', message: 'Pressing checks out against what you expected.' };
}

/* ------------------------------------------------------------------ *
 * "Alert me" handoff — Crate Digger -> alert engine
 * ------------------------------------------------------------------ */

/**
 * Turn a price check into a standing watch rule for the alert engine's
 * drop path (`evaluateWatchRule` in rules.js + `createDropScheduler` in
 * drop-scheduler.js). The rule: alert when this artist's pressing of this
 * title lists at or under `target_price_cents`.
 *
 * This only *builds the rule object*; the caller inserts it into the
 * store (`store.watches.insert`) and the existing scheduler cooldown +
 * dispatch machinery owns the rest. Crate Digger is no-login, so the
 * rule is keyed by the store's session user id, not a real account.
 *
 * @param {object} input
 * @param {string} input.user_id Store user id (session row for a Crate Digger scan).
 * @param {object} input.release `{ artist_id?, title, discogs_release_id? }`.
 * @param {number} input.target_price_cents Alert when a listing crosses below this.
 * @param {string[]} [input.channels] default `['email']`.
 * @param {?string} [input.label_contains] e.g. 'Death Row' to pin the pressing.
 * @returns {{ ok: true, rule: object } | { ok: false, reason: string }}
 */
export function watchRuleFromVerdict({ user_id, release, target_price_cents, channels = ['email'], label_contains = null }) {
  if (!user_id || typeof user_id !== 'string') {
    return { ok: false, reason: 'user_id is required to attach the watch to a session.' };
  }
  if (!release || typeof release !== 'object' || !release.artist_id) {
    return { ok: false, reason: 'release.artist_id is required — a price alert keyed on title alone is noise.' };
  }
  const target = typeof target_price_cents === 'number' && Number.isFinite(target_price_cents) && target_price_cents > 0
    ? Math.round(target_price_cents)
    : null;
  if (target == null) {
    return { ok: false, reason: 'target_price_cents must be a positive number of cents.' };
  }
  const title = release.title != null ? normText(release.title) : '';
  const chans = (Array.isArray(channels) && channels.length ? channels : ['email'])
    .filter((c) => c === 'email' || c === 'sms');
  return {
    ok: true,
    rule: {
      user_id,
      artist_id: release.artist_id,
      watch_vinyl: true,
      merch_types: [],
      target_price_cents: target,
      title_contains: title || null,
      label_contains: typeof label_contains === 'string' && label_contains.trim() ? label_contains.trim() : null,
      discogs_release_id: release.discogs_release_id ?? null,
      channels: chans.length ? chans : ['email'],
    },
  };
}
