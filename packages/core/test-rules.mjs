/**
 * Smoke/regression check for `packages/core/src/rules.js` — the alert rule
 * engine (ALERT-ENGINE-PLAN.md §4 item 4, the build-order item after dispatch).
 *
 * Run: `node --test packages/core/test-rules.mjs`
 * No dependencies beyond the Node standard library. These tests pin the
 * four properties the engine exists for:
 *
 * 1. Rules match the right releases and not others (artist/alias, title and
 *    label matchers, target-price condition).
 * 2. Dedupe holds: the same release routed twice in one pass, or re-seen
 *    after it already went out, never produces two sends.
 * 3. Quiet hours suppress: alerts inside the window defer to the digest,
 *    and the digest flushes when the window ends.
 * 4. Digest batching: deferred alerts fold into one digest message with
 *    artist, title, price and source link intact.
 *
 * If any of them fail, the contract between the scan worker and dispatch
 * changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  normText,
  alertDedupeKey,
  parseQuietBound,
  isQuietHour,
  evaluateWatchRule,
  alreadyAlerted,
  routeAlert,
  routeAlerts,
  shouldFlushDigest,
  buildDigestBatch,
  ROUTE,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const DOOM = { name: 'MF DOOM', aliases: ['Doom', 'Viktor Vaughn'] };

function doomRule(overrides = {}) {
  return {
    id: 'wch_doom',
    user_id: 'usr_night',
    artist_id: 'art_doom',
    artist: DOOM,
    title_contains: null,
    label_contains: null,
    target_price_cents: null,
    channels: ['email'],
    ...overrides,
  };
}

function product(overrides = {}) {
  return {
    identity_key: 'mf doom — mm food',
    title: 'MM..FOOD',
    artist: 'MF DOOM',
    url: 'https://shop.example/mm-food',
    image: null,
    price_cents: 3499,
    currency: 'USD',
    label: null,
    method: 'platform-api',
    ...overrides,
  };
}

const NIGHT_USER = {
  id: 'usr_night',
  email: 'night@example.com',
  handle: 'night',
  display_name: 'Night',
  plan: 'free',
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  phone_verified: false,
  email_verified: true,
};

/** A fixed clock: 2026-09-09 12:00 UTC — midday, never quiet. */
const NOON = Date.UTC(2026, 8, 9, 12, 0, 0);
/** 2026-09-09 03:00 UTC — deep inside the 22:00–07:00 quiet window. */
const NIGHT = Date.UTC(2026, 8, 9, 3, 0, 0);

function emptyStore() {
  const store = createStore();
  for (const coll of ['users', 'artists', 'watches', 'alerts', 'sources', 'scanLogs', 'scanSnapshots']) {
    for (const row of store[coll].all()) store[coll].remove((r) => r.id === row.id);
  }
  return store;
}

function baseItem(overrides = {}) {
  return {
    user_id: 'usr_night',
    artist_name: 'MF DOOM',
    title: 'MM..FOOD',
    price_cents: 3499,
    currency: 'USD',
    listing_url: 'https://shop.example/mm-food',
    source_label: 'Example Shop',
    kind: 'drop',
    ...overrides,
  };
}

