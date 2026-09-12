/**
 * Regression tests for the evaluator and its anti-noise gate.
 * Deterministic: time is injected, memory is passed in and out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  blankMemory,
  MAX_DISPATCHES_PER_DAY,
  makeListing,
  makePressing,
  makeSnapshot,
  makeRule,
} from '../src/index.js';

const T0 = '2026-09-10T12:00:00.000Z';
const plusHours = (iso, h) => new Date(Date.parse(iso) + h * 3600 * 1000).toISOString();

const dropRule = (over = {}) =>
  makeRule({ id: 'wtc_drop', scope_type: 'release', scope_id: 'rel_a', cooldown_hours: 24, ...over });
const priceRule = (over = {}) =>
  makeRule({
    id: 'wtc_price',
    scope_type: 'release',
    scope_id: 'rel_a',
    target_price_cents: 4000,
    cooldown_hours: 24,
    ...over,
  });

describe('evaluate', () => {
  it('runs every matcher and returns priority-sorted alerts', () => {
    const pressing = makePressing({ id: 'p1', release_id: 'rel_a', title: 'new one' });
    const listing = makeListing({ id: 'l1', release_id: 'rel_a', price_cents: 3000 });
    const prev = makeSnapshot();
    const next = makeSnapshot({ pressings: [pressing], listings: [listing] });
    const { alerts } = evaluate([dropRule(), priceRule()], prev, next, { now: T0 });
    // Both rules watch the same release, so both see the new pressing;
    // only the price rule sees the under-target listing. Drops sort first.
    assert.deepEqual(alerts.map((a) => a.kind), ['drop', 'drop', 'price']);
  });

  it('throws without an injected now', () => {
    assert.throws(() => evaluate([], makeSnapshot(), makeSnapshot(), {}), /requires opts.now/);
  });

  it('never mutates the input memory', () => {
    const memory = blankMemory();
    const frozen = JSON.stringify(memory);
    const listing = makeListing({ release_id: 'rel_a', price_cents: 3000 });
    evaluate([priceRule()], makeSnapshot(), makeSnapshot({ listings: [listing] }), { now: T0, memory });
    assert.equal(JSON.stringify(memory), frozen);
  });

  it('dedupes: the same diff re-evaluated fires nothing new', () => {
    const listing = makeListing({ release_id: 'rel_a', price_cents: 3000 });
    const prev = makeSnapshot();
    const next = makeSnapshot({ listings: [listing] });
    const first = evaluate([priceRule()], prev, next, { now: T0 });
    assert.equal(first.alerts.length, 1);
    const second = evaluate([priceRule()], prev, next, { now: T0, memory: first.memory });
    assert.equal(second.alerts.length, 0);
  });

  it('enforces cooldown, then fires again after it expires', () => {
    const mk = (cents) => makeSnapshot({ listings: [makeListing({ id: `l${cents}`, release_id: 'rel_a', price_cents: cents })] });
    const first = evaluate([priceRule()], makeSnapshot(), mk(3000), { now: T0 });
    assert.equal(first.alerts.length, 1);
    // 1h later, a different listing under target — still inside cooldown.
    const second = evaluate([priceRule()], mk(3000), mk(2900), { now: plusHours(T0, 1), memory: first.memory });
    assert.equal(second.alerts.length, 0);
    // 25h later — cooldown expired.
    const third = evaluate([priceRule()], mk(2900), mk(2800), { now: plusHours(T0, 25), memory: second.memory });
    assert.equal(third.alerts.length, 1);
  });

  it('refires within cooldown when the deal is 10%+ better', () => {
    const mk = (cents, id) => makeSnapshot({ listings: [makeListing({ id, release_id: 'rel_a', price_cents: cents })] });
    const first = evaluate([priceRule()], makeSnapshot(), mk(3000, 'l1'), { now: T0 });
    assert.equal(first.alerts.length, 1);
    // 2700 is exactly 10% below 3000 — new information, refire.
    const better = evaluate([priceRule()], mk(3000, 'l1'), mk(2700, 'l2'), {
      now: plusHours(T0, 1),
      memory: first.memory,
    });
    assert.equal(better.alerts.length, 1);
    // 2850 is only 5% better — stays quiet.
    const meh = evaluate([priceRule()], mk(3000, 'l1'), mk(2850, 'l3'), {
      now: plusHours(T0, 1),
      memory: first.memory,
    });
    assert.equal(meh.alerts.length, 0);
  });

  it('quarantines a flapping restock listing', () => {
    const rule = makeRule({ id: 'wtc_r', scope_type: 'release', scope_id: 'rel_a', cooldown_hours: 0 });
    const dead = (t) =>
      makeSnapshot({ taken_at: t, listings: [makeListing({ release_id: 'rel_a', available: false })] });
    const live = (t) =>
      makeSnapshot({ taken_at: t, listings: [makeListing({ release_id: 'rel_a', available: true })] });
    let memory = blankMemory();
    // Three dead->live oscillations inside the hour. The first two restocks
    // fire; the third trips the flap quarantine.
    let r = evaluate([rule], dead('2026-09-10T10:00:00.000Z'), live('2026-09-10T11:00:00.000Z'), {
      now: T0,
      memory,
    });
    assert.equal(r.alerts.length, 1);
    memory = r.memory;
    r = evaluate([rule], live('2026-09-10T11:00:00.000Z'), dead('2026-09-10T11:12:00.000Z'), {
      now: plusHours(T0, 0.2),
      memory,
    });
    memory = r.memory;
    r = evaluate([rule], dead('2026-09-10T11:12:00.000Z'), live('2026-09-10T11:24:00.000Z'), {
      now: plusHours(T0, 0.4),
      memory,
    });
    assert.equal(r.alerts.length, 1);
    memory = r.memory;
    r = evaluate([rule], live('2026-09-10T11:24:00.000Z'), dead('2026-09-10T11:30:00.000Z'), {
      now: plusHours(T0, 0.5),
      memory,
    });
    memory = r.memory;
    r = evaluate([rule], dead('2026-09-10T11:30:00.000Z'), live('2026-09-10T11:36:00.000Z'), {
      now: plusHours(T0, 0.6),
      memory,
    });
    assert.equal(r.alerts.length, 0, 'third oscillation should be quarantined');
  });

  it('caps dispatches per day and records the over-budget ones as fired', () => {
    const rules = Array.from({ length: MAX_DISPATCHES_PER_DAY + 3 }, (_, i) =>
      makeRule({ id: `wtc_${i}`, scope_type: 'release', scope_id: 'rel_a', cooldown_hours: 0 }),
    );
    const pressings = rules.map((r, i) => makePressing({ id: `p${i}`, release_id: 'rel_a', title: `pressing ${i}` }));
    const { alerts, memory } = evaluate(rules, makeSnapshot(), makeSnapshot({ pressings }), { now: T0 });
    assert.equal(alerts.length, MAX_DISPATCHES_PER_DAY);
    // Re-evaluating the same diff must not resurrect the suppressed ones.
    const again = evaluate(rules, makeSnapshot(), makeSnapshot({ pressings }), { now: T0, memory });
    assert.equal(again.alerts.length, 0);
  });

  it('resets the dispatch budget on a new day', () => {
    const rule = dropRule({ cooldown_hours: 0 });
    const pressing = makePressing({ id: 'pd', release_id: 'rel_a', title: 'day pressing' });
    const mk = (id) => makePressing({ id, release_id: 'rel_a', title: `pressing ${id}` });
    const rules = Array.from({ length: MAX_DISPATCHES_PER_DAY }, (_, i) =>
      dropRule({ id: `wtc_day_${i}`, cooldown_hours: 0 }),
    );
    const pressings = rules.map((r, i) => mk(`q${i}`));
    const day1 = evaluate(rules, makeSnapshot(), makeSnapshot({ pressings }), { now: T0 });
    assert.equal(day1.alerts.length, MAX_DISPATCHES_PER_DAY);
    const nextDay = plusHours(T0, 25);
    const fresh = makeSnapshot({ pressings: [pressing] });
    const day2 = evaluate([rule], makeSnapshot(), fresh, { now: nextDay, memory: day1.memory });
    assert.equal(day2.alerts.length, 1, 'budget must reset for a new day');
  });
});
