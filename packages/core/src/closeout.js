/**
 * @file Alert close-out — the worker's per-pass pipeline after
 * `runScanPass` (alert engine plan §3, the wiring between the scan worker
 * and the digest queue).
 *
 * The pieces existed but nothing connected them: `runScanPass` returns
 * alert feed items, `dispatchScanAlerts` sends and persists them,
 * `queueHeldAlerts` sweeps the persisted rows for held-back deliveries,
 * and `flushDigestQueue` turns the queue into digest emails. This module
 * is the cron entry point that runs the whole pass in order:
 *
 * 1. `runWorkerTick` — scan every due source (poller), then close out.
 * 2. `runAlertCloseout` — drop feed items the user was already told about
 *    (crash-safety: a retried pass never double-sends), dispatch what may
 *    go now, queue the held-back deliveries into the digest queue, flush
 *    due digest emails.
 *
 * Nothing here does network I/O itself: the fetcher and the channels are
 * injected. The tick never throws — a dead source, a missing channel, a
 * throwing channel are all rows or held digests, never a crash, because
 * one bad tick must not take down the cron.
 */

/* eslint-disable no-await-in-loop */

import { runScanPass } from './poller.js';
import { dispatchScanAlerts } from './dispatch.js';
import { queueHeldAlerts, flushDigestQueue } from './digest.js';
import { alertDedupeKey, alreadyAlerted } from './rules.js';

/**
 * Drop feed items the user was already told about. A retried pass (the
 * worker crashed between dispatch and flush, the cron fired twice) feeds
 * the same items again; the persisted alert row is the exactly-once
 * marker, so anything already sent is a drop, not a duplicate send.
 *
 * Rows where every send failed are NOT markers (`alreadyAlerted` only
 * counts rows with at least one sent channel) — a failed send retries on
 * the next pass instead of going silent.
 *
 * @param {object} store A `@wax/core` store.
 * @param {Array<object>} alerts Feed items from `runScanPass`.
 * @returns {Promise<{ fresh: Array<object>, dedupeDropped: number }>}
 */
export async function filterAlreadyAlerted(store, alerts) {
  const fresh = [];
  let dedupeDropped = 0;
  for (const alert of alerts ?? []) {
    const key = alertDedupeKey({
      user_id: alert?.user_id,
      artist_name: alert?.artist_name,
      title: alert?.title,
    });
    if (await alreadyAlerted(store, key)) {
      dedupeDropped += 1;
      continue;
    }
    fresh.push(alert);
  }
  return { fresh, dedupeDropped };
}

/**
 * Close out one pass's alert feed: dispatch → queue held deliveries →
 * flush due digests.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {Array<object>} [input.alerts] Feed items from `runScanPass`.
 * @param {Record<string, object>} [input.channels] Channel map (`'email'`,
 *   `'sms'`, webhook names… — whatever `dispatchScanAlerts` needs).
 * @param {string[]} [input.fanout] Fan-out mirror names, passed through.
 * @param {number} [input.nowMs]
 * @returns {Promise<{ dispatched: number, receipts: number, dedupeDropped: number, queued: number, queuedSkipped: number, digestExpired: number, digestUsers: Array<object> }>}
 */
export async function runAlertCloseout({ store, alerts = [], channels = {}, fanout = [], nowMs = Date.now() }) {
  const { fresh, dedupeDropped } = await filterAlreadyAlerted(store, alerts);

  const dispatch = await dispatchScanAlerts({ store, alerts: fresh, channels, fanout, nowMs });

  const { queued, skipped: queuedSkipped } = await queueHeldAlerts({ store, alerts: dispatch.alerts, nowMs });

  const { expired: digestExpired, users: digestUsers } = await flushDigestQueue({ store, channels, nowMs });

  return {
    dispatched: dispatch.dispatched,
    receipts: dispatch.receipts.length,
    dedupeDropped,
    queued,
    queuedSkipped,
    digestExpired,
    digestUsers,
  };
}

/**
 * One full tick of the worker: scan every due source, then close out the
 * resulting alert feed. This is what the per-minute cron calls.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {(source: object) => Promise<{ status: number, rawList: Array<object> }>} input.fetcher
 * @param {Record<string, object>} [input.channels] Channel map for dispatch + digest.
 * @param {string[]} [input.fanout]
 * @param {number} [input.nowMs]
 * @param {number} [input.limit] Max sources this pass. Defaults to poller's `PASS_LIMIT`.
 * @returns {Promise<{ now: string, due: number, succeeded: number, failed: number, newAlerts: number, dispatched: number, receipts: number, dedupeDropped: number, queued: number, digestExpired: number, digestUsers: Array<object> }>}
 */
export async function runWorkerTick({ store, fetcher, channels = {}, fanout = [], nowMs = Date.now(), limit } = {}) {
  const pass = await runScanPass({ store, fetcher, nowMs, ...(limit === undefined ? {} : { limit }) });
  const closeout = await runAlertCloseout({ store, alerts: pass.alerts, channels, fanout, nowMs });

  return {
    now: pass.now,
    due: pass.due,
    succeeded: pass.succeeded,
    failed: pass.failed,
    newAlerts: pass.newAlerts,
    dispatched: closeout.dispatched,
    receipts: closeout.receipts,
    dedupeDropped: closeout.dedupeDropped,
    queued: closeout.queued,
    digestExpired: closeout.digestExpired,
    digestUsers: closeout.digestUsers,
  };
}
