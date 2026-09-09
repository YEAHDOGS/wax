/**
 * Regression pin for the Postgres swap (ALERT-ENGINE-PLAN.md §4): the HTTP/API
 * layer await-pass.
 *
 * Every handler in `handlers.js`, `subscriptions.js`, `tracking.js` and
 * `billing.js`, the HTML renderers, the serverless route surface, the app's
 * local client, and `bin/wax` are now async and await every store call — the
 * in-memory store resolves synchronously, `createPostgresStore` resolves
 * promises. A single dropped `await` in this layer would leave a Promise
 * object where a row belongs, silently, in production.
 *
 * `asAsyncStore` wraps the in-memory store so every collection method returns
 * a genuine Promise (the same shape the Postgres store produces). These tests
 * run a scripted end-to-end API scenario through it and deep-compare the
 * outcome against the sync store: any behavioural drift — a missed await
 * leaking a Promise into a response, a reorder, a dropped write — fails the
 * comparison. That is the gap this file exists to catch before Postgres does
 * it in production.
 *
 * The shim is deliberately duplicated from `test-async-store-pipeline.mjs`
 * rather than shared: each test file must stand alone, runnable by itself,
 * with no cross-file imports to rot.
 *
 * Run: `node --test packages/core/test-async-api-surface.mjs`
 * Zero dependencies beyond the Node standard library. No network, no live
 * database — the "Postgres" here is the in-memory store wearing a
 * promise-shaped mask, which is precisely the contract the swap needs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore,
  login,
  logout,
  getSession,
  listReleases,
  getRelease,
  listTracks,
  setTrackDuration,
  listAlerts,
  alertCounts,
  markAlertRead,
  catchAlert,
  listCrate,
  listWatches,
  addWatch,
  removeWatch,
  getProfile,
  updateProfile,
  recordPlay,
  bootstrap,
  alertHistory,
  alertDetail,
  renderAlertHistory,
  renderAlertDetail,
  renderDashboard,
  subscribeAlertChannel,
  confirmAlertSubscription,
  unsubscribeAlertChannel,
  addSource,
  updateSource,
  removeSource,
  listSources,
  startTrial,
  expireTrials,
  activateSeries,
  checkoutSession,
} from './src/index.js';

/**
 * Wrap an in-memory store so every collection method returns a real Promise —
 * the same shape `createPostgresStore` produces. Asyncness must not change
 * behaviour, so awaiting the shim must equal calling the raw store.
 */
function asAsyncStore(store) {
  const wrapCollection = (coll) => ({
    all: async () => coll.all(),
    find: async (pred) => coll.find(pred),
    filter: async (pred) => coll.filter(pred),
    insert: async (row) => coll.insert(row),
    update: async (pred, patch) => coll.update(pred, patch),
    remove: async (pred) => coll.remove(pred),
    count: async () => coll.count(),
  });
  const out = {};
  for (const key of Object.keys(store)) {
    const v = store[key];
    out[key] = v && typeof v.all === 'function' ? wrapCollection(v) : v;
  }
  out.createSession = async (userId) => store.createSession(userId);
  out.userForToken = async (token) => store.userForToken(token);
  out.endSession = async (token) => store.endSession(token);
  out.latestPrice = async (releaseId) => store.latestPrice(releaseId);
  return out;
}

const BASE = '2026-09-09T10:00:00.000Z';

