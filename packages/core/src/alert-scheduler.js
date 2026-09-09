/**
 * @file Alert scheduler — the tick loop that closes the wantlist
 * ingestion path (plan §4 item 4, the "hook `runEngine` into the
 * batch path" NEXT step).
 *
 * Every tick the scheduler:
 *
 * 1. pulls one Discogs-shaped release batch from the injected
 *    `getReleases()` provider (fixtures during dev, the Discogs probe
 *    later — the scheduler never reaches for the network itself);
 * 2. runs `runEngine` against the injected `getWantlist()` and the
 *    scheduler-owned `prevStates`, so first-sight / restock /
 *    price-drop events are detected against what the last tick saw;
 * 3. enqueues the events into the injected `createAlertQueue` queue,
 *    where dedupe and the per-user rate cap still hold.
 *
 * The scheduler never sends anything itself — sending stays behind the
 * send-adapter seam (`send-adapters.js`). Disabled adapters stay
 * disabled: a tick whose drained events hit a stub adapter gets
 * `{ ok: false }` receipts and never opens a socket.
 *
 * State ownership: the scheduler owns `prevStates` between ticks
 * (in-memory today; the plan moves it to Postgres with the `alerts`
 * table). The queue owns its own seen-set. Both outlive ticks, so
 * repeated ticks on an unchanged batch go quiet — an alert fires once,
 * never per tick.
 *
 * Zero dependencies, injectable clock. No I/O, no network.
 */

import { runEngine } from './alert-engine.js';

/**
 * Create a scheduler.
 *
 * @param {object} input
 * @param {() => Array<object>|Promise<Array<object>>} input.getReleases
 *   Release batch provider — returns Discogs-shaped releases for this
 *   tick (fixtures in dev/tests, Discogs probe in production).
 * @param {() => Array<object>|Promise<Array<object>>} input.getWantlist
 *   Wantlist provider — returns the current user wants for this tick.
 * @param {object} input.queue An `createAlertQueue` queue.
 * @param {() => number} [input.now] Clock, defaults to `Date.now`.
 * @param {Record<string, object>} [input.prevStates] Seed prior state
 *   (from a previous run / Postgres later); the scheduler owns and
 *   mutates the returned copy.
 * @param {(report: object) => void} [input.onTick] Called after each
 *   tick with the tick report.
 * @returns {{ tick: Function, start: Function, stop: Function, running: Function, ticks: Function, prevStates: Function }}
 */
export function createAlertScheduler({
  getReleases,
  getWantlist,
  queue,
  now = () => Date.now(),
  prevStates = {},
  onTick = null,
} = {}) {
  if (typeof getReleases !== 'function') {
    throw new TypeError('alert scheduler needs a getReleases batch provider');
  }
  if (typeof getWantlist !== 'function') {
    throw new TypeError('alert scheduler needs a getWantlist provider');
  }
  if (!queue || typeof queue.enqueue !== 'function') {
    throw new TypeError('alert scheduler needs an alert queue');
  }

  let states = { ...prevStates };
  let timer = null;
  let tickCount = 0;

  /**
   * Run one tick: fetch batch → match → enqueue. Returns the tick
   * report; throws only when a provider throws (bad batch provider
   * is a caller bug, not an alert worth hiding).
   * @returns {Promise<{ tick: number, at: string, events: Array<object>, queued: Array<object>, dupes: Array<object>, capped: Array<object> }>}
   */
  async function tick() {
    const tickMs = now();
    const releases = (await getReleases()) ?? [];
    const wantlist = (await getWantlist()) ?? [];

    const { events, prevStates: nextStates } = runEngine({
      wantlist,
      releases,
      prevStates: states,
      nowMs: tickMs,
    });
    states = nextStates;

    const { queued, dupes, capped } = queue.enqueue(events);

    tickCount += 1;
    const report = {
      tick: tickCount,
      at: new Date(tickMs).toISOString(),
      events,
      queued,
      dupes,
      capped,
    };
    if (onTick) onTick(report);
    return report;
  }

  /**
   * Start ticking every `intervalMs` milliseconds. Re-starting moves
   * the interval; `stop()` halts it. A tick in flight is never
   * overlapped — if the previous tick hasn't resolved, the interval
   * skips that beat.
   */
  function start(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new TypeError(`alert scheduler needs a positive intervalMs, got ${intervalMs}`);
    }
    stop();
    let inFlight = false;
    timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      Promise.resolve()
        .then(tick)
        .catch(() => {
          // Provider failures surface through the caller's onTick only
          // when the caller passes a throwing provider — swallowing here
          // keeps a sick source from killing the whole sweep. The tick
          // count does not advance on failure.
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
    return timer;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function running() {
    return timer !== null;
  }

  function ticks() {
    return tickCount;
  }

  /** The scheduler-owned prior state — what survives between ticks. */
  function currentPrevStates() {
    return { ...states };
  }

  return { tick, start, stop, running, ticks, prevStates: currentPrevStates };
}
