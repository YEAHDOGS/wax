/**
 * @file Alert-engine persistence — the durable memory behind the tick loop
 * (ALERT-ENGINE-PLAN.md §4, the "persist prevStates + the queue's seen-set
 * in Postgres with the `alerts` table" step).
 *
 * The restart recipe, in order:
 *
 * 1. `persistence.restoreQueueSeen(queue)` — replay dispatched `alerts`
 *    rows into the queue's seen-set, so an already-alerted user+release is
 *    never queued again.
 * 2. `createAlertScheduler({ ..., persistence })` — loads the durable
 *    `engine_state` rows into `prevStates` before the first tick, and
 *    upserts them after every tick. An unchanged batch goes quiet across
 *    restarts; a restart never re-fires a known release as "new".
 *
 * Everything talks to the store interface (`store.engineStates`,
 * `store.alerts`), never to SQL — so this module works against the
 * in-memory store today and against Postgres the day `store.js` is swapped,
 * with no change here. That swap is exactly the seam `store.js` documents.
 *
 * Async-store contract: every store method is awaited, so a store whose
 * methods return promises (Postgres) and one whose methods return values
 * (the in-memory store) behave identically through this module. All four
 * public functions return promises.
 *
 * Failure policy: a failed save is thrown, not swallowed. Silently losing
 * engine state means re-alerting every user on the next tick — loud is
 * cheaper than that flood.
 *
 * Zero dependencies, no network, no secrets.
 */

import { prevStateKey } from './alert-engine.js';
import { newId } from './store.js';

/**
 * The field separator inside a `prevStateKey` composite — the same `\u001f`
 * the engine uses, so a persisted row round-trips back to the identical key.
 */
export const ENGINE_STATE_KEY_SEP = '\u001f';

/**
 * Split a composite prevStates key back into its row coordinates.
 * @param {string} compositeKey
 * @returns {{ user_id: string, state_key: string }}
 */
export function splitEngineKey(compositeKey) {
  const s = String(compositeKey ?? '');
  const i = s.indexOf(ENGINE_STATE_KEY_SEP);
  if (i === -1) return { user_id: s, state_key: '' };
  return { user_id: s.slice(0, i), state_key: s.slice(i + 1) };
}

/**
 * Engine event kinds → `alerts.kind` (AlertKind) mapping for `recordAlert`.
 * The engine's vocabulary is "new/restock/price_drop"; the alerts board's
 * is "drop/price/restock/merch".
 */
export const ENGINE_TO_ALERT_KIND = Object.freeze({
  new: 'drop',
  price_drop: 'price',
  restock: 'restock',
});

/**
 * @param {object} store A `createStore` store (or the Postgres-backed
 *   replacement, when it lands — same interface).
 * @returns {{ loadPrevStates: Function, savePrevStates: Function, restoreQueueSeen: Function, recordAlert: Function }}
 */
export function createAlertPersistence(store) {
  if (!store || typeof store.engineStates?.all !== 'function') {
    throw new TypeError('alert persistence needs a store with an engineStates collection');
  }
  if (typeof store.alerts?.all !== 'function') {
    throw new TypeError('alert persistence needs a store with an alerts collection');
  }

  /**
   * Read the durable `engine_state` rows back into the `prevStates` map
   * shape `runEngine` consumes.
   * @returns {Promise<Record<string, object>>}
   */
  async function loadPrevStates() {
    const out = {};
    for (const row of await store.engineStates.all()) {
      if (row?.user_id == null || row?.state_key == null || row?.state == null) continue;
      out[prevStateKey(row.user_id, { id: row.state_key })] = row.state;
    }
    return out;
  }

  /**
   * Upsert a `prevStates` map into `engine_state`. Rows whose composite key
   * cannot be split into a user and a release key are skipped — persisting
   * garbage keys would corrupt the restart contract.
   * @param {Record<string, object>} prevStates
   * @returns {Promise<number>} Rows upserted.
   */
  async function savePrevStates(prevStates) {
    let upserted = 0;
    const at = new Date().toISOString();
    for (const [compositeKey, state] of Object.entries(prevStates ?? {})) {
      const { user_id, state_key } = splitEngineKey(compositeKey);
      if (!user_id || !state_key || state == null || typeof state !== 'object') continue;
      const match = (r) => r.user_id === user_id && r.state_key === state_key;
      if (await store.engineStates.find(match)) {
        await store.engineStates.update(match, { state, updated_at: at });
      } else {
        await store.engineStates.insert({ user_id, state_key, state, updated_at: at });
      }
      upserted += 1;
    }
    return upserted;
  }

  /**
   * Replay every dispatched `alerts` row into the queue's seen-set.
   * @param {object} queue A `createAlertQueue` queue.
   * @returns {Promise<number>} Rows replayed.
   */
  async function restoreQueueSeen(queue) {
    if (!queue || typeof queue.markSeen !== 'function') {
      throw new TypeError('restoreQueueSeen needs an alert queue with markSeen');
    }
    let restored = 0;
    for (const row of await store.alerts.all()) {
      if (row?.user_id == null || row?.release_id == null) continue;
      queue.markSeen({ user_id: row.user_id, release_id: row.release_id });
      restored += 1;
    }
    return restored;
  }

  /**
   * Record one dispatched engine event as a durable `alerts` row — this is
   * what makes the queue's seen-set survive a restart. Never throws on
   * content: hostile or half-formed events still become rows (never
   * silently skipped), because a dropped alert is worse than an odd one.
   * @param {object} event An engine event (`runEngine` shape).
   * @param {object} [input]
   * @param {Array<string>} [input.channels] Where the message went.
   * @param {() => number} [input.now] Clock.
   * @returns {Promise<object>} The inserted alert row, cloned.
   */
  async function recordAlert(event, { channels = [], now = () => Date.now() } = {}) {
    const at = new Date(now()).toISOString();
    return store.alerts.insert({
      id: newId('alr'),
      user_id: event?.user_id ?? 'unknown',
      release_id: event?.release_id ?? 'unknown',
      watch_id: event?.want_id ?? null,
      kind: ENGINE_TO_ALERT_KIND[event?.kind] ?? 'drop',
      state: 'live',
      detected_at: event?.matched_at ?? at,
      dispatched_at: at,
      read_at: null,
      channels: Array.isArray(channels) ? channels : [],
      listing_url: event?.listing_url ?? null,
      price_cents: event?.price_cents ?? null,
      created_at: at,
    });
  }

  return { loadPrevStates, savePrevStates, restoreQueueSeen, recordAlert };
}
