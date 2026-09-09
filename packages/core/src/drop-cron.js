/**
 * @file Board-path cron hookup — hangs the drop scheduler's `runPass`
 * between the tracked-release board and the DISPATCH boundary
 * (ALERT-ENGINE-PLAN.md §3, "Alert delivery": "wire the scheduler's
 * cooldown map to the durable `alerts` rows at boot ... and hang the
 * per-minute cron's `runPass({ releases, rules, dispatch })` off the
 * board path so tracked-release drops flow through the same dispatch
 * receipts as the scan path").
 *
 * The board path has one join the scheduler's pure `runPass` cannot do
 * by itself: the store's `releases` rows carry `artist_id` (not the
 * artist name `evaluateWatchRule` matches on), and the `watches` rows
 * carry `artist_id` (not the `rule.artist = { name, aliases }` object
 * the rule engine requires). `loadBoard()` hydrates both from the
 * store's `artists` collection, so the scheduler can never disagree
 * with the scan path about what a rule means — one rule implementation
 * for every path.
 *
 * ## The cron tick (what the per-minute cron should call)
 *
 *   const cron = createDropCron({ store, persistence, dispatch });
 *   await cron.boot();          // once per process: restores the cooldown
 *   const report = await cron.runDropPass();  // every minute
 *
 * `boot()` replays durable `alerts` rows (`{ user_id, release_id,
 * dispatched_at }`) into the scheduler's cooldown map — `restoreSent`
 * takes those rows directly. A restart never re-alerts a user whose
 * alert went out before the crash, and a restock *after* the cooldown
 * window can re-alert, which is the correct product behavior.
 *
 * `runDropPass()` loads the board, runs the scheduler's `runPass`,
 * and records every delivered alert durably via
 * `persistence.recordAlert` — the same durable `alerts` rows `boot()`
 * replays. Pairs are marked sent only on `{ ok: true }` receipts, so
 * refusals and throws retry on the next pass instead of going silent.
 *
 * Zero dependencies. No I/O, no network — the store and the DISPATCH
 * boundary are injected. All store reads are awaited, so this is
 * Postgres-safe the day `store-resolve.js` returns the Postgres store.
 */

import { createDropScheduler, DROP_DEFAULT_COOLDOWN_MS } from './drop-scheduler.js';

/**
 * Hydrate one store `releases` row into the release shape the
 * scheduler's `dropReleaseProduct` speaks: the artist name resolved
 * through the artists collection, falling back to any `artist_name`
 * already on the row.
 * @param {Map<string, object>} artistsById
 * @returns {(release: object) => object}
 */
function hydrateRelease(artistsById) {
  return (release) => {
    const artist = release?.artist_id != null ? artistsById.get(release.artist_id) : null;
    const artist_name = artist?.name ?? release?.artist_name ?? release?.artist ?? '';
    return { ...release, artist_name };
  };
}

/**
 * Hydrate one store `watches` row into the `WatchRule` shape
 * `evaluateWatchRule` requires: the same row plus
 * `artist: { name, aliases }` resolved through the artists
 * collection. A watch whose artist cannot be resolved is returned
 * `null` — it is reported in the pass's `skipped`, never silently
 * dropped.
 * @param {Map<string, object>} artistsById
 * @returns {(watch: object) => ?object}
 */
function hydrateRule(artistsById) {
  return (watch) => {
    const artist = watch?.artist_id != null ? artistsById.get(watch.artist_id) : null;
    if (!artist?.name) return null;
    return {
      ...watch,
      artist: { name: artist.name, aliases: Array.isArray(artist.aliases) ? artist.aliases : [] },
    };
  };
}

/**
 * Create the board-path cron hookup.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store (`releases`,
 *   `watches`, `artists`, `alerts` collections). Reads are awaited, so
 *   an async store is fine.
 * @param {object} input.persistence `createAlertPersistence(store)` —
 *   provides `recordAlert` for delivered alerts.
 * @param {(alert: object) => Promise<{ ok: boolean }>} [input.dispatch]
 *   The DISPATCH boundary. Defaults to a refusal so a mis-wired cron
 *   never pretends it sent something (loud refusal, not a silent
 *   drop).
 * @param {number} [input.cooldownMs] Passed to the scheduler. Defaults
 *   to one week.
 * @param {() => number} [input.now] Clock.
 * @returns {{ boot: Function, loadBoard: Function, runDropPass: Function, scheduler: object }}
 */