const routeArgs = (overrides = {}) => ({
  store: emptyStore(),
  user: { ...NIGHT_USER, quiet_hours_start: null, quiet_hours_end: null },
  channel: 'email',
  plan: 'free',
  sentThisWindow: [],
  nowMs: NOON,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Rule evaluation
 * ------------------------------------------------------------------ */

test('evaluateWatchRule: matches by artist name and by alias', () => {
  const rule = doomRule();
  assert.equal(evaluateWatchRule({ product: product(), rule }).match, true);
  assert.equal(evaluateWatchRule({ product: product({ artist: 'Viktor Vaughn' }), rule }).match, true);
  assert.equal(evaluateWatchRule({ product: product({ artist: 'Madlib' }), rule }).match, false);
});

test('evaluateWatchRule: title_contains narrows the rule', () => {
  const rule = doomRule({ title_contains: 'test press' });
  assert.equal(evaluateWatchRule({ product: product({ title: 'MM..FOOD Test Pressing' }), rule }).match, true);
  const no = evaluateWatchRule({ product: product({ title: 'MM..FOOD' }), rule });
  assert.equal(no.match, false);
  assert.ok(no.reasons.some((r) => r.includes('title lacks')));
});

test('evaluateWatchRule: label_contains needs a label to satisfy', () => {
  const rule = doomRule({ label_contains: 'stones throw' });
  assert.equal(
    evaluateWatchRule({ product: product({ label: 'Stones Throw Records' }), rule }).match,
    true,
  );
  const unlabeled = evaluateWatchRule({ product: product({ label: null }), rule });
  assert.equal(unlabeled.match, false);
  assert.ok(unlabeled.reasons.some((r) => r.includes('no label')));
  assert.equal(
    evaluateWatchRule({ product: product({ label: 'Rhymesayers' }), rule }).match,
    false,
  );
});

test('evaluateWatchRule: target_price_cents fires at/under target, unknown price still alerts', () => {
  const rule = doomRule({ target_price_cents: 20000 });
  assert.equal(evaluateWatchRule({ product: product({ price_cents: 19999 }), rule }).match, true);
  assert.equal(evaluateWatchRule({ product: product({ price_cents: 20000 }), rule }).match, true);
  const over = evaluateWatchRule({ product: product({ price_cents: 20001 }), rule });
  assert.equal(over.match, false);
  assert.ok(over.reasons.some((r) => r.includes('above target')));
  assert.equal(evaluateWatchRule({ product: product({ price_cents: null }), rule }).match, true);
});

test('evaluateWatchRule: malformed input is a no-match, never a throw', () => {
  assert.equal(evaluateWatchRule({ product: null, rule: doomRule() }).match, false);
  assert.equal(evaluateWatchRule({ product: product(), rule: null }).match, false);
  assert.equal(evaluateWatchRule({ product: product(), rule: { ...doomRule(), artist: null } }).match, false);
});

/* ------------------------------------------------------------------ *
 * Dedupe
 * ------------------------------------------------------------------ */

test('alertDedupeKey: same release, different casing/punctuation — one key', () => {
  const a = alertDedupeKey({ user_id: 'usr_night', artist_name: 'MF DOOM', title: 'MM..FOOD' });
  const b = alertDedupeKey({ user_id: 'usr_night', artist_name: 'mf  doom!', title: 'mm food' });
  const c = alertDedupeKey({ user_id: 'usr_night', artist_name: 'MF DOOM', title: 'Operation: Doomsday' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes('  '), 'no raw whitespace leaks into the key');
  assert.equal(normText('  MF—DOOM!! '), 'mf doom');
});

test('alreadyAlerted: a dispatched row blocks re-alert; a failed row does not', () => {
  const store = emptyStore();
  const key = alertDedupeKey({ user_id: 'usr_night', artist_name: 'MF DOOM', title: 'MM..FOOD' });
  assert.equal(alreadyAlerted(store, key), false);
  store.alerts.insert({
    id: 'alr_sent',
    user_id: 'usr_night',
    artist_name: 'MF DOOM',
    title: 'MM..FOOD',
    dispatched_at: new Date(NOON).toISOString(),
    channels: ['email'],
  });
  assert.equal(alreadyAlerted(store, key), true);
  const failedKey = alertDedupeKey({ user_id: 'usr_night', artist_name: 'Madlib', title: 'Shades of Blue' });
  store.alerts.insert({
    id: 'alr_failed',
    user_id: 'usr_night',
    artist_name: 'Madlib',
    title: 'Shades of Blue',
    dispatched_at: new Date(NOON).toISOString(),
    channels: [],
  });
  assert.equal(alreadyAlerted(store, failedKey), false, 'failed sends may retry');
});

test('routeAlerts: same release twice in one pass routes once, drops the twin', () => {
  const item = baseItem();
  const rule = doomRule();
  const { sendNow, digest, dropped } = routeAlerts({
    ...routeArgs(),
    items: [item, { ...item }],
    rules: [rule, rule],
  });
  assert.equal(sendNow.length, 1);
  assert.equal(digest.length, 0);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].reasons.some((r) => r.includes('duplicate in batch')));
});

test('routeAlert: already-dispatched release is dropped, not re-sent', () => {
  const store = emptyStore();
  store.alerts.insert({
    id: 'alr_old',
    user_id: 'usr_night',
    artist_name: 'MF DOOM',
    title: 'MM..FOOD',
    dispatched_at: new Date(NOON - 1000).toISOString(),
    channels: ['email'],
  });
  const { route, reasons } = routeAlert({ ...routeArgs({ store }), item: baseItem(), rule: doomRule() });
  assert.equal(route, ROUTE.DROP);
  assert.ok(reasons.some((r) => r.includes('dedupe')));
});

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

test('parseQuietBound: HH:MM to minutes, garbage to null', () => {
  assert.equal(parseQuietBound('22:00'), 1320);
  assert.equal(parseQuietBound('7:05'), 425);
  assert.equal(parseQuietBound(null), null);
  assert.equal(parseQuietBound('25:00'), null);
  assert.equal(parseQuietBound('nope'), null);
});

test('isQuietHour: inside, outside, and overnight wrap', () => {
  const q = { quiet_start: '22:00', quiet_end: '07:00' };
  assert.equal(isQuietHour({ ...q, nowMs: NIGHT }), true);
  assert.equal(isQuietHour({ ...q, nowMs: NOON }), false);
  // Boundary: start inclusive, end exclusive.
  assert.equal(isQuietHour({ ...q, nowMs: Date.UTC(2026, 8, 9, 22, 0) }), true);
  assert.equal(isQuietHour({ ...q, nowMs: Date.UTC(2026, 8, 9, 7, 0) }), false);
  // Non-wrapping window.
  assert.equal(isQuietHour({ quiet_start: '13:00', quiet_end: '14:00', nowMs: NOON }), false);
  assert.equal(isQuietHour({ quiet_start: '11:00', quiet_end: '13:00', nowMs: NOON }), true);
  // Missing or degenerate config disables quiet hours.
  assert.equal(isQuietHour({ quiet_start: null, quiet_end: '07:00', nowMs: NIGHT }), false);
  assert.equal(isQuietHour({ quiet_start: '22:00', quiet_end: '22:00', nowMs: NIGHT }), false);
});

test('routeAlert: quiet hours defer to the digest, never send', () => {
  const { route, reasons } = routeAlert({
    ...routeArgs({ user: NIGHT_USER, nowMs: NIGHT }),
    item: baseItem(),
    rule: doomRule(),
  });
  assert.equal(route, ROUTE.DEFER_DIGEST);
  assert.ok(reasons.some((r) => r.includes('quiet hours')));
});

test('routeAlert: outside quiet hours the gate decides — ok means send now', () => {
  const { route } = routeAlert({
    ...routeArgs({ user: NIGHT_USER, nowMs: NOON }),
    item: baseItem(),
    rule: doomRule(),
  });
  assert.equal(route, ROUTE.SEND_NOW);
});

test('routeAlert: rate cap folds into the digest, it never drops or sends #41', () => {
  const sentThisWindow = Array.from({ length: 60 }, (_, i) => ({
    channel: 'email',
    sent_at: new Date(NOON - i * 1000).toISOString(),
  }));
  const { route, reasons } = routeAlert({
    ...routeArgs({ sentThisWindow }),
    item: baseItem(),
    rule: doomRule(),
  });
  assert.equal(route, ROUTE.DEFER_DIGEST);
  assert.ok(reasons.some((r) => r.includes('rate cap')));
});

test('routeAlert: free-tier SMS is digest-folded, series SMS sends', () => {
  const smsItem = { ...baseItem(), channel: undefined };
  const free = routeAlert({ ...routeArgs({ channel: 'sms', plan: 'free' }), item: smsItem, rule: doomRule() });
  assert.equal(free.route, ROUTE.DEFER_DIGEST);
  const series = routeAlert({
    ...routeArgs({ channel: 'sms', plan: 'series', user: { ...NIGHT_USER, phone_verified: true } }),
    item: smsItem,
    rule: doomRule(),
  });
  assert.equal(series.route, ROUTE.SEND_NOW);
});

test('shouldFlushDigest: held during quiet hours, released after', () => {
  assert.equal(shouldFlushDigest({ user: NIGHT_USER, nowMs: NIGHT }), false);
  assert.equal(shouldFlushDigest({ user: NIGHT_USER, nowMs: NOON }), true);
  assert.equal(shouldFlushDigest({ user: { ...NIGHT_USER, quiet_hours_start: null }, nowMs: NIGHT }), true);
});

/* ------------------------------------------------------------------ *
 * Digest batching
 * ------------------------------------------------------------------ */

test('buildDigestBatch: one digest carries every deferred alert', () => {
  const digest = buildDigestBatch({
    items: [
      { item: baseItem(), reasons: [] },
      {
        item: baseItem({ artist_name: 'Madlib', title: 'Shades of Blue', price_cents: 2799, listing_url: 'https://shop.example/sob', source_label: 'Example Shop' }),
        reasons: [],
      },
    ],
    windowLabel: 'overnight',
  });
  assert.equal(digest.count, 2);
  assert.ok(digest.subject.includes('2 alerts'));
  assert.ok(digest.subject.includes('overnight'));
  assert.ok(digest.text.includes('MF DOOM'));
  assert.ok(digest.text.includes('MM..FOOD'));
  assert.ok(digest.text.includes('$34.99'));
  assert.ok(digest.text.includes('Madlib'));
  assert.ok(digest.text.includes('https://shop.example/mm-food'));
});

test('routeAlerts end to end: send-now, defer-digest, drop in one pass', () => {
  const store = emptyStore();
  const quietUser = { ...NIGHT_USER };
  const rules = [doomRule(), doomRule({ title_contains: 'test press' }), doomRule()];
  const items = [
    baseItem(), // matches, quiet → digest
    baseItem({ title: 'MM..FOOD Instrumentals' }), // title rule misses → drop
    { ...baseItem(), title: 'Operation: Doomsday' }, // matches, quiet → digest
  ];
  const { sendNow, digest, dropped } = routeAlerts({
    store,
    user: quietUser,
    channel: 'email',
    plan: 'free',
    sentThisWindow: [],
    nowMs: NIGHT,
    items,
    rules,
  });
  assert.equal(sendNow.length, 0, 'nothing sends at 3am');
  assert.equal(digest.length, 2);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].reasons.some((r) => r.includes('title lacks')));
});
