/**
 * Smoke/regression check for `packages/core/src/scanner.js`.
 *
 * Run: `node --test packages/core/test-scan.mjs`
 * No dependencies beyond the Node standard library. Every scan input is a
 * hand-written fixture array — there is no live fetching here, ever. If these
 * fixtures stop producing the same snapshots, diffs and matches, the scan
 * contract with the alert engine has changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProduct,
  normalizeProductList,
  snapshotHash,
  diffSnapshots,
  scanSnapshot,
  matchArtists,
  dedupeCandidates,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures: heterogeneous raw records, one per scan-method shape.
 * ------------------------------------------------------------------ */

const FIXTURES = {
  /** Shopify /products.json shape: nested image object, string price. */
  shopify: [
    { title: '  Mingus Ah Um — 180g Vinyl LP  ', vendor: 'Vinyl Den', url: '/products/mingus-ah-um', image: { src: 'https://cdn/x.jpg' }, price: '$34.99' },
    { title: 'Kind of Blue (Reissue)', vendor: 'Vinyl Den', url: '/products/kind-of-blue', image: { src: 'https://cdn/y.jpg' }, price: '$29.99' },
  ],

  /** Feed item shape: link instead of url, cents as number. */
  feed: [
    { name: 'Bitches Brew Limited Edition', brand: 'Jazz Corner', link: 'https://corner.example/lp/bb', thumbnail: 'https://corner.example/t.jpg', price_cents: 4999 },
  ],

  /** JSON-LD node shape: @id, offers.price. */
  jsonld: [
    { '@type': 'Product', name: 'A Love Supreme LP', brand: 'Blue Note Shop', '@id': 'https://bn.example/als', offers: { price: '27.50' } },
  ],

  /** Second fetch of the same shopify list with ONE new item appended. */
  shopifyRestock: [
    { title: '  Mingus Ah Um — 180g Vinyl LP  ', vendor: 'Vinyl Den', url: '/products/mingus-ah-um', image: { src: 'https://cdn/x.jpg' }, price: '$34.99' },
    { title: 'Kind of Blue (Reissue)', vendor: 'Vinyl Den', url: '/products/kind-of-blue', image: { src: 'https://cdn/y.jpg' }, price: '$29.99' },
    { title: 'Time Out LP', vendor: 'Vinyl Den', url: '/products/time-out', image: { src: 'https://cdn/z.jpg' }, price: '$24.99' },
  ],

  /** Useless records: missing title/artist, garbage, wrong types. */
  junk: [
    { title: 'Orphan title' },
    { vendor: 'Nameless shop' },
    'a string, not an object',
    null,
    { title: '   ', artist: '  ' },
  ],
};

const ARTISTS = [
  { id: 'a1', name: 'Charles Mingus', aliases: ['Mingus'] },
  { id: 'a2', name: 'Miles Davis', aliases: [] },
];

test('normalizeProduct: heterogeneous shapes become canonical records', () => {
  const s = normalizeProduct(FIXTURES.shopify[0], 'platform-api');
  assert.equal(s.title, 'Mingus Ah Um — 180g Vinyl LP');
  assert.equal(s.artist, 'Vinyl Den');
  assert.equal(s.url, '/products/mingus-ah-um');
  assert.equal(s.image, 'https://cdn/x.jpg');
  assert.equal(s.price_cents, 3499);
  assert.equal(s.currency, 'USD');
  assert.equal(s.method, 'platform-api');
  // Vinyl-edition noise is stripped from the identity key but kept in the title.
  assert.equal(s.identity_key, 'vinyl den — mingus ah um');

  const f = normalizeProduct(FIXTURES.feed[0], 'feed');
  assert.equal(f.title, 'Bitches Brew Limited Edition');
  assert.equal(f.artist, 'Jazz Corner');
  assert.equal(f.url, 'https://corner.example/lp/bb');
  assert.equal(f.price_cents, 4999);
  assert.equal(f.currency, null);

  const j = normalizeProduct(FIXTURES.jsonld[0], 'structured-data');
  assert.equal(j.title, 'A Love Supreme LP');
  assert.equal(j.artist, 'Blue Note Shop');
  assert.equal(j.url, 'https://bn.example/als');
  assert.equal(j.price_cents, 2750);

  assert.equal(normalizeProduct(FIXTURES.junk[0], 'feed'), null);
  assert.equal(normalizeProduct(FIXTURES.junk[3], 'feed'), null);
});

test('normalizeProduct: returns null (never throws) for non-object raw', () => {
  for (const junk of FIXTURES.junk) {
    assert.doesNotThrow(() => {
      assert.equal(normalizeProduct(junk, 'heuristic'), null);
    });
  }
});

test('normalizeProductList: counts skipped junk', () => {
  const { products, skipped } = normalizeProductList([...FIXTURES.shopify, ...FIXTURES.junk], 'platform-api');
  assert.equal(products.length, 2);
  assert.equal(skipped, 5);
});

