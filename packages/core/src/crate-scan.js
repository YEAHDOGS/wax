/**
 * Crate Digger scan pipeline (docs/features/crate-digger-price-check.md,
 * build-order steps 1–2): barcode/catalog# → release resolution →
 * marketplace stats, cached per scan session.
 *
 * The moment: a collector in a store scans a record and wants the market
 * data behind the verdict card. This module owns the pipeline; the verdict
 * logic itself lives in `price-verdict.js`, and the card UI consumes the
 * `runCrateScan` result. No login anywhere in this path (Brandon 2026-09-09:
 * "Just let me use the fucking app").
 *
 * Ownership, deliberately split:
 *
 * 1. `normalizeCode(input)` — UPC/EAN vs catalog# classification. UPC-A is
 *    12 digits, EAN-13 is 13, EAN-8 is 8; anything else with non-digit
 *    characters is a catalog# (e.g. `92279-1`). Never throws: garbage in
 *    yields null, not a crash in the aisle.
 * 2. `createReleaseResolver({ search })` — the Discogs seam. `search(code)`
 *    is injected by the caller (the live Discogs `/database/search` call
 *    lives in the service layer, never here). This file opens zero
 *    sockets. Resolution statuses are loud and explicit: `found`,
 *    `ambiguous` (multiple pressings matched — the buyer must pick, the
 *    engine must never pick for them), or `not_found`. A search adapter
 *    that returns garbage fails loudly at the seam (dev bug), never as a
 *    silent mis-resolution in the store.
 * 3. `createMarketplaceStatsCache({ fetchStats })` — the per-scan-session
 *    cache. The stats pull is the expensive one; within one scan session
 *    a release's stats are fetched exactly once, so the card can re-render
 *    against different grades/asking prices without another pull. Results
 *    carry `is_asking_prices: true` because Discogs marketplace stats are
 *    what sellers are *asking* — the UI must label them that way, never
 *    as solds.
 * 4. `createFixtureResolver()` — the dev/test stand-in: resolves the
 *    Doggystyle fixture (cat# 92279-1 → release 829287) from
 *    `fixtures/doggystyle-marketplace.json`. This is what keeps every test
 *    hermetic — no live API, no keys, nothing leaves the machine.
 * 5. `runCrateScan(input, { resolver, statsCache })` — the whole pipeline
 *    in one call: normalize → resolve → stats → one result object the
 *    verdict card can render directly.
 *
 * Nothing here throws on user-visible input (bad scans, empty markets);
 * dev-contract violations (missing adapters) throw loud and early.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeMarketplaceStats } from './price-verdict.js';

/* ------------------------------------------------------------------ *
 * Code normalization
 * ------------------------------------------------------------------ */

/** Digits-only lengths treated as barcodes (EAN-8, UPC-A, EAN-13). */
const BARCODE_LENGTHS = new Set([8, 12, 13]);

/**
 * Normalize a scanned/typed code to `{ code, kind }`. Barcodes are returned
 * digits-only; catalog numbers keep their non-digit characters (dashes are
 * part of the cat# identity, e.g. `92279-1`).
 *
 * `kind` is `'barcode'` or `'catalog'`. Returns null for empty input —
 * never throws.
 *
 * @param {?string} input
 * @returns {?{ code: string, kind: 'barcode' | 'catalog' }}
 */
export function normalizeCode(input) {
  if (input == null) return null;
  const raw = String(input).trim().toUpperCase();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length > 0 && digits.length === raw.replace(/[\s-]/g, '').length && BARCODE_LENGTHS.has(digits.length)) {
    return { code: digits, kind: 'barcode' };
  }
  // Compact form: strip whitespace for comparison, keep the dashes.
  return { code: raw.replace(/\s+/g, ''), kind: 'catalog' };
}

/* ------------------------------------------------------------------ *
 * Release resolution (the Discogs seam)
 * ------------------------------------------------------------------ */

/** Release fields the ambiguous-pick UI is allowed to see. */
const CANDIDATE_FIELDS = ['id', 'title', 'artist', 'catnos', 'year', 'label', 'is_reissue'];

/** Trim a release candidate to the public pick-list shape. */
function trimCandidate(release) {
  const out = {};
  for (const key of CANDIDATE_FIELDS) {
    if (release?.[key] !== undefined) out[key] = release[key];
  }
  return out;
}

/**
 * Create the release resolver. `search` is injected — `(code) => Promise<release[]>`
 * in Discogs-search shape. The live Discogs call lives in the service
 * layer; this module never touches the network. Throws if `search` is not
 * a function (loud constructor, never a silent no-op).
 *
 * @param {{ search: (code: string) => Promise<Array> }} deps
 * @returns {{ resolve: (code: string) => Promise<object> }}
 */
