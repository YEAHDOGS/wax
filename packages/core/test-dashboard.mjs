/**
 * Smoke/regression check for `packages/core/src/dashboard.js`.
 *
 * Run: `node --test packages/core/test-dashboard.mjs`
 * No dependencies beyond the Node standard library. Runs against a fresh
 * in-memory store built from fixtures, never the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  addWatch,
  addSource,
  renderDashboard,
} from './src/index.js';

const SHOP_WITH_FEED = `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" title="New Arrivals" href="/feeds/new-arrivals.xml">
<title>Vinyl Den</title></head><body></body></html>`;

function freshUser() {
  const store = createStore();
  store.users.insert({
    id: 'usr_dash', email: 'dash@example.com', handle: 'dash',
    display_name: 'Dash', avatar_url: null,
    plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  });
  const artist = store.artists.insert({
    id: 'art_dash', name: 'Alice Coltrane', discogs_artist_id: null,
    image_url: null, genres: ['jazz'], created_at: new Date().toISOString(),
  });
  const release = store.releases.insert({
    id: 'rel_dash', cat: 'WAX-9001', artist_id: artist.id, title: 'Journey in Satchidananda',
    year: 1971, label: 'Impulse!', label_cat: null, format: 'LP', variant: null,
    pressing_qty: null, cover_url: null, ink: 'ink', discogs_release_id: null,
    released_at: null, created_at: new Date().toISOString(),
  });
  return { store, artist, release };
}

test('empty watchlist renders with helpful empty states', async () => {
  const { store } = freshUser();
  const out = await renderDashboard(store, 'usr_dash');
  assert.ok(out.includes('WAX — watchlist status'));
  assert.ok(out.includes('Artists watched (0)'));
  assert.ok(out.includes('Merch sites tracked (0)'));
  assert.ok(out.includes('Recent alerts (0 shown)'));
});

test('watched artists, sites, and alerts all appear in the view', async () => {
  const { store, artist, release } = freshUser();
  const session = store.createSession('usr_dash');
  const watch = await addWatch(session.token, { artist_id: artist.id }, { store });
  await addSource(session.token, { url: 'https://vinyl-den.example/new', label: 'Vinyl Den', html: SHOP_WITH_FEED }, { store });
  store.alerts.insert({
    id: 'alr_dash', user_id: 'usr_dash', release_id: release.id, watch_id: watch.id,
    kind: 'drop', state: 'live',
    detected_at: '2026-09-09T10:00:00.000Z', dispatched_at: null, read_at: null,
    channels: ['email'], listing_url: 'https://vinyl-den.example/x', price_cents: 3499,
    created_at: '2026-09-09T10:00:00.000Z',
  });

  const out = await renderDashboard(store, 'usr_dash');
  assert.ok(out.includes('Alice Coltrane'));
  assert.ok(out.includes('Vinyl Den'));
  assert.ok(out.includes('scannable via feed'));
  assert.ok(out.includes('[live] drop — Alice Coltrane — Journey in Satchidananda ($34.99)'));
});

test('an unscannable site shows its reason, never a silent row', async () => {
  const { store } = freshUser();
  const session = store.createSession('usr_dash');
  await addSource(session.token, {
    url: 'https://flat.example/', html: '<html><body><p>hello</p></body></html>',
    accept_unscannable: true,
  }, { store });
  const out = await renderDashboard(store, 'usr_dash');
  assert.ok(out.includes('NOT scannable'));
  assert.ok(out.includes('no-product-structure'));
});

test('dashboard only shows the requesting user’s rows', async () => {
  const { store, artist } = freshUser();
  const session = store.createSession('usr_dash');
  await addWatch(session.token, { artist_id: artist.id }, { store });
  const out = await renderDashboard(store, 'usr_test');
  assert.ok(!out.includes('Alice Coltrane'));
});
