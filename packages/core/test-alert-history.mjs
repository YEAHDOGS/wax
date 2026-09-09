/**
 * Smoke/regression check for `packages/core/src/alert-history.js`.
 *
 * Run: `node --test packages/core/test-alert-history.mjs`
 * No dependencies beyond the Node standard library. Runs against a fresh
 * in-memory store built from fixtures, never the network. The render must
 * stay dependency-free: a full static HTML page with no client JS, no CSS
 * framework — the smallest possible answer to "where do I see my alerts".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  renderAlertHistory,
} from './src/index.js';

const BASE = '2026-09-09T10:00:00.000Z';

function freshUser() {
  const store = createStore();
  store.users.insert({
    id: 'usr_hist', email: 'hist@example.com', handle: 'hist',
    display_name: 'Hist', avatar_url: null,
    plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: new Date().toISOString(),
  });
  const artist = store.artists.insert({
    id: 'art_hist', name: 'Alice Coltrane', discogs_artist_id: null,
    image_url: null, genres: ['jazz'], created_at: new Date().toISOString(),
  });
  const release = store.releases.insert({
    id: 'rel_hist', cat: 'WAX-9002', artist_id: artist.id, title: 'Ptah, the El Daoud',
    year: 1970, label: 'Impulse!', label_cat: null, format: 'LP', variant: null,
    pressing_qty: null, cover_url: null, ink: 'ink', discogs_release_id: null,
    released_at: null, created_at: new Date().toISOString(),
  });
  return { store, artist, release };
}

function addAlert(store, over = {}) {
  return store.alerts.insert({
    id: over.id ?? `alr_${Math.random().toString(36).slice(2, 8)}`,
    user_id: 'usr_hist',
    release_id: 'rel_hist',
    watch_id: null,
    kind: 'drop',
    state: 'live',
    detected_at: BASE,
    dispatched_at: BASE,
    read_at: null,
    channels: ['email'],
    listing_url: 'https://vinyl-den.example/x',
    price_cents: 3499,
    created_at: BASE,
    ...over,
  });
}

test('renders a complete standalone page', () => {
  const { store } = freshUser();
  addAlert(store);
  const html = renderAlertHistory(store, 'usr_hist');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>Wax — alert history</title>'));
  assert.ok(html.includes('Alice Coltrane'));
  assert.ok(html.includes('Ptah, the El Daoud'));
  assert.ok(html.includes('$34.99'));
});

test('state filter shows only that state, and the filter row carries counts', () => {
  const { store } = freshUser();
  addAlert(store, { id: 'alr_live', state: 'live' });
  addAlert(store, { id: 'alr_caught', state: 'caught', title: undefined, kind: 'restock' });

  const live = renderAlertHistory(store, 'usr_hist', { state: 'live' });
  assert.ok(live.includes('[live]'));
  assert.ok(!live.includes('[caught]'));

  const caught = renderAlertHistory(store, 'usr_hist', { state: 'caught' });
  assert.ok(caught.includes('[caught]'));
  assert.ok(!caught.includes('[live]'));

  // Every state's count appears in the filter row, like the board's filter row.
  const all = renderAlertHistory(store, 'usr_hist');
  assert.ok(all.includes('?state=all'));
  assert.ok(all.includes('?state=sold_out'));
  assert.ok(/live \(1\)|live&#x2009;\(1\)|>live<.*\(1\)/s.test(all));
});

test('unknown states are ignored and render as all', () => {
  const { store } = freshUser();
  addAlert(store, { state: 'live' });
  const html = renderAlertHistory(store, 'usr_hist', { state: 'nonsense' });
  assert.ok(html.includes('[live]'));
});

test('unread alerts are marked; read ones are not', () => {
  const { store } = freshUser();
  addAlert(store, { id: 'alr_unread', read_at: null });
  addAlert(store, { id: 'alr_read', read_at: BASE });

  const html = renderAlertHistory(store, 'usr_hist');
  const itemFor = (id) => html.slice(html.indexOf(`data-id="${id}"`)).split('</li>')[0];
  assert.ok(
    itemFor('alr_unread').includes('<span class="unread">unread</span>'),
    'unread row carries the unread marker',
  );
  assert.ok(!itemFor('alr_read').includes('unread'), 'read row has no unread marker');
});

test('hostile data is escaped; javascript: URLs never become links', () => {
  const { store } = freshUser();
  store.artists.insert({
    id: 'art_evil', name: '<script>alert("a")</script>', discogs_artist_id: null,
    image_url: null, genres: [], created_at: BASE,
  });
  store.releases.insert({
    id: 'rel_evil', cat: 'X', artist_id: 'art_evil', title: '<img src=x onerror=alert(1)>',
    year: null, label: null, label_cat: null, format: 'LP', variant: null,
    pressing_qty: null, cover_url: null, ink: 'ink', discogs_release_id: null,
    released_at: null, created_at: BASE,
  });
  addAlert(store, {
    id: 'alr_evil', release_id: 'rel_evil',
    listing_url: 'javascript:alert(document.cookie)',
  });

  const html = renderAlertHistory(store, 'usr_hist');
  assert.ok(!html.includes('<script>alert("a")</script>'), 'artist name is escaped');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'release title is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped script tag present');
  assert.ok(!html.includes('href="javascript:'), 'javascript: URL never becomes a link');
});

test('only the requesting user’s alerts appear', () => {
  const { store } = freshUser();
  addAlert(store);
  const html = renderAlertHistory(store, 'usr_stranger');
  assert.ok(!html.includes('Alice Coltrane'));
  assert.ok(html.includes('nothing here yet'), 'stranger gets an empty state, not a leak');
});

test('alerts for a deleted release fall back to the raw id, never crash', () => {
  const { store } = freshUser();
  addAlert(store, { release_id: 'rel_gone' });
  const html = renderAlertHistory(store, 'usr_hist');
  assert.ok(html.includes('rel_gone'));
});

test('empty history renders a helpful empty state per filter', () => {
  const { store } = freshUser();
  const html = renderAlertHistory(store, 'usr_hist');
  assert.ok(html.includes('nothing here yet'));
  const live = renderAlertHistory(store, 'usr_hist', { state: 'live' });
  assert.ok(live.includes('nothing here yet'));
});