export function createReleaseResolver({ search } = {}) {
  if (typeof search !== 'function') {
    throw new TypeError('createReleaseResolver requires a `search` function — no adapter, no resolution.');
  }
  return {
    /**
     * Resolve a normalized code to a release.
     * @param {string} code — output of normalizeCode
     * @returns one of:
     *   { status: 'found', code, release }
     *   { status: 'not_found', code }
     *   { status: 'ambiguous', code, candidates } — trimmed, deduped by id
     */
    async resolve(code) {
      const results = await search(code);
      if (!Array.isArray(results)) {
        throw new TypeError(`release search for "${code}" must return an array of candidates — got ${typeof results}.`);
      }
      const seen = new Map();
      for (const r of results) {
        if (r && r.id != null && !seen.has(r.id)) seen.set(r.id, trimCandidate(r));
      }
      const candidates = [...seen.values()];
      if (candidates.length === 0) return { status: 'not_found', code };
      if (candidates.length === 1) {
        return { status: 'found', code, release: results.find((r) => r && r.id === candidates[0].id) ?? candidates[0] };
      }
      // More than one pressing matched. The buyer picks — the engine must
      // never guess which pressing someone is holding. Say it loudly.
      return { status: 'ambiguous', code, candidates };
    },
  };
}

/**
 * Fixture-backed resolver for dev/tests: resolves the Doggystyle fixture
 * release (cat# 92279-1 → release id 829287). Every test stays hermetic.
 * @returns {{ resolve: (code: string) => Promise<object> }}
 */
export function createFixtureResolver() {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  let byCode = null;
  const load = () => {
    if (byCode) return byCode;
    byCode = new Map();
    const fixture = JSON.parse(readFileSync(join(fixturesDir, 'doggystyle-marketplace.json'), 'utf8'));
    const release = fixture.release;
    const codes = new Set([release.id && String(release.id)]);
    for (const catno of release.catnos ?? []) codes.add(String(catno).toUpperCase());
    for (const code of codes) {
      if (code) byCode.set(code, release);
    }
    return byCode;
  };
  return createReleaseResolver({
    search: async (code) => {
      const release = load().get(String(code).toUpperCase());
      return release ? [release] : [];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Marketplace stats (per-scan-session cache)
 * ------------------------------------------------------------------ */

/**
 * Create the per-scan-session stats cache. `fetchStats(releaseId)` is
 * injected — the service layer pulls Discogs marketplace stats and hands
 * the listings in; this module summarizes and caches. Exactly one pull per
 * release per session, so grade/price what-ifs never re-hit the source.
 *
 * Every result carries `is_asking_prices: true` — Discogs marketplace
 * stats are what sellers are *asking*, never solds; the card UI must say
 * "sellers are asking…" or it is lying to the buyer.
 *
 * @param {{ fetchStats: (releaseId: number|string) => Promise<{ listings?: Array, fetched_at?: string }> }} deps
 * @returns {{ get: (releaseId) => Promise<object>, clear: () => void }}
 */
export function createMarketplaceStatsCache({ fetchStats } = {}) {
  if (typeof fetchStats !== 'function') {
    throw new TypeError('createMarketplaceStatsCache requires a `fetchStats` function — no adapter, no stats.');
  }
  const cache = new Map();
  return {
    async get(releaseId) {
      if (cache.has(releaseId)) return cache.get(releaseId);
      const pulled = await fetchStats(releaseId);
      if (!pulled || typeof pulled !== 'object' || Array.isArray(pulled)) {
        throw new TypeError(`fetchStats(${releaseId}) must return an object with a listings array.`);
      }
      const listings = Array.isArray(pulled.listings) ? pulled.listings : [];
      const stats = {
        release_id: releaseId,
        listings_count: listings.length,
        summary: summarizeMarketplaceStats(listings),
        fetched_at: pulled.fetched_at ?? null,
        is_asking_prices: true,
      };
      cache.set(releaseId, stats);
      return stats;
    },
    clear() {
      cache.clear();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * Run the full scan pipeline: normalize → resolve → stats.
 *
 * @param {?string} input — the raw scan/typed code
 * @param {{ resolver: { resolve }, statsCache: { get } }} deps
 * @returns { status: 'invalid'|'not_found'|'ambiguous'|'found', ... }
 */
export async function runCrateScan(input, { resolver, statsCache } = {}) {
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new TypeError('runCrateScan requires a `resolver` from createReleaseResolver.');
  }
  if (!statsCache || typeof statsCache.get !== 'function') {
    throw new TypeError('runCrateScan requires a `statsCache` from createMarketplaceStatsCache.');
  }
  const normalized = normalizeCode(input);
  if (!normalized) return { status: 'invalid', reason: 'empty_scan' };
  const { code, kind } = normalized;
  const resolution = await resolver.resolve(code);
  if (resolution.status !== 'found') return { ...resolution, kind };
  const stats = await statsCache.get(resolution.release.id);
  return {
    status: 'found',
    code,
    kind,
    release: trimCandidate(resolution.release),
    stats,
  };
}
