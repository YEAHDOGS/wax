/**
 * Regression tests for the pure matchers. Fixtures only — no network, no
 * clock. `now` is pinned so every run is deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPriceDrop,
  matchNewPressing,
  matchRestock,
  matchMerch,
  byPriority,
} from '../src/index.js';
import {
  makeListing,
  makePressing,
  makeMerchItem,
  makeSnapshot,
  makeRule,
} from '../src/index.js';

const NOW = '2026-09-10T12:00:00.000Z';
const priceRule = () =>
  makeRule({ target_price_cents: 4000, scope_type: 'release', scope_id: 'rel_blue_train' });

describe('matchPriceDrop', () => {
  it('fires when a listing crosses below the target', () => {
    const prev = makeSnapshot({ listings: [makeListing({ price_cents: 5000 })] });
    const next = makeSnapshot({ listings: [makeListing({ price_cents: 3500 })] });
    const [hit] = matchPriceDrop(priceRule(), prev, next, NOW);
    assert.equal(hit.kind, 'price');
    assert.equal(hit.price_cents, 3500);
    assert.equal(hit.listing_id, 'discogs:1001');
    assert.equal(hit.detected_at, NOW);
  });

  it('fires for a brand-new listing under target', () => {
    const prev = makeSnapshot();
    const next = makeSnapshot({ listings: [makeListing({ price_cents: 3000 })] });
    assert.equal(matchPriceDrop(priceRule(), prev, next, NOW).length, 1);
  });

  it('does not fire when the listing was already under target', () => {
    const prev = makeSnapshot({ listings: [makeListing({ price_cents: 3500 })] });
    const next = makeSnapshot({ listings: [makeListing({ price_cents: 3400 })] });
    assert.equal(matchPriceDrop(priceRule(), prev, next, NOW).length, 0);
  });

  it('does not fire without a target price', () => {
    const rule = makeRule({ target_price_cents: null });
    const next = makeSnapshot({ listings: [makeListing({ price_cents: 100 })] });
    assert.equal(matchPriceDrop(rule, makeSnapshot(), next, NOW).length, 0);
  });

  it('ignores unavailable and above-target listings', () => {
    const rule = priceRule();
    const next = makeSnapshot({
      listings: [
        makeListing({ id: 'a', price_cents: 100, available: false }),
        makeListing({ id: 'b', price_cents: 9999 }),
      ],
    });
    assert.equal(matchPriceDrop(rule, makeSnapshot(), next, NOW).length, 0);
  });

  it('respects release scope', () => {
    const rule = priceRule(); // scoped to rel_blue_train
    const next = makeSnapshot({
      listings: [makeListing({ release_id: 'rel_other', price_cents: 100 })],
    });
    assert.equal(matchPriceDrop(rule, makeSnapshot(), next, NOW).length, 0);
  });
});

describe('matchNewPressing', () => {
  it('fires for a pressing absent last poll', () => {
    const rule = makeRule({ scope_type: 'release', scope_id: 'rel_blue_train' });
    const prev = makeSnapshot();
    const next = makeSnapshot({ pressings: [makePressing()] });
    const [hit] = matchNewPressing(rule, prev, next, NOW);
    assert.equal(hit.kind, 'drop');
    assert.equal(hit.release_id, 'rel_blue_train');
    assert.equal(hit.source, null);
  });

  it('tags wantlist-scope drops with source wantlist', () => {
    const rule = makeRule({ scope_type: 'wantlist', scope_id: 'usr_1' });
    const next = makeSnapshot({ pressings: [makePressing()] });
    const [hit] = matchNewPressing(rule, makeSnapshot(), next, NOW);
    assert.equal(hit.kind, 'drop');
    assert.equal(hit.source, 'wantlist');
  });

  it('stays silent when the pressing was already known', () => {
    const rule = makeRule();
    const snap = makeSnapshot({ pressings: [makePressing()] });
    assert.equal(matchNewPressing(rule, snap, snap, NOW).length, 0);
  });

  it('stays silent when watch_vinyl is off', () => {
    const rule = makeRule({ watch_vinyl: false });
    const next = makeSnapshot({ pressings: [makePressing()] });
    assert.equal(matchNewPressing(rule, makeSnapshot(), next, NOW).length, 0);
  });
});

describe('matchRestock', () => {
  it('fires when a dead listing comes back', () => {
    const rule = makeRule({ scope_type: 'release', scope_id: 'rel_blue_train' });
    const prev = makeSnapshot({ listings: [makeListing({ available: false })] });
    const next = makeSnapshot({ listings: [makeListing({ available: true })] });
    const [hit] = matchRestock(rule, prev, next, NOW);
    assert.equal(hit.kind, 'restock');
    assert.equal(hit.listing_id, 'discogs:1001');
  });

  it('does not treat a brand-new listing as a restock', () => {
    const rule = makeRule();
    const next = makeSnapshot({ listings: [makeListing()] });
    assert.equal(matchRestock(rule, makeSnapshot(), next, NOW).length, 0);
  });

  it('does not fire when the listing never died', () => {
    const rule = makeRule();
    const prev = makeSnapshot({ listings: [makeListing({ available: true })] });
    const next = makeSnapshot({ listings: [makeListing({ available: true, price_cents: 4400 })] });
    assert.equal(matchRestock(rule, prev, next, NOW).length, 0);
  });
});

describe('matchMerch', () => {
  const merchRule = () => makeRule({ merch_types: ['tee', 'poster'] });

  it('fires for a new item of a watched type', () => {
    const next = makeSnapshot({ merch: [makeMerchItem({ merch_type: 'tee' })] });
    const [hit] = matchMerch(merchRule(), makeSnapshot(), next, NOW);
    assert.equal(hit.kind, 'merch');
    assert.equal(hit.listing_id, 'merch:tee_42');
  });

  it('ignores unwatched merch types', () => {
    const next = makeSnapshot({ merch: [makeMerchItem({ id: 'x', merch_type: 'mug' })] });
    assert.equal(matchMerch(merchRule(), makeSnapshot(), next, NOW).length, 0);
  });

  it('stays silent with no watched merch types', () => {
    const rule = makeRule({ merch_types: [] });
    const next = makeSnapshot({ merch: [makeMerchItem()] });
    assert.equal(matchMerch(rule, makeSnapshot(), next, NOW).length, 0);
  });
});

describe('byPriority', () => {
  it('orders drop > price > restock > merch', () => {
    const kinds = ['merch', 'price', 'restock', 'drop'];
    const sorted = byPriority(kinds.map((kind) => ({ kind })));
    assert.deepEqual(sorted.map((c) => c.kind), ['drop', 'price', 'restock', 'merch']);
  });
});