/** Deterministic fixture data — explicit ids, no randomness, no clock. */
function makeApiData() {
  return {
    users: [{
      id: 'usr_api', email: 'api@example.com', handle: 'apitester',
      display_name: 'API Tester', avatar_url: null, plan: 'free',
      trial_ends_at: null, phone: null, phone_verified: false,
      email_verified: true, created_at: BASE,
    }],
    profiles: [{
      user_id: 'usr_api', bio: '', location: '', ink: 'vermilion',
      genres: [], crate_public: true, created_at: BASE, updated_at: BASE,
    }],
    artists: [{
      id: 'art_api', name: 'Test Pressing', discogs_artist_id: null,
      image_url: null, genres: ['techno'], created_at: BASE,
    }],
    releases: [{
      id: 'rel_api', cat: 'WAX-API1', artist_id: 'art_api',
      title: 'API Test Pressing', year: 2026, label: 'Wax', label_cat: null,
      format: 'LP', variant: null, pressing_qty: 500, cover_url: null,
      ink: 'ink', discogs_release_id: null, released_at: BASE, created_at: BASE,
    }],
    tracks: [{
      id: 'trk_api', release_id: 'rel_api', title: 'Side A', position: 1,
      audio_url: 'https://data.wearedogs.net/a.mp3', duration_sec: null,
    }],
    alerts: [{
      id: 'alr_api', user_id: 'usr_api', release_id: 'rel_api',
      watch_id: null, kind: 'drop', state: 'live', detected_at: BASE,
      dispatched_at: null, read_at: null, channels: ['email'],
      listing_url: 'https://shop.example/api-test', price_cents: 3400,
      created_at: BASE,
    }],
    sources: [],
    watches: [],
    wantlistItems: [],
    crateItems: [],
    activity: [],
    follows: [],
    subscriptions: [],
    subscribeAttempts: [],
    pricePoints: [],
    scanSnapshots: [],
    sessions: [],
    scanLogs: [],
    engineStates: [],
    digestQueue: [],
    prices: [],
  };
}

