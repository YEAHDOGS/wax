/**
 * Tests for packages/core/src/crate-scan.js — the Crate Digger scan
 * pipeline: barcode/catalog# normalization, release resolution, and the
 * per-scan-session marketplace stats cache. Everything runs against
 * fixtures — no network, no keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCode,
  createReleaseResolver,
  createFixtureResolver,
  createMarketplaceStatsCache,
  runCrateScan,
} from './src/crate-scan.js';

const listing = (price_cents, media_condition) => ({ price_cents, media_condition, currency: 'USD' });

/* ---------------- normalizeCode ---------------- */

test('normalizeCode classifies barcodes and catalog numbers', () => {
  assert.deepEqual(normalizeCode('012345678905'), { code: '012345678905', kind: 'barcode' }); // UPC-A
  assert.deepEqual(normalizeCode('5 012345 678905'), { code: '5012345678905', kind: 'barcode' }); // EAN-13 w/ spaces
  assert.deepEqual(normalizeCode('0-12345-67890-5'), { code: '012345678905', kind: 'barcode' });
  assert.deepEqual(normalizeCode('12345670'), { code: '12345670', kind: 'barcode' }); // EAN-8
  assert.deepEqual(normalizeCode('92279-1'), { code: '92279-1', kind: 'catalog' });
  assert.deepEqual(normalizeCode('rse0111-1'), { code: 'RSE0111-1', kind: 'catalog' });
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode('   '), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
});

/* ---------------- release resolver ---------------- */

test('createReleaseResolver requires a search function (loud)', () => {
  assert.throws(() => createReleaseResolver({}), /search/);
  assert.throws(() => createReleaseResolver(), /search/);
});

test('resolver: single candidate resolves to found', async () => {
  const release = { id: 829287, title: 'Doggystyle', artist: 'Snoop Dogg', catnos: ['92279-1'], year: 1993 };
  const resolver = createReleaseResolver({ search: async () => [release] });
  const out = await resolver.resolve('92279-1');
  assert.equal(out.status, 'found');
  assert.equal(out.release.id, 829287);
});

test('resolver: zero candidates resolves to not_found', async () => {
  const resolver = createReleaseResolver({ search: async () => [] });
  assert.deepEqual(await resolver.resolve('ZZZ-999'), { status: 'not_found', code: 'ZZZ-999' });
});

test('resolver: multiple pressings are ambiguous — never silently picks', async () => {
  const a = { id: 829287, title: 'Doggystyle', artist: 'Snoop Dogg', catnos: ['92279-1'], year: 1993, label: 'Death Row Records (2)', is_reissue: false, junk: 'dropped' };
  const b = { id: 30648607, title: 'Doggystyle', artist: 'Snoop Dogg', catnos: ['92279-1X'], year: 2023, label: 'Death Row', is_reissue: true, junk: 'dropped' };
  const resolver = createReleaseResolver({ search: async () => [a, b, a] }); // duplicate id included
  const out = await resolver.resolve('DOGGYSTYLE');
  assert.equal(out.status, 'ambiguous');
  assert.equal(out.candidates.length, 2); // deduped by id
  assert.deepEqual(Object.keys(out.candidates[0]).sort(), ['artist', 'catnos', 'id', 'is_reissue', 'label', 'title', 'year'].sort());
  assert.equal(out.candidates[0].junk, undefined); // trimmed for the pick UI
});

test('resolver: garbage search return fails loudly at the seam', async () => {
  const resolver = createReleaseResolver({ search: async () => ({ id: 1 }) });
  await assert.rejects(() => resolver.resolve('X'), /must return an array/);
});

test('fixture resolver resolves the Doggystyle fixture hermetically', async () => {
  const resolver = createFixtureResolver();
  const found = await resolver.resolve('92279-1');
  assert.equal(found.status, 'found');
  assert.equal(found.release.id, 829287);
  assert.equal(found.release.artist, 'Snoop Dogg');
  assert.equal((await resolver.resolve('0000000000000')).status, 'not_found');
});

/* ---------------- stats cache ---------------- */

