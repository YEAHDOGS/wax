/**
 * Smoke/regression check for `packages/core/src/alert-engine.js` — the
 * wantlist alert-matching engine (ALERT-ENGINE-PLAN.md §4 item 4).
 *
 * Run: `node --test packages/core/test-alert-engine.mjs`
 * Zero dependencies beyond the Node standard library. Pinned against the
 * Discogs-shaped fixtures in `packages/core/fixtures/`, not live data:
 *
 * 1. Wantlist matching: hits (artist/alias, title, format, pressing) and
 *    misses (wrong artist, price over threshold, non-matching format).
 * 2. Event classification: `new` on first sight, `restock` when a
 *    previously out-of-stock release is back, `price_drop` when a price
 *    falls below the threshold — and silence when the price rises or the
 *    release was already seen in stock.
 * 3. Fuzzy artist matching: "MF DOOM" matches "Mf Doom" by containment.
 * 4. The full `runEngine` pass wires matching + classification against
 *    the fixture wantlist and prev-states.
 *
 * If any of them fail, the engine's contract with the queue and dispatch
 * changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prevStateKey,
  releaseArtistName,
  fuzzyContains,
  artistMatches,
  wantMatchesRelease,
  classifyEvent,
  runEngine,
} from './src/alert-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const releases = load('discogs-releases.json').releases;
const wants = load('wantlist.json').wants;
const prevStates = load('prev-states.json').prev_states;

const byId = (id) => releases.find((r) => r.id === id);
const wantById = (id) => wants.find((w) => w.id === id);

test('fuzzyContains: substring, token coverage, and non-matches', () => {
  assert.equal(fuzzyContains('Mf Doom', 'MF DOOM'), true); // normalized containment
  assert.equal(fuzzyContains('Sun Kil Moon', 'kil moon'), true); // substring
  assert.equal(fuzzyContains('Vinyl', 'vinyl'), true);
  assert.equal(fuzzyContains('T-Shirt', 'Vinyl'), false); // format miss
  assert.equal(fuzzyContains('Mick Gordon', 'MF DOOM'), false); // artist miss
  assert.equal(fuzzyContains('MF DOOM', ''), false); // empty needle never matches
});

test('artistMatches: aliases fire, wrong artists stay quiet', () => {
  const doomWant = { artist: 'MF DOOM', aliases: ['Doom'] };
  assert.equal(artistMatches(doomWant, byId(15236781)), true);
  assert.equal(artistMatches(doomWant, byId(4400112)), true); // "Mf Doom" fuzzy
  assert.equal(artistMatches(doomWant, byId(2200990)), false); // Mick Gordon: no
  assert.equal(artistMatches({ artist: 'Death Grips' }, byId(6633100)), true);
});

test('wantMatchesRelease: conjunctive filters', () => {
  const vinylDoom = wantById('want_doom_vinyl');
  assert.deepEqual(wantMatchesRelease(vinylDoom, byId(15236781)), { match: true, reasons: [] });
  // tee matches the artist but fails the Vinyl format filter
  const tee = wantMatchesRelease(vinylDoom, byId(4400112));
  assert.equal(tee.match, false);
  assert.ok(tee.reasons.includes('format'));
  // Madvillainy test pressing passes the pressing filter; Benji does not
  const press = wantById('want_test_pressings');
  assert.equal(wantMatchesRelease(press, byId(7742011)).match, true);
  assert.equal(wantMatchesRelease(press, byId(9900210)).match, false);
  // title filter: Benji matches, Operation: Doomsday does not
  const benji = wantById('want_benji_under_60');
  assert.equal(wantMatchesRelease(benji, byId(9900210)).match, true);
  assert.equal(wantMatchesRelease(benji, byId(15236781)).match, false);
});

test('price filter: over-threshold releases stay quiet, unknown prices too', () => {
  const cheap = { user_id: 'u_brando', artist: 'Madvillain', format: 'Vinyl', max_price_cents: 5000 };
  const hit = wantMatchesRelease(cheap, byId(7742011)); // $400 test pressing
  assert.equal(hit.match, false);
  assert.ok(hit.reasons.includes('price'));

  const noPrice = { user_id: 'u_brando', artist: 'Madvillain', format: 'Vinyl', max_price_cents: 5000 };
  const unknown = { ...byId(7742011), price_cents: null };
  assert.equal(wantMatchesRelease(noPrice, unknown).match, false); // unknown price ≠ deal

  // no threshold set → price passes regardless
  assert.equal(wantMatchesRelease({ user_id: 'u_brando', artist: 'Madvillain', format: 'Vinyl' }, byId(7742011)).match, true);
});

test('classifyEvent: new / restock / price_drop / quiet', () => {
  const want = { max_price_cents: 6000 };
  // first sight
  assert.equal(classifyEvent({ want, release: byId(7742011), prev: null }), 'new');
  // out-of-stock → in stock is a restock
  assert.equal(
    classifyEvent({ want, release: byId(6633100), prev: { price_cents: 2999, in_stock: false } }),
    'restock',
  );
  // price fell below threshold → price_drop
  assert.equal(
    classifyEvent({ want, release: byId(9900210), prev: { price_cents: 6000, in_stock: true } }),
    'price_drop',
  );
  // price rose → quiet
  assert.equal(
    classifyEvent({ want, release: byId(9900210), prev: { price_cents: 2000, in_stock: true } }),
    null,
  );
  // price dropped but still above threshold → quiet
  assert.equal(
    classifyEvent({ want: { max_price_cents: 3000 }, release: byId(9900210), prev: { price_cents: 6000, in_stock: true } }),
    null,
  );
  // already seen in stock at the same price → quiet
  assert.equal(
    classifyEvent({ want, release: byId(15236781), prev: { price_cents: 3499, in_stock: true } }),
    null,
  );
});

test('runEngine: full pass over fixture wantlist + prev-states', () => {
  const { events, prevStates: next } = runEngine({ wantlist: wants, releases, prevStates, nowMs: 1786275600000 });

  const byKind = (kind) => events.filter((e) => e.kind === kind);
  // Benji: prev $60 → now $45, under the $60 threshold → price_drop
  const drops = byKind('price_drop');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].release_id, 9900210);
  assert.equal(drops[0].prev_price_cents, 6000);
  assert.equal(drops[0].price_cents, 4500);
  // Madvillainy test pressing: first sight → new
  const news = byKind('new');
  assert.ok(news.some((e) => e.release_id === 7742011));
  // Death Grips for u_other: was out of stock → restock
  const restocks = byKind('restock');
  assert.equal(restocks.length, 1);
  assert.equal(restocks[0].user_id, 'u_other');
  assert.equal(restocks[0].release_id, 6633100);
  // Operation: Doomsday: already seen in stock at the same price → no event
  assert.ok(!events.some((e) => e.release_id === 15236781));

  // prevStates updated: every match re-stamps seen_at, Madvillainy gained a row
  const maddieKey = prevStateKey('u_brando', byId(7742011));
  assert.equal(next[maddieKey].price_cents, 40000);
  assert.equal(next[maddieKey].seen_at, new Date(1786275600000).toISOString());
  // caller's map is not mutated — the engine returns a copy
  assert.equal(prevStates[maddieKey], null);
  assert.notEqual(next[maddieKey], null);

  // every event carries the fields the queue and dispatch need
  for (const e of events) {
    assert.ok(['new', 'restock', 'price_drop'].includes(e.kind));
    assert.ok(e.user_id && e.matched_at && e.artist_name && e.title);
  }
});

test('releaseArtistName joins multi-artist credits', () => {
  assert.equal(releaseArtistName(byId(15236781)), 'MF DOOM');
  assert.equal(
    releaseArtistName({ artists: [{ name: 'MF DOOM' }, { name: 'Madlib' }] }),
    'MF DOOM / Madlib',
  );
});
