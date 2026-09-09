/**
 * @file Drop-alert scheduler — the decision layer between tracked
 * releases and the DISPATCH boundary (ALERT-ENGINE-PLAN.md §3, "Alert
 * delivery", and §4 item 4, "Artist matching + cross-source dedupe").
 *
 * Where it sits: `alert-scheduler.js` ticks the wantlist/Discogs engine
 * path into the alert queue; `rules.js` routes one scan pass's
 * candidates for one user with forever exactly-once semantics. This
 * module is the third path — the *release board* path: a batch of
 * tracked releases (the store's `releases` rows) and the users' alert
 * rules (the `watches` rows, as `rules.js` `WatchRule`s). Every pass it
 * decides which (user, release) pairs are *due*, then hands the due
 * ones to the DISPATCH boundary.
 *
 * ## Due logic
 *
 * 1. **Match** — each release is scored against each rule with
 *    `evaluateWatchRule` (rules.js), so the scheduler can never
 *    disagree with the scan path about what a rule means. A rule that
 *    does not match a release never becomes an alert.
 * 2. **In-batch dedupe** — two rules from the same user matching the
 *    same release in one pass produce ONE due alert; the loser is
 *    suppressed as `duplicate in batch`.
 * 3. **Cooldown** — the scheduler keeps a per (user, release)
 *    `lastSentAt` map. An alert that went out less than `cooldownMs`
 *    ago is suppressed (`cooldown`) — a user never gets the same alert
 *    twice in the window, and a restock long after the window *can*
 *    alert again, which is the correct product behavior (the old
 *    forever-exactly-once of `rules.js` covers the scan path; the
 *    board path wants "once per cooldown").
 *
 * ## Memory and restarts
 *
 * The cooldown map is in-memory. `restoreSent(rows)` replays durable
 * `alerts` rows (`{ user_id, release_id, dispatched_at }`) into it —
 * call that before the first pass on boot, and the exact recipe
 * mirrors `alert-persistence.js`: a restart never re-alerts a user
 * whose alert went out before the crash.
 *
 * ## DISPATCH boundary
 *
 * Dispatch is a pure function interface — one job, one shape:
 *
 *   dispatch(alert) => Promise<{ ok: boolean, ...receipt }>
 *
 * The scheduler never knows whether the function prints, queues, or
 * sends for real. `dispatchDue` calls it for every due alert and marks
 * a pair sent only on an `{ ok: true }` receipt — an `{ ok: false }`
 * receipt, a thrown error, or a garbage receipt leaves the pair
 * *unsent*, so the next pass retries instead of going silent.
 *
 * `createTestDispatch` is the TEST-MODE stub: it records every
 * envelope in-memory (`stub.sent`) and returns `{ ok: true, testMode:
 * true }` — no socket is ever opened, so network sends are
 * structurally impossible in tests. Optional `failOn` injects
 * `{ ok: false }` failures for testing the retry path.
 *
 * Zero dependencies, injectable clock. No I/O, no network.
 */

import { evaluateWatchRule } from './rules.js';

/** Default cooldown: a user gets the same release alert at most once per week. */
export const DROP_DEFAULT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The dedupe key for one drop alert: user + release id. Two (rule,
 * release) pairs with the same key are the same alert, whether they
 * surfaced from two rules, two sources, or two passes.
 * @param {object} input
 * @param {string} input.user_id
 * @param {string} input.release_id
 * @returns {string}
 */
export function dropDedupeKey({ user_id, release_id }) {
  return [user_id ?? '', release_id ?? ''].join('');
}

/**
 * Normalize a tracked release row into the product shape
 * `evaluateWatchRule` speaks. Tracked releases carry `artist_name`
 * while scanner products carry `artist` — the scheduler speaks both,
 * same as the rule engine.
 * @param {object} release `{ id, artist_name?, artist?, title, label?, price_cents?, listing_url?, url? }`
 * @returns {object}
 */
export function dropReleaseProduct(release) {
  return {
    artist: release?.artist ?? release?.artist_name ?? '',
    title: release?.title ?? '',
    label: release?.label ?? null,
    price_cents: release?.price_cents ?? release?.price ?? null,
  };
}

/**
 * Create the TEST-MODE dispatch stub. Records every envelope passed to
 * it in-memory; returns `{ ok: true, testMode: true }` receipts and
 * opens no socket, ever.
 *
 * @param {object} [input]
 * @param {(alert: object) => boolean} [input.failOn] When the predicate
 *   returns true for an alert, that call gets an `{ ok: false }`
 *   receipt instead — for pinning the retry path. Default: never fail.
 * @returns {{ dispatch: Function, sent: Function, reset: Function }}
 */
export function createTestDispatch({ failOn = () => false } = {}) {
  /** Every envelope this stub was handed, in call order. */
  const seen = [];

  /**
   * The DISPATCH boundary itself: pure interface, test implementation.
   * @param {object} alert The due alert envelope.
   * @returns {Promise<{ ok: boolean, testMode: boolean, reason?: string }>}
   */
  async function dispatch(alert) {
    seen.push({ alert: { ...alert }, at: new Date().toISOString() });
    if (failOn(alert)) {
      return { ok: false, testMode: true, reason: 'test failure injected by failOn' };
    }
    return { ok: true, testMode: true };
  }

  /** The recorded envelopes (copies — the stub keeps no caller-mutable aliasing surprises). */
  function sent() {
    return seen.map(({ alert, at }) => ({ alert: { ...alert }, at }));
  }

  function reset() {
    seen.length = 0;
  }

  return { dispatch, sent, reset };
}