test('createMarketplaceStatsCache requires a fetchStats function (loud)', () => {
  assert.throws(() => createMarketplaceStatsCache({}), /fetchStats/);
});

test('stats cache fetches once per release per session and labels asks', async () => {
  let calls = 0;
  const cache = createMarketplaceStatsCache({
    fetchStats: async (releaseId) => {
      calls++;
      assert.equal(releaseId, 829287);
      return { listings: [listing(13000, 'VG'), listing(15000, 'VG'), listing(20400, 'VG+')], fetched_at: '2026-09-09T15:00:00Z' };
    },
  });
  const first = await cache.get(829287);
  const second = await cache.get(829287);
  assert.equal(calls, 1);
  assert.equal(first, second); // same cached object
  assert.equal(first.listings_count, 3);
  assert.equal(first.summary.median_cents, 15000);
  assert.equal(first.summary.byGrade['VG'].n, 2);
  assert.equal(first.fetched_at, '2026-09-09T15:00:00Z');
  assert.equal(first.is_asking_prices, true); // sellers are asking, never solds
});

test('stats cache: different releases fetch separately; clear() resets', async () => {
  let calls = 0;
  const cache = createMarketplaceStatsCache({ fetchStats: async () => (calls++, { listings: [] }) });
  await cache.get(1);
  await cache.get(2);
  assert.equal(calls, 2);
  cache.clear();
  await cache.get(1);
  assert.equal(calls, 3);
});

test('stats cache: garbage fetch return fails loudly', async () => {
  const cache = createMarketplaceStatsCache({ fetchStats: async () => [listing(1, 'VG')] });
  await assert.rejects(() => cache.get(9), /object with a listings array/);
});

/* ---------------- runCrateScan ---------------- */

function doggystylePipeline() {
  const fixture = createFixtureResolver();
  let calls = 0;
  const statsCache = createMarketplaceStatsCache({
    fetchStats: async (releaseId) => {
      calls++;
      assert.equal(releaseId, 829287);
      return {
        listings: [
          listing(13000, 'VG'),
          listing(15000, 'VG'),
          listing(20400, 'VG+'),
        ],
        fetched_at: '2026-09-09T15:00:00Z',
      };
    },
  });
  return { fixture, statsCache, calls: () => calls };
}

test('runCrateScan: full pipeline — code in, release + stats out', async () => {
  const { fixture, statsCache } = doggystylePipeline();
  const out = await runCrateScan('92279-1', { resolver: fixture, statsCache });
  assert.equal(out.status, 'found');
  assert.equal(out.code, '92279-1');
  assert.equal(out.kind, 'catalog');
  assert.equal(out.release.id, 829287);
  assert.equal(out.release.title, 'Doggystyle');
  assert.equal(out.stats.summary.median_cents, 15000);
  assert.equal(out.stats.is_asking_prices, true);
});

test('runCrateScan: invalid input, not_found, and ambiguous pass through', async () => {
  const { fixture, statsCache } = doggystylePipeline();
  assert.deepEqual(await runCrateScan('   ', { resolver: fixture, statsCache }), { status: 'invalid', reason: 'empty_scan' });
  const missing = await runCrateScan('NOPE-000', { resolver: fixture, statsCache });
  assert.equal(missing.status, 'not_found');
  assert.equal(missing.kind, 'catalog');

  const ambiguousResolver = createReleaseResolver({
    search: async () => [
      { id: 1, title: 'X', artist: 'Y', catnos: ['A'], year: 1993 },
      { id: 2, title: 'X', artist: 'Y', catnos: ['A'], year: 2023, is_reissue: true },
    ],
  });
  const ambiguous = await runCrateScan('A', { resolver: ambiguousResolver, statsCache });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
});

test('runCrateScan: missing adapters throw loud dev-contract errors', async () => {
  const { fixture, statsCache } = doggystylePipeline();
  await assert.rejects(() => runCrateScan('92279-1', { statsCache }), /resolver/);
  await assert.rejects(() => runCrateScan('92279-1', { resolver: fixture }), /statsCache/);
  await assert.rejects(() => runCrateScan('92279-1', {}), /resolver/);
});
