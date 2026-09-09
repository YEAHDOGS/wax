/**
 * Smoke/regression check for `packages/core/src/collection-batch.js` —
 * the Discogs collection → alert-engine batch adapter.
 *
 * Run: `node --test packages/core/test-collection-batch.mjs`
 * Zero dependencies beyond the Node standard library. Pins the five
 * properties the adapter exists for:
 *
 * 1. The dcruzship collection fixture maps to engine-shaped releases —
 *    id, title, artists, labels (with catno), formats, year, uri, thumb,
 *    Wax-only price/stock annotations, and collection trace fields.
 * 2. Malformed entries are skipped LOUDLY (`{ index, reason }`), never
 *    silently dropped and never fed to the engine; valid rows survive.
 * 3. A non-collection payload throws — the scheduler's onTick path gets
 *    a refusal, not an empty quiet batch.
 * 4. `createCollectionProvider` plugs straight into `createAlertScheduler`'s
 *    `getReleases()` — tick 1 queues `new` events against the wantlist
 *    fixture, tick 2 on the same collection goes quiet.
 * 5. Wax annotations drive engine semantics: an entry whose annotated
 *    price falls below the want threshold fires `price_drop` exactly once.
 *
 * Fixture data is synthetic (see the fixture's `note`) — no network, no
 * token, ever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectionToBatch,
  createCollectionProvider,
  mapCollectionEntry,
  COLLECTION_SKIP_REASONS,
} from './src/collection-batch.js';
import { runEngine } from './src/alert-engine.js';
import { createAlertScheduler } from './src/alert-scheduler.js';
import { createAlertQueue } from './src/alert-queue.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const COLLECTION = load('dcruzship-collection.json');
const WANTS = load('wantlist.json').wants;

test('fixture maps every entry to an engine-shaped release', () => {
  const { releases, skipped } = collectionToBatch(COLLECTION);
  assert.equal(releases.length, 8, 'fixture carries 8 valid entries');
  assert.deepEqual(skipped, [], 'clean fixture skips nothing');

  const doom = releases.find((r) => r.id === 15236781);
  assert.equal(doom.title, 'Operation: Doomsday');
  assert.deepEqual(doom.artists.map((a) => a.name), ['MF DOOM']);
  assert.equal(doom.labels[0].name, 'Rhymesayers Entertainment');
  assert.equal(doom.labels[0].catno, 'RSE0111-1');
  assert.equal(doom.formats[0].name, 'Vinyl');
  assert.ok(doom.formats[0].descriptions.includes('Gatefold'));
  assert.equal(doom.year, 2011);
  assert.equal(doom.uri, 'https://www.discogs.com/release/15236781');
  assert.ok(doom.thumb.endsWith('.jpg'));
  // Wax-only annotations ride through; trace fields stay attached.
  assert.equal(doom.price_cents, 3499);
  assert.equal(doom.in_stock, true);
  assert.equal(doom.collection.instance_id, 900001);
  assert.equal(doom.collection.folder_id, 1);

  const doggystyle = releases.find((r) => r.id === 210101);
  assert.equal(doggystyle.title, 'Doggystyle');
  assert.equal(doggystyle.year, 1993);
  assert.equal(doggystyle.price_cents, null, 'no annotation → null, not 0');
  assert.equal(doggystyle.in_stock, null, 'unknown stock stays null');
});

test('malformed entries skip loudly, valid rows survive', () => {
  const { releases, skipped } = collectionToBatch({
    releases: [
      { id: 1 }, // missing_basic_information
      { basic_information: { title: 'No ID' } }, // missing_id
      { basic_information: { id: 3, title: '   ' } }, // missing_title
      COLLECTION.releases[0], // valid
    ],
  });
  assert.equal(releases.length, 1);
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ['missing_basic_information', 'missing_id', 'missing_title'],
  );
  assert.deepEqual(
    skipped.map((s) => s.index),
    [0, 1, 2],
  );
  for (const reason of skipped.map((s) => s.reason)) {
    assert.ok(COLLECTION_SKIP_REASONS.includes(reason), `reason ${reason} is a known code`);
  }
});

test('non-collection payloads throw loudly', () => {
  for (const bad of [null, undefined, {}, { releases: 'nope' }, []]) {
    assert.throws(() => collectionToBatch(bad), TypeError, JSON.stringify(bad));
  }
});

test('mapCollectionEntry keeps artist-less rows (engine just cannot match them)', () => {
  const entry = {
    basic_information: { id: 42, title: 'Untitled', artists: [], labels: [], formats: [] },
  };
  const { release, skip } = mapCollectionEntry(entry);
  assert.equal(skip, null);
  assert.equal(release.title, 'Untitled');
  assert.deepEqual(release.artists, []);
});

test('engine matches a want against the collection batch (new) then goes quiet', () => {
  const { releases } = collectionToBatch(COLLECTION);
  const first = runEngine({ wantlist: WANTS, releases, nowMs: 1_000_000 });
  const doomEvents = first.events.filter((e) => e.release_id === 15236781);
  assert.ok(doomEvents.length > 0, 'MF DOOM vinyl watch should fire on the collection row');
  assert.ok(
    doomEvents.every((e) => e.kind === 'new' || e.kind === 'restock'),
    'first sight of collection rows fires new/restock, never price_drop',
  );

  const second = runEngine({ wantlist: WANTS, releases, prevStates: first.prevStates, nowMs: 2_000_000 });
  assert.equal(second.events.length, 0, 'unchanged collection stays quiet on re-scan');
});

test('annotated price drop fires price_drop exactly once', () => {
  const pricey = JSON.parse(JSON.stringify(COLLECTION));
  const entry = pricey.releases.find((r) => r.id === 9900210);
  entry.price_cents = 4500;
  const cheaper = JSON.parse(JSON.stringify(COLLECTION));
  cheaper.releases.find((r) => r.id === 9900210).price_cents = 3000;

  const want = [{ id: 'want_benji', user_id: 'u_brando', artist: 'Sun Kil Moon', format: 'Vinyl', max_price_cents: 6000 }];
  const first = runEngine({ wantlist: want, releases: collectionToBatch(pricey).releases, nowMs: 1_000_000 });
  assert.ok(
    first.events.some((e) => e.release_id === 9900210),
    'Benji under $60 should fire on first sight',
  );

  const second = runEngine({
    wantlist: want,
    releases: collectionToBatch(cheaper).releases,
    prevStates: first.prevStates,
    nowMs: 2_000_000,
  });
  const drops = second.events.filter((e) => e.release_id === 9900210);
  assert.equal(drops.length, 1, 'price fall fires once');
  assert.equal(drops[0].kind, 'price_drop');
  assert.equal(drops[0].prev_price_cents, 4500);
  assert.equal(drops[0].price_cents, 3000);

  const third = runEngine({
    wantlist: want,
    releases: collectionToBatch(cheaper).releases,
    prevStates: second.prevStates,
    nowMs: 3_000_000,
  });
  assert.equal(third.events.filter((e) => e.release_id === 9900210).length, 0, 'drop never re-fires');
});

test('createCollectionProvider is a scheduler-ready getReleases', async () => {
  const queue = createAlertQueue();
  const getReleases = createCollectionProvider(COLLECTION);
  const scheduler = createAlertScheduler({
    getReleases,
    getWantlist: () => WANTS,
    queue,
    now: () => 1_000_000,
  });
  const first = await scheduler.tick();
  assert.ok(first.events.length > 0, 'tick 1 on the collection queues alerts');
  assert.equal(first.queued.length, first.events.length);
  const second = await scheduler.tick();
  assert.equal(second.events.length, 0, 'tick 2 on an unchanged collection goes quiet');
});

test('createCollectionProvider reports skipped entries through onSkipped', () => {
  const seen = [];
  const getReleases = createCollectionProvider(
    { releases: [{ id: 9 }, COLLECTION.releases[0]] },
    { onSkipped: (s) => seen.push(...s) },
  );
  const releases = getReleases();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, 15236781);
  assert.deepEqual(seen, [{ index: 0, reason: 'missing_basic_information' }]);
});