/**
 * Create the drop-alert scheduler.
 *
 * @param {object} [input]
 * @param {number} [input.cooldownMs] Window during which a (user,
 *   release) pair will not re-alert after a send. Defaults to one
 *   week. Must be a positive finite number.
 * @param {() => number} [input.now] Clock, defaults to `Date.now`.
 * @returns {{ schedule: Function, dispatchDue: Function, runPass: Function, restoreSent: Function, lastSentAt: Function }}
 */
export function createDropScheduler({ cooldownMs = DROP_DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 1) {
    throw new TypeError(`drop scheduler needs a positive cooldownMs, got ${cooldownMs}`);
  }

  /** dropDedupeKey -> epoch ms of the last successful dispatch. */
  const sentAt = new Map();

  /**
   * Replay durable `alerts` rows into the cooldown map — the restart
   * recipe. Rows without `dispatched_at` are not markers (their sends
   * failed); rows with a later timestamp win for the same key.
   * @param {Array<{ user_id: string, release_id: string, dispatched_at: string }>} rows
   * @returns {number} Count of keys restored.
   */
  function restoreSent(rows) {
    let restored = 0;
    for (const row of rows ?? []) {
      const key = dropDedupeKey({ user_id: row?.user_id, release_id: row?.release_id });
      const at = new Date(row?.dispatched_at ?? NaN).getTime();
      if (!key || !Number.isFinite(at)) continue;
      if (!sentAt.has(key) || sentAt.get(key) < at) {
        sentAt.set(key, at);
        restored += 1;
      }
    }
    return restored;
  }

  /**
   * Decide which alerts are due for one pass.
   *
   * @param {object} input
   * @param {Array<object>} input.releases Tracked releases (see `dropReleaseProduct`).
   * @param {Array<object>} input.rules Watch rules (rules.js `WatchRule` shape, each with `user_id`).
   * @param {number} [input.nowMs]
   * @returns {{ due: Array<object>, suppressed: Array<{ rule: object, release: object, reason: string }> }}
   */
  function schedule({ releases = [], rules = [], nowMs = now() } = {}) {
    const due = [];
    const suppressed = [];
    const seen = new Set();

    for (const rule of rules ?? []) {
      for (const release of releases ?? []) {
        const product = dropReleaseProduct(release);
        const { match } = evaluateWatchRule({ product, rule });
        if (!match) continue;

        const key = dropDedupeKey({ user_id: rule?.user_id, release_id: release?.id });
        if (seen.has(key)) {
          suppressed.push({ rule, release, reason: 'duplicate in batch: same user+release already due this pass' });
          continue;
        }
        const last = sentAt.get(key);
        if (last !== undefined && nowMs - last < cooldownMs) {
          suppressed.push({ rule, release, reason: `cooldown: already sent ${Math.round((nowMs - last) / 1000)}s ago (< ${Math.round(cooldownMs / 1000)}s window)` });
          continue;
        }
        seen.add(key);
        due.push({
          key,
          user_id: rule.user_id,
          rule_id: rule.id ?? null,
          release_id: release.id,
          artist_name: product.artist,
          title: product.title,
          price_cents: Number.isFinite(product.price_cents) ? product.price_cents : null,
          listing_url: release.listing_url ?? release.url ?? null,
        });
      }
    }
    return { due, suppressed };
  }

  /**
   * Hand due alerts to the DISPATCH boundary. A pair is marked sent
   * only on an `{ ok: true }` receipt; failures and throws stay
   * unmarked so the next pass retries. Never throws.
   *
   * @param {object} input
   * @param {Array<object>} input.due Due alerts from `schedule`.
   * @param {(alert: object) => Promise<{ ok: boolean }>} input.dispatch The DISPATCH boundary.
   * @param {number} [input.nowMs]
   * @returns {Promise<{ delivered: Array<object>, failed: Array<{ alert: object, reason: string }>, receipts: Array<object> }>}
   */
  async function dispatchDue({ due = [], dispatch, nowMs = now() } = {}) {
    if (typeof dispatch !== 'function') {
      throw new TypeError('dispatchDue needs a dispatch function (the DISPATCH boundary)');
    }
    const delivered = [];
    const failed = [];
    const receipts = [];

    for (const alert of due) {
      let receipt;
      try {
        receipt = await dispatch(alert);
      } catch (err) {
        failed.push({ alert, reason: `dispatch threw: ${err?.message ?? String(err)}` });
        continue;
      }
      receipts.push(receipt);
      if (receipt && receipt.ok === true) {
        sentAt.set(alert.key, nowMs);
        delivered.push({ alert, receipt });
      } else {
        failed.push({ alert, reason: `dispatch refused: ${receipt?.reason ?? 'no reason given'}` });
      }
    }
    return { delivered, failed, receipts };
  }

  /**
   * One full pass: schedule, then dispatch the due alerts. Convenience
   * for the cron; never throws (dispatch failures are `failed`, not
   * crashes).
   */
  async function runPass({ releases, rules, dispatch, nowMs = now() } = {}) {
    const { due, suppressed } = schedule({ releases, rules, nowMs });
    const delivery = await dispatchDue({ due, dispatch, nowMs });
    return { due, suppressed, delivered: delivery.delivered, failed: delivery.failed, receipts: delivery.receipts };
  }

  /** Inspect one key's last-sent timestamp (tests / ops), or undefined. */
  function lastSentAt({ user_id, release_id }) {
    return sentAt.get(dropDedupeKey({ user_id, release_id }));
  }

  return { schedule, dispatchDue, runPass, restoreSent, lastSentAt };
}