test('snapshotHash: deterministic, order-independent, change-sensitive', () => {
  const { products: a } = normalizeProductList(FIXTURES.shopify, 'platform-api');
  const { products: b } = normalizeProductList([...FIXTURES.shopify].reverse(), 'platform-api');
  const { products: c } = normalizeProductList(FIXTURES.shopifyRestock, 'platform-api');

  const ha = snapshotHash(a);
  assert.equal(ha, snapshotHash(b), 'order must not move the hash');
  assert.match(ha, /^[0-9a-f]{64}$/);

  // Same catalog, price change only → hash must move.
  const repriced = FIXTURES.shopify.map((r) => ({ ...r, price: '$39.99' }));
  const { products: d } = normalizeProductList(repriced, 'platform-api');
  assert.notEqual(snapshotHash(d), ha, 'a price change is a snapshot change');

  assert.notEqual(snapshotHash(c), ha, 'a restock changes the hash');
  assert.equal(snapshotHash([]), snapshotHash([]), 'empty snapshot is stable');
});

test('diffSnapshots: added / removed / unchanged by identity key', () => {
  const { products: prev } = normalizeProductList(FIXTURES.shopify, 'platform-api');
  const { products: next } = normalizeProductList(FIXTURES.shopifyRestock, 'platform-api');
  const diff = diffSnapshots(prev, next);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].title, 'Time Out LP');
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.unchanged.length, 2);

  const { products: emptier } = normalizeProductList([], 'platform-api');
  const diff2 = diffSnapshots(prev, emptier);
  assert.equal(diff2.removed.length, 2);
  assert.equal(diff2.added.length, 0);
});

test('scanSnapshot: full pipeline, first scan and restock scan', () => {
  const first = scanSnapshot({ source_id: 'src-1', method: 'platform-api', prevSnapshot: null, rawList: FIXTURES.shopify });
  assert.equal(first.candidates.length, 2, 'first scan treats everything as new');
  assert.equal(first.log.parsed, 2);
  assert.equal(first.log.skipped, 0);
  assert.equal(first.log.hash_changed, true);
  assert.match(first.snapshot.hash, /^[0-9a-f]{64}$/);
  assert.ok(first.log.scanned_at);

  const restock = scanSnapshot({ source_id: 'src-1', method: 'platform-api', prevSnapshot: first.snapshot, rawList: FIXTURES.shopifyRestock });
  assert.equal(restock.candidates.length, 1);
  assert.equal(restock.candidates[0].title, 'Time Out LP');
  assert.equal(restock.log.added, 1);
  assert.equal(restock.log.hash_changed, true);

  const steady = scanSnapshot({ source_id: 'src-1', method: 'platform-api', prevSnapshot: restock.snapshot, rawList: FIXTURES.shopifyRestock });
  assert.equal(steady.candidates.length, 0, 'no new items, no candidates');
  assert.equal(steady.log.hash_changed, false);
  assert.equal(steady.log.unchanged, 3);

  const withJunk = scanSnapshot({ source_id: 'src-2', method: 'heuristic', prevSnapshot: null, rawList: [...FIXTURES.feed, ...FIXTURES.junk] });
  assert.equal(withJunk.candidates.length, 1);
  assert.equal(withJunk.log.skipped, 5);
});

test('matchArtists: name and alias matching, case-insensitive', () => {
  const { products } = normalizeProductList(
    [
      { title: 'Mingus Moves', artist: 'Charles Mingus', url: '/a' },
      { title: 'Ah Um', artist: 'mingus', url: '/b' },
      { title: 'Kind of Blue', artist: 'MILES DAVIS', url: '/c' },
      { title: 'Blue Train', artist: 'John Coltrane', url: '/d' },
    ],
    'platform-api'
  );
  const matches = matchArtists(products, ARTISTS);
  assert.equal(matches.length, 3);
  assert.equal(matches[0].artist.id, 'a1');
  assert.equal(matches[1].artist.id, 'a1', 'alias match');
  assert.equal(matches[2].artist.id, 'a2', 'case-insensitive match');
});

test('dedupeCandidates: one alert per release across sources', () => {
  const { products: p1 } = normalizeProductList(FIXTURES.shopify, 'platform-api');
  const { products: p2 } = normalizeProductList(FIXTURES.shopify, 'platform-api'); // same records, second shop
  const matches = [
    ...matchArtists(p1, [{ id: 'a1', name: 'Vinyl Den', aliases: [] }]).map((m) => ({ ...m, source_id: 'src-1' })),
    ...matchArtists(p2, [{ id: 'a1', name: 'Vinyl Den', aliases: [] }]).map((m) => ({ ...m, source_id: 'src-2' })),
  ];
  assert.equal(matches.length, 4);
  const deduped = dedupeCandidates(matches);
  assert.equal(deduped.length, 2, 'same release on two shops = one alert');
  for (const d of deduped) {
    assert.deepEqual([...d.sources_seen].sort(), ['src-1', 'src-2']);
  }
  assert.equal(dedupeCandidates([]).length, 0);
});