export function createDropCron({ store, persistence, dispatch, cooldownMs = DROP_DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('createDropCron needs a store');
  }
  if (!persistence || typeof persistence.recordAlert !== 'function') {
    throw new TypeError('createDropCron needs a persistence with recordAlert (createAlertPersistence(store))');
  }
  const dispatchFn =
    typeof dispatch === 'function'
      ? dispatch
      : async () => ({ ok: false, reason: 'no dispatch boundary configured for the drop cron' });

  const scheduler = createDropScheduler({ cooldownMs, now });
  let booted = false;

  /**
   * Once per process: replay durable `alerts` rows into the
   * scheduler's cooldown map. Rows without `dispatched_at` are not
   * markers (their sends failed), so they never suppress a retry.
   * @returns {Promise<number>} Count of cooldown keys restored.
   */
  async function boot() {
    const rows = await store.alerts.all();
    const restored = scheduler.restoreSent(rows);
    booted = true;
    return restored;
  }

  /**
   * Load and hydrate the board: tracked releases and watch rules from
   * the store, with artist names joined in.
   * @returns {Promise<{ releases: Array<object>, rules: Array<object>, skipped: Array<{ watch: object, reason: string }> }>}
   */
  async function loadBoard() {
    const [releases, watches, artists] = await Promise.all([
      store.releases.all(),
      store.watches.all(),
      store.artists.all(),
    ]);
    const artistsById = new Map((artists ?? []).map((a) => [a?.id, a]));

    const skipped = [];
    const rules = [];
    for (const watch of watches ?? []) {
      const rule = hydrateRule(artistsById)(watch);
      if (!rule) {
        skipped.push({
          watch,
          reason: `watch ${watch?.id ?? '?'} references unknown artist_id ${watch?.artist_id ?? '?'}`,
        });
        continue;
      }
      rules.push(rule);
    }

    return {
      releases: (releases ?? []).map(hydrateRelease(artistsById)),
      rules,
      skipped,
    };
  }

  /**
   * One cron tick: boot if needed, load the board, run the scheduler
   * pass, record delivered alerts durably. Never throws — dispatch
   * failures come back in `failed`, never as crashes.
   *
   * @param {object} [input]
   * @param {(alert: object) => Promise<{ ok: boolean }>} [input.dispatch] Overrides the constructor dispatch for this pass.
   * @returns {Promise<{ booted: boolean, restored: number, board: object, due: Array, suppressed: Array, delivered: Array, failed: Array, recorded: Array<object> }>}
   */
  async function runDropPass({ dispatch: passDispatch } = {}) {
    let restored = 0;
    if (!booted) {
      restored = await boot();
    }
    const board = await loadBoard();
    const rulesById = new Map(board.rules.map((rule) => [rule?.id, rule]));
    const pass = await scheduler.runPass({
      releases: board.releases,
      rules: board.rules,
      dispatch: passDispatch ?? dispatchFn,
      nowMs: now(),
    });

    // Delivered alerts land durably — the same `alerts` rows the next
    // boot replays, so a delivered alert can never re-fire after a
    // restart. Only { ok: true } receipts get here: the scheduler
    // keeps refusals and throws unmarked for the next pass to retry.
    const recorded = [];
    for (const { alert } of pass.delivered) {
      const rule = rulesById.get(alert?.rule_id);
      const channels = Array.isArray(rule?.channels) ? rule.channels : [];
      recorded.push(await persistence.recordAlert(alert, { channels, now }));
    }

    return {
      booted: true,
      restored,
      board,
      due: pass.due,
      suppressed: pass.suppressed,
      delivered: pass.delivered,
      failed: pass.failed,
      recorded,
    };
  }

  return { boot, loadBoard, runDropPass, scheduler };
}
