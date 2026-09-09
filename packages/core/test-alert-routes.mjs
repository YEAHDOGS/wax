/**
 * Regression checks for the alert-history route wiring —
 * `GET /api/alerts/history?state=` (ALERT-ENGINE-PLAN.md §4 item 6, NEXT).
 *
 * Run: `node --test packages/core/test-alert-routes.mjs`
 * (Node ≥22 applies the same ESM syntax detection to `/api/*.js` that Vercel
 * does in production; on older Node use `--experimental-detect-module`.)
 *
 * No dependencies beyond the Node standard library. The adapter tests call
 * the real route handler with fake req/res objects against the seeded store —
 * never the network, never a live provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertHistory,
  ApiError,
  createStore,
  login,
  store as defaultStore,
} from './src/index.js';

const route = (await import('../../api/alerts/history.js')).default;

const BASE = '2026-09-09T10:00:00.000Z';

function fakeReq({ token = null, query = {} } = {}) {
  return {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query,
  };
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: null,
    headers,
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = v;
    },
    body: null,
    end(body) {
      this.body = body;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The core handler — what the route delegates to.
 * ------------------------------------------------------------------ */

function fixtureUser(store, id = 'usr_route', email = 'route@example.com') {
  store.users.insert({
    id, email, handle: 'route', display_name: 'Route',
    avatar_url: null, plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: BASE,
  });
  const artist = store.artists.insert({
    id: 'art_route', name: 'Route Artist', discogs_artist_id: null,
    image_url: null, genres: [], created_at: BASE,
  });
  const release = store.releases.insert({
    id: 'rel_route', cat: 'WAX-R1', artist_id: artist.id, title: 'Route Test LP',
    year: 2026, label: 'Wax', label_cat: null, format: 'LP', variant: null,
    pressing_qty: null, cover_url: null, ink: 'ink', discogs_release_id: null,
    released_at: null, created_at: BASE,
  });
  return { artist, release };
}

function addAlert(store, over = {}) {
  return store.alerts.insert({
    id: over.id ?? `alr_${Math.random().toString(36).slice(2, 8)}`,
    user_id: 'usr_route',
    release_id: 'rel_route',
    watch_id: null,
    kind: 'drop',
    state: 'live',
    detected_at: BASE,
    dispatched_at: BASE,
    read_at: null,
    channels: ['email'],
    listing_url: 'https://vinyl-den.example/route',
    price_cents: 2999,
    created_at: BASE,
    ...over,
  });
}

test('alertHistory: renders the session user\'s page as a full HTML document', () => {
  const store = createStore();
  fixtureUser(store);
  addAlert(store);
  const token = store.createSession('usr_route').token;
  const page = alertHistory(token, { state: 'all' }, { store });
  assert.ok(page.includes('<!DOCTYPE html>'));
  assert.ok(page.includes('Route Test LP'));
  assert.ok(page.includes('$29.99'));
});

test('alertHistory: a bogus token is a 401, never a page', () => {
  const store = createStore();
  fixtureUser(store);
  assert.throws(
    () => alertHistory('nope-not-a-token', { state: 'all' }, { store }),
    (err) => err instanceof ApiError && err.status === 401 && err.code === 'unauthorized',
  );
});

test('alertHistory: history is scoped to the session user', () => {
  const store = createStore();
  fixtureUser(store);
  addAlert(store);
  store.users.insert({
    id: 'usr_other', email: 'other@example.com', handle: 'other',
    display_name: 'Other', avatar_url: null, plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: BASE,
  });
  const otherToken = store.createSession('usr_other').token;
  const page = alertHistory(otherToken, { state: 'all' }, { store });
  assert.ok(!page.includes('Route Test LP'));
  assert.ok(page.includes('nothing here yet'));
});

/* ------------------------------------------------------------------ *
 * The route adapter — GET /api/alerts/history?state=
 * ------------------------------------------------------------------ */

const SEEDED = (() => {
  const { token, user } = login({ test: true });
  const artist = defaultStore.artists.insert({
    id: 'art_seeded_route', name: 'Seeded Route Artist', discogs_artist_id: null,
    image_url: null, genres: [], created_at: BASE,
  });
  const release = defaultStore.releases.insert({
    id: 'rel_seeded_route', cat: 'WAX-SR1', artist_id: artist.id,
    title: 'Seeded Route History LP', year: 2026, label: 'Wax', label_cat: null,
    format: 'LP', variant: null, pressing_qty: null, cover_url: null,
    ink: 'ink', discogs_release_id: null, released_at: null, created_at: BASE,
  });
  // A dispatched alert: detected, sent, and sitting in history.
  defaultStore.alerts.insert({
    id: 'alr_seeded_dispatched', user_id: user.id, release_id: release.id,
    watch_id: null, kind: 'drop', state: 'live', detected_at: BASE,
    dispatched_at: BASE, read_at: null, channels: ['email'],
    listing_url: 'https://vinyl-den.example/seeded', price_cents: 4200,
    created_at: BASE,
  });
  defaultStore.alerts.insert({
    id: 'alr_seeded_caught', user_id: user.id, release_id: release.id,
    watch_id: null, kind: 'restock', state: 'caught', detected_at: BASE,
    dispatched_at: BASE, read_at: BASE, channels: ['email'],
    listing_url: 'https://vinyl-den.example/seeded', price_cents: 4200,
    created_at: BASE,
  });
  return { token, userId: user.id };
})();

test('route: GET renders history as text/html with the dispatched alert on it', async () => {
  const req = fakeReq({ token: SEEDED.token });
  const res = fakeRes();
  await route(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(res.body.includes('<!DOCTYPE html>'));
  assert.ok(res.body.includes('Seeded Route History LP'));
  assert.ok(res.body.includes('$42.00'));
});

test('route: ?state= filters rows the same way the renderer does', async () => {
  const req = fakeReq({ token: SEEDED.token, query: { state: 'caught' } });
  const res = fakeRes();
  await route(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('[caught]'));
  assert.ok(!res.body.includes('[live]'));
});

test('route: no token is a 401 JSON error, not a page', async () => {
  const req = fakeReq();
  const res = fakeRes();
  await route(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unauthorized',
    message: 'Sign in to do that.',
  });
});

test('route: unsupported methods get a 405 naming GET', async () => {
  const req = { ...fakeReq({ token: SEEDED.token }), method: 'POST' };
  const res = fakeRes();
  await route(req, res);
  assert.equal(res.statusCode, 405);
  assert.ok(JSON.parse(res.body).message.includes('GET'));
});
