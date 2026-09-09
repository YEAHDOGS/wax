/**
 * Smoke/regression check for `packages/core/src/notify.js`.
 *
 * Run: `node --test packages/core/test-notify.mjs`
 * No dependencies beyond the Node standard library. Fixtures are plain
 * alert/release shapes — there is no provider SDK here, no live sending,
 * ever. The contract under test: alert content carries artist, title, price,
 * source link and buy link; SMS fits one segment; the rate cap defers (never
 * drops) flood traffic; free tier never sends SMS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrice,
  formatDropEmail,
  formatDropSms,
  formatDigest,
  shouldDispatch,
  SMS_PER_HOUR_CAP,
  EMAIL_PER_HOUR_CAP,
} from './src/index.js';

const ALERT = {
  id: 'alr_1', user_id: 'usr_x', release_id: 'rel_1', watch_id: 'wch_1',
  kind: 'drop', state: 'live',
  detected_at: '2026-09-09T10:00:00.000Z', dispatched_at: null, read_at: null,
  channels: ['email', 'sms'],
  listing_url: 'https://vinyl-den.example/products/mingus-ah-um',
  price_cents: 3499,
  created_at: '2026-09-09T10:00:00.000Z',
};

const ITEM = {
  alert: ALERT,
  artistName: 'Charles Mingus',
  releaseTitle: 'Mingus Ah Um — 180g Vinyl LP',
  variant: 'splatter',
  sourceLabel: 'Vinyl Den',
};

test('formatPrice renders cents and survives missing prices', () => {
  assert.equal(formatPrice(3499), '$34.99');
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(formatPrice(null), '—');
  assert.equal(formatPrice(undefined), '—');
});

test('email carries artist, title, price, source, and the buy link', () => {
  const { subject, text } = formatDropEmail(ITEM);
  assert.ok(subject.includes('Charles Mingus'));
  assert.ok(subject.includes('$34.99'));
  assert.ok(text.includes('Mingus Ah Um'));
  assert.ok(text.includes('(splatter)'));
  assert.ok(text.includes('Vinyl Den'));
  assert.ok(text.includes('https://vinyl-den.example/products/mingus-ah-um'));
  assert.ok(text.includes('STOP'));
});

test('email tolerates unknown prices and missing links', () => {
  const { subject, text } = formatDropEmail({
    alert: { ...ALERT, price_cents: null, listing_url: null },
    artistName: 'Miles Davis',
    releaseTitle: 'Kind of Blue',
  });
  assert.ok(subject.includes('—'));
  assert.ok(text.includes('https://wax.wearedogs.net/alerts'));
});

test('SMS fits in one 160-char segment and names the drop', () => {
  const sms = formatDropSms(ITEM);
  assert.ok(sms.length <= 160, `got ${sms.length} chars`);
  assert.ok(sms.startsWith('Wax: '));
  assert.ok(sms.includes('Charles Mingus'));
  assert.ok(sms.includes('$34.99'));
});

test('a very long title is truncated, never split mid-send', () => {
  const sms = formatDropSms({
    alert: ALERT,
    artistName: 'A'.repeat(60),
    releaseTitle: 'B'.repeat(80),
  });
  assert.ok(sms.length <= 160);
  assert.ok(sms.endsWith('…'));
});

test('digest folds N alerts into one message', () => {
  const { subject, text } = formatDigest({
    windowLabel: 'the last hour',
    items: [ITEM, { ...ITEM, alert: { ...ALERT, kind: 'restock', price_cents: 2999 } }],
  });
  assert.ok(subject.includes('2 alerts'));
  assert.ok(text.includes('New drop'));
  assert.ok(text.includes('Back in stock'));
  assert.ok(text.includes('$29.99'));
});

test('rate cap defers the 41st text instead of dropping it', () => {
  const now = Date.now();
  const sentThisWindow = Array.from({ length: SMS_PER_HOUR_CAP }, (_, i) => ({
    channel: 'sms',
    sent_at: new Date(now - i * 60_000).toISOString(),
  }));
  const verdict = shouldDispatch({ channel: 'sms', plan: 'series', sentThisWindow, now });
  assert.equal(verdict.dispatch, false);
  assert.ok(verdict.reason.includes('rate cap hit'));
  assert.ok(verdict.reason.includes('digest'));
});

test('one under the cap still dispatches', () => {
  const now = Date.now();
  const sentThisWindow = Array.from({ length: SMS_PER_HOUR_CAP - 1 }, (_, i) => ({
    channel: 'sms',
    sent_at: new Date(now - i * 60_000).toISOString(),
  }));
  assert.equal(shouldDispatch({ channel: 'sms', plan: 'series', sentThisWindow, now }).dispatch, true);
});

test('free tier never sends SMS, even with zero sent this hour', () => {
  const verdict = shouldDispatch({ channel: 'sms', plan: 'free', sentThisWindow: [] });
  assert.equal(verdict.dispatch, false);
  assert.ok(verdict.reason.includes('$10/mo'));
});

test('stale sends outside the window do not count against the cap', () => {
  const now = Date.now();
  const sentThisWindow = Array.from({ length: EMAIL_PER_HOUR_CAP + 5 }, () => ({
    channel: 'email',
    sent_at: new Date(now - 2 * 3600_000).toISOString(),
  }));
  assert.equal(shouldDispatch({ channel: 'email', plan: 'free', sentThisWindow, now }).dispatch, true);
});