const FEED_HTML = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body></body></html>`;

/**
 * A scripted end-to-end API scenario, through the public handlers only —
 * auth, catalog, watches, alert board, history renderers, subscriptions,
 * tracking, billing, dashboard, bootstrap, sign-out. Returns a normalized
 * summary with every nondeterministic value (random ids, tokens,
 * wall-clock timestamps) projected out, so sync and async stores must
 * agree exactly.
 */
async function runApiScenario(store) {
  const out = {};

  // --- auth ---
  const session = await login({ email: 'api@example.com', password: 'wax' }, { store });
  out.loginUser = session.user.id;
  const token = session.token;
  out.requireUser = (await getSession(token, { store })).user.id;

  // --- catalog ---
  out.releases = (await listReleases({}, { store })).map((r) => r.id);
  out.releaseTitle = (await getRelease('rel_api', { store })).title;
  out.releaseArtist = (await getRelease('WAX-API1', { store })).artist.name;
  out.tracks = (await listTracks({}, { store })).map((t) => t.id);
  out.duration = (await setTrackDuration('trk_api', 184, { store })).duration_sec;

  // --- watches ---
  const watch = await addWatch(token, { artist_id: 'art_api' }, { store });
  out.watchId = watch.artist_id;
  out.watchDup = (await addWatch(token, { artist_id: 'art_api' }, { store })).id === watch.id;
  out.watches = (await listWatches(token, { store })).length;
  out.watchArtist = (await listWatches(token, { store }))[0].artist.name;
  out.watchCountAfterRemove = (await removeWatch(token, watch.id, { store })).removed;

  // --- alert board ---
  out.alerts = (await listAlerts(token, {}, { store })).map((a) => a.id);
  const row0 = (await listAlerts(token, {}, { store }))[0];
  out.alertRow = { state: row0.state, inCrate: row0.inCrate, priceCents: row0.price_cents };
  const counts = await alertCounts(token, { store });
  out.counts = { all: counts.all, live: counts.live, unread: counts.unread };
  out.readMarked = (await markAlertRead(token, 'alr_api', { store })).read_at !== null;
  const caught = await catchAlert(token, 'alr_api', {}, { store });
  out.caught = { state: caught.alert.state, crateRelease: caught.crate_item.release_id };
  out.crate = (await listCrate(token, { store })).map((c) => c.release_id);

  // --- history renderers ---
  const historyHtml = await alertHistory(token, { state: 'all' }, { store });
  out.historyRenders = historyHtml.includes('API Test Pressing') && historyHtml.startsWith('<!DOCTYPE html>');
  out.historyDetail = (await alertDetail(token, 'alr_api', { store })).includes('Test Pressing');
  out.rendererRenders =
    (await renderAlertHistory(store, 'usr_api')).includes('API Test Pressing') &&
    (await renderAlertDetail(store, caught.alert)).includes('API Test Pressing');

  // --- subscriptions (no delivery channel: keys pending, never throws) ---
  const sub = await subscribeAlertChannel({ email: 'api@example.com', channel: 'email' }, { store });
  out.subState = sub.subscription.state;
  out.subDelivered = sub.delivered;
  out.confirmState = (await confirmAlertSubscription(sub.confirm_token, { store })).state;
  out.unsub = (await unsubscribeAlertChannel({ token: sub.confirm_token }, { store })).unsubscribed;

  // --- tracking ---
  const src = await addSource(token, { url: 'https://shop.example/new', html: FEED_HTML }, { store });
  out.sourceScannable = src.scannable;
  out.sources = (await listSources(token, { store })).map((s) => s.url);
  out.sourcePaused = (await updateSource(token, src.id, { paused: true }, { store })).paused;
  out.sourceRemoved = (await removeSource(token, src.id, { store })).removed;

  // --- billing ---
  out.trial = (await startTrial(token, { store })).plan;
  out.checkoutPlan = (await checkoutSession(token, { store })).plan;
  out.series = (await activateSeries(token, 'sub_stub_1', { store })).plan;
  out.expired = await expireTrials({ store });

  // --- dashboard + profile + play + bootstrap ---
  out.dashboardRenders = (await renderDashboard(store, 'usr_api')).includes('WAX — watchlist status');
  out.profileStats = (await getProfile(token, undefined, { store })).stats.crate_count;
  out.profileGenres = (await getProfile(token, undefined, { store })).stats.top_genres;
  out.updatedBio = (await updateProfile(token, { bio: 'hello' }, { store })).bio;
  out.play = (await recordPlay(token, 'trk_api', { store })).ok;
  const boot = await bootstrap(token, {}, { store });
  out.bootstrapKeys = Object.keys(boot).sort();

  // --- sign out ---
  out.logout = (await logout(token, { store })).ok;
  out.sessionAfterLogout = await getSession(token, { store }).then(
    () => 'still-valid',
    (err) => err.code,
  );

  return out;
}

test('asAsyncStore: every collection method returns a genuine Promise', async () => {
  const shim = asAsyncStore(createStore());
  for (const key of Object.keys(shim)) {
    const v = shim[key];
    if (v && typeof v.all === 'function') {
      for (const m of ['all', 'find', 'filter', 'insert', 'update', 'remove', 'count']) {
        const r = m === 'update' || m === 'remove' ? v[m](() => false) : v[m](m === 'find' || m === 'filter' ? () => true : undefined);
        assert.ok(r instanceof Promise, `${key}.${m} must return a Promise`);
        await r;
      }
    }
  }
  for (const m of ['createSession', 'userForToken', 'endSession', 'latestPrice']) {
    const p = shim[m]('x');
    assert.ok(p instanceof Promise, `${m} must return a Promise`);
    await p.catch(() => {});
  }
});

test('full API surface behaves identically on sync and async stores', async () => {
  const syncOutcome = await runApiScenario(createStore(makeApiData()));
  const asyncOutcome = await runApiScenario(asAsyncStore(createStore(makeApiData())));
  assert.deepEqual(asyncOutcome, syncOutcome);
});

test('async-store scenario: the interesting values are what they should be', async () => {
  const o = await runApiScenario(asAsyncStore(createStore(makeApiData())));
  assert.equal(o.loginUser, 'usr_api');
  assert.deepEqual(o.releases, ['rel_api']);
  assert.equal(o.releaseTitle, 'API Test Pressing');
  assert.equal(o.releaseArtist, 'Test Pressing');
  assert.equal(o.duration, 184);
  assert.ok(o.watchDup, 'duplicate addWatch is idempotent');
  assert.equal(o.watchCountAfterRemove, 1);
  assert.deepEqual(o.alerts, ['alr_api']);
  assert.equal(o.counts.live, 1);
  assert.equal(o.counts.unread, 1);
  assert.ok(o.readMarked);
  assert.equal(o.caught.state, 'caught');
  assert.deepEqual(o.crate, ['rel_api']);
  assert.ok(o.historyRenders && o.historyDetail && o.rendererRenders);
  assert.equal(o.subState, 'pending');
  assert.equal(o.subDelivered, false, 'keyless confirmation is never delivered');
  assert.equal(o.confirmState, 'active');
  assert.equal(o.unsub, 1);
  assert.equal(o.sourceScannable, true);
  assert.equal(o.sourcePaused, true);
  assert.equal(o.sourceRemoved, 1);
  assert.equal(o.trial, 'trial');
  assert.equal(o.series, 'series');
  assert.equal(o.checkoutPlan, 'series');
  assert.equal(o.expired, 0, 'nobody is expired');
  assert.ok(o.dashboardRenders);
  assert.equal(o.profileStats, 1);
  assert.deepEqual(o.profileGenres, ['techno']);
  assert.equal(o.updatedBio, 'hello');
  assert.equal(o.play, true);
  assert.ok(o.bootstrapKeys.includes('profile_view'));
  assert.equal(o.logout, true);
  assert.equal(o.sessionAfterLogout, 'unauthorized');
});

test('free-tier gates hold on the async store', async () => {
  const store = asAsyncStore(createStore(makeApiData()));
  await store.users.update((u) => u.id === 'usr_api', { plan: 'free' });
  const { token } = await login({ email: 'api@example.com', password: 'wax' }, { store });
  // Three watches already standing (distinct artists — same-artist re-adds
  // are idempotent duplicates and never touch the cap): the 4th is 402.
  for (const aid of ['art_x2', 'art_x3', 'art_x4']) {
    await store.artists.insert({ id: aid, name: `Artist ${aid}`, created_at: BASE });
  }
  await store.watches.insert({ id: 'w1', user_id: 'usr_api', artist_id: 'art_api', created_at: BASE });
  await store.watches.insert({ id: 'w2', user_id: 'usr_api', artist_id: 'art_x2', created_at: BASE });
  await store.watches.insert({ id: 'w3', user_id: 'usr_api', artist_id: 'art_x3', created_at: BASE });
  await assert.rejects(
    () => addWatch(token, { artist_id: 'art_x4' }, { store }),
    (e) => e.status === 402 && e.code === 'watch_limit',
    '4th watch on free tier is 402 watch_limit on the async store',
  );
  await store.sources.insert({ id: 's1', user_id: 'usr_api', url: 'https://a.example/', created_at: BASE });
  await store.sources.insert({ id: 's2', user_id: 'usr_api', url: 'https://b.example/', created_at: BASE });
  await store.sources.insert({ id: 's3', user_id: 'usr_api', url: 'https://c.example/', created_at: BASE });
  await assert.rejects(
    () => addSource(token, { url: 'https://d.example/' }, { store }),
    (e) => e.status === 402 && e.code === 'source_limit',
    '4th source on free tier is 402 source_limit on the async store',
  );
});

test('no scenario output leaks a Promise — every await landed', async () => {
  const o = await runApiScenario(asAsyncStore(createStore(makeApiData())));
  const leaks = [];
  const walk = (v, path) => {
    if (v && typeof v.then === 'function') {
      leaks.push(path);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
    }
  };
  walk(o, 'outcome');
  assert.deepEqual(leaks, [], `a missed await would surface a Promise here: ${leaks.join(', ')}`);
});
