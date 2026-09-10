/**
 * The evaluator: runs every rule's matchers over a snapshot diff, then passes
 * candidates through the anti-noise gate (dedup → cooldown → flap
 * suppression → dispatch budget). Pure: takes `now` and `memory` in, returns
 * alerts plus a *new* memory object. Never mutates its inputs.
 */

import {
  byPriority,
  matchMerch,
  matchNewPressing,
  matchPriceDrop,
  matchRestock,
} from './matchers.js';

export const MAX_DISPATCHES_PER_DAY = 25;
const FLAP_WINDOW_MS = 60 * 60 * 1000; // 1h
const FLAP_QUARANTINE_MS = 6 * 60 * 60 * 1000; // 6h
const FLAP_TRIPS = 3;

/**
 * @param {import('./types.js').AlertRule[]} rules
 * @param {import('./types.js').Snapshot} prev
 * @param {import('./types.js').Snapshot} next
 * @param {object} opts
 * @param {string} opts.now ISO timestamp. Required — no clock reads inside.
 * @param {import('./types.js').EngineMemory} [opts.memory]
 * @returns {{ alerts: import('./types.js').AlertCandidate[],
 *            memory: import('./types.js').EngineMemory }}
 */
export function evaluate(rules, prev, next, { now, memory = blankMemory() } = {}) {
  if (!now) throw new Error('evaluate() requires opts.now — the engine never reads the clock.');

  const ruleById = new Map(rules.map((r) => [r.id, r]));
  let candidates = [];
  for (const rule of rules) {
    candidates.push(
      ...matchNewPressing(rule, prev, next, now),
      ...matchPriceDrop(rule, prev, next, now),
      ...matchRestock(rule, prev, next, now),
      ...matchMerch(rule, prev, next, now),
    );
  }

  const mem = cloneMemory(memory);
  const day = now.slice(0, 10);
  const alerts = [];

  for (const candidate of byPriority(candidates)) {
    const rule = ruleById.get(candidate.rule_id);

    // 1. Dedup — the same event never fires twice. Keys are per event:
    //    a pressing appears once, a price crossing and a restock are keyed
    //    per transition, so genuine re-crossings can still fire via cooldown.
    if (mem.fired_keys[candidate.dedup_key]) continue;

    // 2. Cooldown — same rule/kind/release may not refire within the window,
    //    unless the price fell at least 10% further than the last fired
    //    price (a genuinely better deal is new information).
    const cdKey = `${candidate.rule_id}:${candidate.kind}:${candidate.release_id}`;
    const last = mem.last_fired[cdKey];
    if (last && !cooldownExpired(candidate, rule, last, now)) continue;

    // 3. Flap suppression — restock alerts only. A listing oscillating
    //    available/sold >=3 times in an hour is quarantined for 6 hours.
    if (candidate.kind === 'restock' && isFlapping(mem, candidate, now)) continue;

    // 4. Dispatch budget — max N per user per day; drops win ties (the
    //    priority sort above guarantees that). Over-budget candidates are
    //    recorded as fired so they never refire later — they stay visible
    //    on the board as undelivered rather than re-alerting.
    const spent = mem.dispatched_by_day[day] ?? 0;
    mem.fired_keys[candidate.dedup_key] = now;
    mem.last_fired[cdKey] = { at: now, price_cents: candidate.price_cents ?? null };
    if (spent < MAX_DISPATCHES_PER_DAY) {
      mem.dispatched_by_day[day] = spent + 1;
      alerts.push(candidate);
    }
  }

  return { alerts, memory: mem };
}

/**
 * Cooldown is satisfied when the window elapsed, or when this is a price
 * candidate at least 10% cheaper than the price we last fired on.
 */
function cooldownExpired(candidate, rule, last, now) {
  const hours = rule?.cooldown_hours ?? 24;
  if (Date.parse(now) - Date.parse(last.at) >= hours * 3600 * 1000) return true;
  if (
    candidate.kind === 'price' &&
    candidate.price_cents != null &&
    last.price_cents != null
  ) {
    return candidate.price_cents <= last.price_cents * 0.9;
  }
  return false;
}

/**
 * A listing flaps when its availability toggles repeatedly. Tracked on
 * restock candidates; a quarantined listing's alerts are dropped until the
 * quarantine expires.
 */
function isFlapping(mem, candidate, now) {
  if (!candidate.listing_id) return false;
  const nowMs = Date.parse(now);
  const entry = mem.flaps[candidate.listing_id] ?? {
    count: 0,
    window_start: now,
    quarantined_until: null,
  };

  if (entry.quarantined_until && Date.parse(entry.quarantined_until) > nowMs) return true;

  const inWindow = nowMs - Date.parse(entry.window_start) < FLAP_WINDOW_MS;
  const count = (inWindow ? entry.count : 0) + 1;
  const window_start = inWindow ? entry.window_start : now;
  const quarantined_until =
    count >= FLAP_TRIPS ? new Date(nowMs + FLAP_QUARANTINE_MS).toISOString() : null;

  mem.flaps[candidate.listing_id] = { count, window_start, quarantined_until };
  return quarantined_until != null;
}

export function blankMemory() {
  return { fired_keys: {}, last_fired: {}, flaps: {}, dispatched_by_day: {} };
}

function cloneMemory(mem) {
  return {
    fired_keys: { ...mem.fired_keys },
    last_fired: Object.fromEntries(
      Object.entries(mem.last_fired).map(([k, v]) => [k, { ...v }]),
    ),
    flaps: Object.fromEntries(Object.entries(mem.flaps).map(([k, v]) => [k, { ...v }])),
    dispatched_by_day: { ...mem.dispatched_by_day },
  };
}
