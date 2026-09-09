/**
 * @file Alert queue — ordered, deduped, per-user-capped staging between
 * the matching engine (`alert-engine.js`) and dispatch (`dispatch.js`).
 *
 * Three properties, all enforced in memory with zero dependencies:
 *
 * 1. **Dedupe** — the same user+release never alerts twice, whether the
 *    duplicate arrives in the same batch or a later pass. The seen-set is
 *    the queue's memory; the persisted `alerts` rows are the durable one.
 * 2. **Per-user rate cap** — a flood of matches for one user does not
 *    become a flood of messages. Over-cap events are refused at enqueue
 *    time and returned in the report so the caller can fold them into the
 *    next digest (the digest module's job, never a silent drop).
 * 3. **Priority ordering** — `drain` hands out the most money-relevant
 *    alerts first: price drops, then restocks, then new releases; ties
 *    break oldest-first.
 *
 * Clock and cap are injectable for tests. No I/O, no network.
 */

import { prevStateKey } from './alert-engine.js';

/** Priority per event kind — money-relevant alerts drain first. */
export const EVENT_PRIORITY = Object.freeze({ price_drop: 3, restock: 2, new: 1 });

/** Default per-user cap: alerts enqueued per rolling hour. */
export const QUEUE_DEFAULT_MAX_PER_USER_PER_HOUR = 10;

const HOUR_MS = 3600_000;

/**
 * The dedupe key for one queued alert: user + release. The same release
 * seen again for the same user is the same news, never a second send.
 * @param {object} event
 * @returns {string}
 */
export function queueDedupeKey(event) {
  return prevStateKey(event?.user_id, {
    id: event?.release_id,
    artists: [{ name: event?.artist_name }],
    title: event?.title,
  });
}

/**
 * Create a queue.
 *
 * @param {object} [input]
 * @param {number} [input.maxPerUserPerHour] Rolling-hour enqueue cap per user.
 * @param {() => number} [input.now] Clock, defaults to `Date.now`.
 * @returns {{ enqueue: Function, drain: Function, peek: Function, size: Function, queuedForUser: Function, stats: Function }}
 */
export function createAlertQueue({ maxPerUserPerHour = QUEUE_DEFAULT_MAX_PER_USER_PER_HOUR, now = () => Date.now() } = {}) {
  if (!Number.isFinite(maxPerUserPerHour) || maxPerUserPerHour < 1) {
    throw new TypeError(`alert queue needs a positive maxPerUserPerHour, got ${maxPerUserPerHour}`);
  }
  const seen = new Set();
  const pending = [];
  /** user_id → ms timestamps of enqueued events inside the trailing hour */
  const userTimestamps = new Map();

  function pruneTimestamps(userId) {
    const cutoff = now() - HOUR_MS;
    const stamps = (userTimestamps.get(userId) ?? []).filter((t) => t >= cutoff);
    userTimestamps.set(userId, stamps);
    return stamps;
  }

  /**
   * Enqueue engine events. Returns the outcome per event — callers fold
   * `capped` and `dupe` events into the next digest rather than dropping
   * them silently.
   * @param {Array<object>} events
   * @returns {{ queued: Array<object>, dupes: Array<object>, capped: Array<object> }}
   */
  function enqueue(events) {
    const queued = [];
    const dupes = [];
    const capped = [];
    for (const event of events ?? []) {
      if (!event || typeof event !== 'object') continue;
      const key = queueDedupeKey(event);
      if (seen.has(key)) {
        dupes.push(event);
        continue;
      }
      const userId = event.user_id ?? '';
      const stamps = pruneTimestamps(userId);
      if (stamps.length >= maxPerUserPerHour) {
        capped.push(event);
        continue;
      }
      seen.add(key);
      stamps.push(now());
      userTimestamps.set(userId, stamps);
      pending.push({ ...event, priority: EVENT_PRIORITY[event.kind] ?? 0 });
      queued.push(event);
    }
    return { queued, dupes, capped };
  }

  function ordered() {
    return [...pending].sort((a, b) => (b.priority - a.priority) || String(a.matched_at ?? '').localeCompare(String(b.matched_at ?? '')));
  }

  /**
   * Take up to `limit` events in priority order. Removed from the queue;
   * the seen-set keeps them deduped forever.
   */
  function drain(limit = Infinity) {
    const out = ordered().slice(0, limit);
    const outIds = new Set(out.map((e) => e));
    for (let i = pending.length - 1; i >= 0; i--) {
      if (outIds.has(pending[i])) pending.splice(i, 1);
    }
    return out;
  }

  function peek() {
    return ordered();
  }

  function size() {
    return pending.length;
  }

  function queuedForUser(userId) {
    return pending.filter((e) => e.user_id === userId).length;
  }

  function stats() {
    return {
      pending: pending.length,
      seen: seen.size,
      perUser: [...userTimestamps.entries()].map(([user_id, stamps]) => ({
        user_id,
        enqueuedThisHour: pruneTimestamps(user_id).length,
      })),
    };
  }

  return { enqueue, drain, peek, size, queuedForUser, stats };
}
