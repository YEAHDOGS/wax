/**
 * Smoke/regression check for `packages/core/src/price-verdict.js` — the
 * Crate Digger price-check verdict engine (docs/features/crate-digger-price-check.md,
 * build-order step 3).
 *
 * Run: `node --test packages/core/test-price-verdict.mjs`
 * Zero dependencies beyond the Node standard library. Works entirely off
 * `packages/core/fixtures/doggystyle-marketplace.json` (a snapshot fixture
 * drawn from docs/market-notes/2026-09-09-doggystyle-93-pressing.md —
 * NOT live data, no socket is ever opened).
 *
 * Pins the properties the verdict card depends on:
 *
 * 1. Median + spread summarize the fixture faithfully, garbage rows (null
 *    and zero prices) are skipped, and nothing ever throws on malformed
 *    input.
 * 2. Verdict bands from the spec: >=15% under the reference median is a
 *    Good deal, >15% over is Overpriced, everything between is Fair —
 *    including exact-boundary cases.
 * 3. The reference median is grade-specific when the market has data for
 *    the user's grade (a $150 VG+ original is a Good deal, not Fair),
 *    falling back to the overall median for unknown grades.
 * 4. The teaching row: adjacentGradeVerdicts answers "if it's really
 *    VG+, not VG" on the card.
 * 5. The reissue guardrail (checkPressingMatch) shouts on pressing
 *    mismatches — cat#, reissue flag, and year gap — the #1 buyer trap.
 * 6. watchRuleFromVerdict produces a valid Watch-shaped standing rule the
 *    alert engine's drop path can consume, and refuses loud when the
 *    inputs can't make one.
 *
 * If any of them fail, the in-store verdict contract changed, and that is
 * the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  GRADES,
  VERDICT_GOOD_DEAL_MAX,
  VERDICT_OVERPRICED_MIN,
  VERDICT_LABELS,
  normalizeGrade,
  betterGrade,
  worseGrade,
  medianOf,
  summarizeMarketplaceStats,
  referenceMedian,
  verdictForAskingPrice,
  adjacentGradeVerdicts,
  checkPressingMatch,
  watchRuleFromVerdict,
} from './src/price-verdict.js';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(root, 'fixtures', 'doggystyle-marketplace.json'), 'utf8')
);
const summary = () => summarizeMarketplaceStats(fixture.listings);

test('grade model: recognizes Discogs grades and synonyms, walks the ladder', () => {
  assert.equal(normalizeGrade('vg+'), 'VG+');
  assert.equal(normalizeGrade('Near Mint'), 'NM');
  assert.equal(normalizeGrade('M-'), 'NM');
  assert.equal(normalizeGrade('Garbage'), null);
  assert.equal(normalizeGrade(null), null);
  assert.equal(betterGrade('VG'), 'VG+');
  assert.equal(betterGrade('M'), null);
  assert.equal(worseGrade('G'), 'F');
  assert.equal(worseGrade('P'), null);
  assert.deepEqual(GRADES.length, 8);
});

test('medianOf: odd/even medians, ignores garbage, never mutates', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 3); // rounds the average of 2 and 3
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([null, 'x', NaN]), null);
  const input = [5, 1, 9];
  medianOf(input);
  assert.deepEqual(input, [5, 1, 9]);
});

test('summarize: fixture median/spread, garbage rows skipped', () => {
  const s = summary();
  assert.equal(s.n, 9); // 11 rows minus the null-price and zero-price rows
  assert.equal(s.lowest_cents, 2900);
  assert.equal(s.highest_cents, 61800);
  assert.equal(s.median_cents, 15000);
  assert.equal(s.byGrade.VG.median_cents, 14000);
  assert.equal(s.byGrade['VG+'].median_cents, 24200);
  assert.equal(s.byGrade.NM.median_cents, 53400);
  assert.equal(s.byGrade['G+'].median_cents, 8900);
});

test('summarize: malformed input yields an empty-but-safe summary, never a throw', () => {
  assert.equal(summarizeMarketplaceStats(null).n, 0);
  assert.equal(summarizeMarketplaceStats('nope').n, 0);
  assert.equal(summarizeMarketplaceStats([{ price_cents: -5 }]).n, 0);
  assert.equal(summarizeMarketplaceStats([{ media_condition: 'VG' }]).n, 0);
  const s = summarizeMarketplaceStats([{ price_cents: 10000, media_condition: '???' }]);
  assert.equal(s.n, 1);
  assert.deepEqual(s.byGrade, {});
});

test('verdict bands: exact boundary cases from the spec', () => {
  const s = { n: 1, median_cents: 10000, lowest_cents: 10000, highest_cents: 10000, byGrade: {} };
  const v = (c) => verdictForAskingPrice({ asking_cents: c, summary: s }).verdict;
  assert.equal(v(Math.round(10000 * VERDICT_GOOD_DEAL_MAX)), 'good_deal'); // exactly 15% under
  assert.equal(v(Math.round(10000 * VERDICT_GOOD_DEAL_MAX) + 1), 'fair');
  assert.equal(v(Math.round(10000 * VERDICT_OVERPRICED_MIN)), 'fair'); // exactly 15% over
  assert.equal(v(Math.round(10000 * VERDICT_OVERPRICED_MIN) + 1), 'overpriced');
  assert.equal(VERDICT_LABELS.good_deal, 'Good deal');
});

test('verdict: the spec examples — $150 for a VG original is Fair, VG+ is a Good deal', () => {
  const s = summary();
  const vg = verdictForAskingPrice({ asking_cents: 15000, summary: s, grade: 'VG' });
  assert.equal(vg.verdict, 'fair');
  assert.equal(vg.grade_used, 'VG');
  assert.equal(vg.median_cents, 14000);
  const vgp = verdictForAskingPrice({ asking_cents: 15000, summary: s, grade: 'VG+' });
  assert.equal(vgp.verdict, 'good_deal');
  assert.equal(vgp.grade_used, 'VG+');
  assert.equal(vgp.median_cents, 24200);
  assert.match(vgp.note, /sellers are asking/i);
});

test('verdict: grade fallback and unknown market', () => {
  const s = summary();
  // 'F' is absent from the fixture — no grade data, so it falls back
  // to the overall median instead of guessing.
  const f = verdictForAskingPrice({ asking_cents: 15000, summary: s, grade: 'F' });
  assert.equal(f.grade_used, null);
  assert.equal(f.median_cents, 15000);
  const empty = verdictForAskingPrice({ asking_cents: 15000, summary: summarizeMarketplaceStats([]) });
  assert.equal(empty.verdict, 'unknown');
  assert.match(empty.note, /not enough market data/i);
  const noAsking = verdictForAskingPrice({ asking_cents: null, summary: s, grade: 'VG' });
  assert.equal(noAsking.verdict, 'unknown');
});

test('adjacentGradeVerdicts: the teaching row for a $150 VG copy', () => {
  const s = summary();
  const rows = adjacentGradeVerdicts({ asking_cents: 15000, summary: s, grade: 'VG' });
  assert.equal(rows.as_graded.verdict, 'fair');
  assert.equal(rows.if_better.verdict, 'good_deal'); // VG+: 150/242 = good deal
  assert.equal(rows.if_better.grade_used, 'VG+');
  assert.equal(rows.if_worse.verdict, 'overpriced'); // G+: 150/89 = overpriced
  assert.equal(rows.if_worse.grade_used, 'G+');
  // Ladder ends are honest about having no neighbor.
  assert.equal(adjacentGradeVerdicts({ asking_cents: 15000, summary: s, grade: 'M' }).if_better, null);
  assert.equal(adjacentGradeVerdicts({ asking_cents: 15000, summary: s, grade: 'P' }).if_worse, null);
});

test('checkPressingMatch: reissue vs original is a loud mismatch', () => {
  const original = { id: 829287, title: 'Doggystyle', year: 1993, is_reissue: false, catnos: ['92279-1'] };
  const reissue = { id: 30648607, title: 'Doggystyle', year: 2023, is_reissue: true, catnos: ['ABC-2023'] };

  const gotReissue = checkPressingMatch({ release: reissue, expected: { year: 1993, is_reissue: false } });
  assert.equal(gotReissue.status, 'mismatch');
  assert.equal(gotReissue.direction, 'reissue_vs_original');
  assert.match(gotReissue.message, /REISSUE/);

  const gotOriginal = checkPressingMatch({ release: original, expected: { year: 2023, is_reissue: true } });
  assert.equal(gotOriginal.status, 'mismatch');
  assert.equal(gotOriginal.direction, 'original_vs_reissue');
  assert.match(gotOriginal.message, /ORIGINAL/);

  const catnoTrap = checkPressingMatch({ release: reissue, expected: { catno: '92279-1' } });
  assert.equal(catnoTrap.status, 'mismatch');
  assert.match(catnoTrap.message, /92279-1/);

  const yearGap = checkPressingMatch({ release: original, expected: { year: 2023 } });
  assert.equal(yearGap.status, 'mismatch');
  assert.equal(yearGap.direction, 'year_gap');

  const ok = checkPressingMatch({ release: original, expected: { year: 1993, catno: '92279-1', is_reissue: false } });
  assert.equal(ok.status, 'ok');

  assert.equal(checkPressingMatch({ release: null }).status, 'unknown');
});

test('watchRuleFromVerdict: builds the "Alert me under $120" rule for the drop path', () => {
  const r = watchRuleFromVerdict({
    user_id: 'usr_crate_1',
    release: { artist_id: 'art_snoop-dogg', title: 'Doggystyle', discogs_release_id: 829287 },
    target_price_cents: 12000,
    label_contains: 'Death Row',
  });
  assert.equal(r.ok, true);
  assert.equal(r.rule.user_id, 'usr_crate_1');
  assert.equal(r.rule.artist_id, 'art_snoop-dogg');
  assert.equal(r.rule.watch_vinyl, true);
  assert.equal(r.rule.target_price_cents, 12000);
  assert.equal(r.rule.title_contains, 'doggystyle'); // normalized, matches evaluateWatchRule text
  assert.equal(r.rule.label_contains, 'Death Row');
  assert.deepEqual(r.rule.channels, ['email']);
  assert.equal(r.rule.discogs_release_id, 829287);
});

test('watchRuleFromVerdict: refuses loudly when the rule would be noise', () => {
  assert.equal(watchRuleFromVerdict({ user_id: null, release: { artist_id: 'a' }, target_price_cents: 100 }).ok, false);
  assert.equal(watchRuleFromVerdict({ user_id: 'u', release: { title: 'x' }, target_price_cents: 100 }).ok, false); // no artist_id
  assert.equal(watchRuleFromVerdict({ user_id: 'u', release: { artist_id: 'a' }, target_price_cents: 0 }).ok, false);
  assert.equal(watchRuleFromVerdict({ user_id: 'u', release: { artist_id: 'a' }, target_price_cents: 100, channels: ['pigeon'] }).rule.channels[0], 'email');
});
