/**
 * @file Alert dispatch stage — drains the alert queue and delivers events
 * through pluggable adapters (ALERT-ENGINE-PLAN.md §3, "Alert delivery").
 *
 * This module is the hand-off between the queue (`alert-queue.js`) and the
 * send-adapter seam (`send-adapters.js`). It owns exactly one job: take
 * drained events, deliver each through the right adapter, and make sure
 * an alert is never delivered twice.
 *
 * ## Dedupe contract
 *
 * The queue's seen-set is the dedupe authority. `enqueue` already marks
 * every queued event seen, so a drained event is known exactly once; the
 * dispatcher defensively re-marks it after a successful delivery, and the
 * durable `alerts` rows (`recordAlert`, via `persistence`) are what make
 * that memory survive a restart — `restoreQueueSeen` replays them into a
 * fresh queue, so a dispatched alert never re-queues after a reboot.
 *
 * Crash window, stated plainly: the durable row is written only after a
 * successful receipt. A crash between the send and the write can cause a
 * re-delivery on restart — safer than the alternative (a silently dropped
 * alert), and the seen-set keeps it a one-time event otherwise.
 *
 * ## Adapters
 *
 * An adapter is anything honoring the `dispatch.js` channel contract:
 *
 *   { name: string, kind: string, send(envelope) => Promise<receipt> }
 *
 * Register one per channel name with `registerAdapter(name, adapter)` — a
 * future Resend/email adapter plugs in through that single call; nothing
 * in this module changes. An event's `channel` field (else `'default'`)
 * picks its adapter; a channel with no adapter falls back to `'default'`
 * in dry-run mode, and is a loud `{ ok: false }` refusal otherwise (never
 * a silent drop).
 *
 * The DEFAULT adapter is the dry-run printer from `send-adapters.js`:
 * every `dispatchAll` in dev/staging prints what would be sent and
 * receipts carry `dryRun: true`. Set `dryRun: false` and pass real
 * adapters (e.g. from `resolveSendAdapters`) when live delivery begins.
 *
 * ## Failure policy — alerts are never lost
 *
 * An adapter failure (an `{ ok: false }` receipt, a thrown error, or a
 * garbage receipt — all normalized, never re-thrown) does not drop the
 * event: it is retried inside `dispatchAll` up to `maxAttempts` attempts
 * per channel — the primary first, then each fallback channel in order
 * (when `fallbackChannels` is configured), each with a fresh budget.
 * list (returned in the report and readable via `deadLetter()`), where it
 * waits for an operator — or for `redispatchDead()`, which gives every
 * dead letter a fresh set of attempts (e.g. after a broken adapter is
 * fixed or replaced).
 *
 * ## Channel fallback chains
 *
 * `fallbackChannels: { sms: ['email'] }` gives a channel a failover path:
 * when the primary adapter exhausts `maxAttempts` without an `{ ok: true }`
 * receipt, the event moves to the next fallback channel with a fresh
 * attempt budget, and so on down the chain — the first success wins. An
 * alert whose SMS provider is down still reaches the user by email
 * instead of rotting on the dead-letter list. Only exhaustion moves the
 * event down the chain: a retryable failure on the primary is retried on
 * the primary first. Fallback maps are validated at construction —
 * self-loops and cycles throw, because a looping chain would either spin
 * or quietly become a single-channel retry, both of which would hide a
 * real outage from the delivery log. An explicit `channel` override (the
 * `dispatchAll` / `redispatchDead` operator argument) bypasses fallbacks:
 * forced means forced.
 *
 * In dry-run mode the chain never fires: `resolveAdapter` already falls
 * back to the `default` dry-run printer, so every channel "delivers" and
 * the primary receipt is always `{ ok: true, dryRun: true }`.
 *
 * ## Delivery log
 *
 * Every successful delivery writes a durable `alerts` row through
 * `persistence.recordAlert` (user_id, release_id, dispatched_at, and the
 * adapter name in `channels`) — the per-user delivery log: who got what,
 * when, through which adapter.
 *
 * Zero network, no secrets, no dependencies beyond the core modules.
 */

import { assertChannel } from './dispatch.js';
import { createDryRunAdapter } from './send-adapters.js';
import { ENGINE_TO_ALERT_KIND } from './alert-persistence.js';
import { formatDropEmail } from './notify.js';

/** Default retry budget: a failing adapter gets this many attempts per event, per channel, per pass. */
export const DISPATCH_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Validate the channel fallback map (`{ sms: ['email'] }`). Every key is a
 * channel name, every value a non-empty array of fallback channel names.
 * Self-loops and cycles throw — a fallback loop would either spin or
 * silently degrade into a single-channel retry, both of which would hide
 * a real outage from the delivery log.
 * @param {?object} fallbackChannels
 * @returns {Map<string, string[]>} Normalized (deduped) fallback lists.
 */
function normalizeFallbackChannels(fallbackChannels) {
  if (fallbackChannels == null) return new Map();
  if (typeof fallbackChannels !== 'object' || Array.isArray(fallbackChannels)) {
    throw new TypeError(
      `alert dispatcher fallbackChannels must be an object, got ${Array.isArray(fallbackChannels) ? 'array' : typeof fallbackChannels}`,
    );
  }
  const map = new Map();
  for (const [channel, fallbacks] of Object.entries(fallbackChannels)) {
    if (typeof channel !== 'string' || !channel) {
      throw new TypeError(`alert dispatcher fallback channel name must be a non-empty string, got ${JSON.stringify(channel)}`);
    }
    if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
      throw new TypeError(`alert dispatcher fallbacks for '${channel}' must be a non-empty array of channel names`);
    }
    const clean = [];
    for (const fb of fallbacks) {
      if (typeof fb !== 'string' || !fb) {
        throw new TypeError(`alert dispatcher fallback for '${channel}' must be a non-empty string, got ${JSON.stringify(fb)}`);
      }
      if (fb === channel) {
        throw new TypeError(`alert dispatcher fallback for '${channel}' cannot list '${channel}' itself (self-loop)`);
      }
      if (!clean.includes(fb)) clean.push(fb);
    }
    map.set(channel, clean);
  }
  // Cycle check: a → b → a (or longer) would spin the chain walk.
  for (const start of map.keys()) {
    const seen = new Set([start]);
    const stack = [...(map.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === start) {
        throw new TypeError(`alert dispatcher fallbackChannels has a cycle through '${start}' — fallback chains must be acyclic`);
      }
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(...(map.get(next) ?? []));
      }
    }
  }
  return map;
}

/**
 * Default recipient resolution: an explicit `event.to` / `event.email`
 * (or `event.phone` for SMS) wins; otherwise the store's user row for
 * `event.user_id` supplies the address. Returns `null` when nothing is
 * known — the adapters then apply their own address rules (the dry-run
 * and console adapters print/record `to: null`; the wired providers
 * refuse invalid addresses before any socket opens).
 * @param {?object} store A `createStore` store, or null.
 * @returns {(event: object, channelName: string) => ?string}
 */
export function defaultAddressOf(store = null) {
  return (event, channelName) => {
    if (event == null || typeof event !== 'object') return null;
    if (channelName === 'sms') return event.phone ?? event.to ?? null;
    const direct = event.to ?? event.email ?? null;
    if (direct) return direct;
    try {
      const user = store?.users?.find?.((u) => u?.id === event.user_id) ?? null;
      const addr = user?.email ?? null;
      return typeof addr === 'string' && addr ? addr : null;
    } catch {
      return null;
    }
  };
}

/**
 * Compose the sendable message for one engine event, using the same
 * formatter as the plan's alert content (§3: artist, title, price, source
 * link, buy deep link).
 * @param {object} event An engine event (`runEngine` shape).
 * @returns {{ subject: string, text: string }}
 */
export function composeDispatchMessage(event) {
  const alert = {
    kind: ENGINE_TO_ALERT_KIND[event?.kind] ?? 'drop',
    price_cents: event?.price_cents ?? null,
    listing_url: event?.listing_url ?? null,
  };
  return formatDropEmail({
    alert,
    artistName: event?.artist_name ?? 'Unknown artist',
    releaseTitle: event?.title ?? 'Untitled',
  });
}

/**
 * Create a dispatcher.
 *
 * @param {object} input
 * @param {object} input.queue A `createAlertQueue` queue (`drain`, `markSeen`).
 * @param {Record<string, object>} [input.adapters] Channel-name → adapter,
 *   registered at construction (same contract as `registerAdapter`).
 * @param {?object} [input.persistence] A `createAlertPersistence` persistence
 *   (only `recordAlert` is used). Without one, deliveries happen but the
 *   durable delivery log is not written — fine for tests, not for prod.
 * @param {?object} [input.store] Passed to `defaultAddressOf` for recipient
 *   lookup; unused when `addressOf` is given.
 * @param {(event: object, channelName: string) => ?string} [input.addressOf]
 *   Recipient resolver. Defaults to `defaultAddressOf(store)`.
 * @param {boolean} [input.dryRun] Default `true`: the dry-run printer is
 *   the default adapter and unregistered channels fall back to it. Set
 *   `false` only when real adapters are registered.
 * @param {number} [input.maxAttempts] Attempts per event per channel per
 *   dispatch pass before moving to the next fallback channel (or
 *   dead-lettering). Must be a positive integer.
 * @param {?(Object<string, string[]>)} [input.fallbackChannels] Failover
 *   map, e.g. `{ sms: ['email'] }`: when a channel exhausts `maxAttempts`
 *   without delivery, the event is attempted through each fallback in
 *   order, each with a fresh budget. Validated at construction (no
 *   self-loops, no cycles). An explicit `channel` override in
 *   `dispatchAll`/`redispatchDead` bypasses fallbacks.
 * @param {() => number} [input.now] Clock, defaults to `Date.now`.
 * @param {{ write: Function }} [input.out] Writer for the dry-run adapter.
 * @returns {{ registerAdapter: Function, dispatchAll: Function, redispatchDead: Function, deadLetter: Function, adapters: Function, stats: Function }}
 */
export function createAlertDispatcher({
  queue,
  adapters = {},
  persistence = null,
  store = null,
  addressOf = null,
  dryRun = true,
  maxAttempts = DISPATCH_DEFAULT_MAX_ATTEMPTS,
  fallbackChannels = null,
  now = () => Date.now(),
  out = process.stdout,
} = {}) {
  if (!queue || typeof queue.drain !== 'function' || typeof queue.markSeen !== 'function') {
    throw new TypeError('alert dispatcher needs a queue with drain and markSeen');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`alert dispatcher needs a positive integer maxAttempts, got ${maxAttempts}`);
  }
  const fallbackMap = normalizeFallbackChannels(fallbackChannels);
  if (persistence != null && typeof persistence.recordAlert !== 'function') {
    throw new TypeError('alert dispatcher persistence needs a recordAlert function');
  }

  const resolveAddress = typeof addressOf === 'function' ? addressOf : defaultAddressOf(store);
  const registry = new Map();
  const dead = [];
  let deliveredCount = 0;

  /**
   * Register (or replace) the adapter for a channel name. The adapter is
   * validated against the `dispatch.js` channel contract at registration
   * time, so a bad adapter fails loudly here — not mid-dispatch.
   * @param {string} name Channel name (`'default'`, `'email'`, `'sms'`, …).
   * @param {object} adapter `{ name, kind, send(envelope) }`.
   * @returns {object} The registered adapter.
   */
  function registerAdapter(name, adapter) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError(`adapter name must be a non-empty string, got ${String(name)}`);
    }
    assertChannel(adapter, `dispatch adapter '${name}'`);
    registry.set(name, adapter);
    return adapter;
  }

  if (dryRun) registerAdapter('default', createDryRunAdapter({ out }));
  for (const [name, adapter] of Object.entries(adapters ?? {})) registerAdapter(name, adapter);

  function resolveAdapter(channelName) {
    if (registry.has(channelName)) return registry.get(channelName);
    if (dryRun) return registry.get('default') ?? null;
    return null;
  }

  function missingAdapterReceipt(channelName, at) {
    return {
      ok: false,
      channel: channelName,
      error:
        `NO ADAPTER — no adapter registered for channel '${channelName}' ` +
        `(registered: ${[...registry.keys()].join(', ') || 'none'}). ` +
        `Call registerAdapter('${channelName}', adapter) or run with dryRun: true.`,
      sentAt: new Date(at).toISOString(),
    };
  }

  /**
   * Ordered channel attempt list for one event: the primary first, then
   * its fallbacks walked transitively (`sms → email`, `email → push` gives
   * `[sms, email, push]`), deduped. Cycle-proof by construction — the
   * constructor rejects cyclic maps, and the visited set guards anyway.
   * @param {string} channelName
   * @returns {string[]}
   */
  function channelChain(channelName) {
    const chain = [];
    const seen = new Set();
    const pending = [channelName];
    while (pending.length > 0) {
      const next = pending.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      chain.push(next);
      for (const fb of fallbackMap.get(next) ?? []) {
        if (!seen.has(fb)) pending.push(fb);
      }
    }
    return chain;
  }

  /**
   * One send attempt through one channel's adapter. Never throws: a
   * throwing adapter becomes an `{ ok: false }` receipt, and a non-object
   * receipt becomes a refusal — both feed the retry path instead of
   * crashing the run. No side effects: the chain walker decides what a
   * successful delivery means.
   * @param {object} event
   * @param {string} channelName
   * @returns {Promise<{ channel: string, adapter: string, to: ?string, receipt: object, delivered: boolean }>}
   */
  async function attemptChannel(event, channelName) {
    const at = now();
    const adapter = resolveAdapter(channelName);
    if (!adapter) {
      return { channel: channelName, adapter: channelName, to: null, receipt: missingAdapterReceipt(channelName, at), delivered: false };
    }
    const to = resolveAddress(event, adapter.name);
    const envelope = {
      alert: {
        kind: ENGINE_TO_ALERT_KIND[event?.kind] ?? 'drop',
        price_cents: event?.price_cents ?? null,
        listing_url: event?.listing_url ?? null,
      },
      channel: adapter.name,
      to,
      message: composeDispatchMessage(event),
      nowMs: at,
      // Carries the recipient's unsubscribe token when the caller knows it
      // (e.g. from the alert_subscriptions row). Channels that build
      // per-recipient List-Unsubscribe links (see the Resend channel's
      // unsubscribeUrl resolver) read this; `null` means "no token, no link".
      unsubscribe_token: event?.unsubscribe_token ?? null,
    };
    let receipt;
    try {
      receipt = await adapter.send(envelope);
    } catch (err) {
      receipt = {
        ok: false,
        channel: adapter.name,
        error: `ADAPTER THREW — ${err?.message ?? String(err)}`,
        sentAt: new Date(at).toISOString(),
      };
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      receipt = {
        ok: false,
        channel: adapter.name,
        error: 'ADAPTER RECEIPT INVALID — send() must resolve to a receipt object',
        sentAt: new Date(at).toISOString(),
      };
    }
    const delivered = receipt.ok === true;
    return { channel: channelName, adapter: adapter.name, to, receipt, delivered };
  }

  /**
   * Deliver one event down the channel fallback chain. The primary
   * channel is attempted up to `maxAttempts` times; only exhaustion moves
   * the event to the next fallback channel, which gets a fresh budget.
   * The first `{ ok: true }` wins — a successful delivery re-marks the
   * seen-set and writes the durable delivery-log row (when `persistence`
   * is present), exactly once, through the delivering adapter's name.
   * @param {object} event
   * @param {{ channelName: string, allowFallback?: boolean }} input
   * @returns {Promise<{ event: object, receipt: object, delivered: boolean, adapter: string, to: ?string, attempts: number, attemptedChannels: string[], attempted: Array }>}
   */
  async function sendEvent(event, { channelName, allowFallback = true }) {
    const chain = allowFallback ? channelChain(channelName) : [channelName];
    const attempted = [];
    let attempts = 0;
    for (const name of chain) {
      let channelAttempts = 0;
      while (channelAttempts < maxAttempts) {
        channelAttempts += 1;
        attempts += 1;
        const attempt = await attemptChannel(event, name);
        attempted.push(attempt);
        if (attempt.delivered) {
          queue.markSeen({ user_id: event?.user_id, release_id: event?.release_id });
          if (persistence) await persistence.recordAlert(event, { channels: [attempt.receipt.channel ?? attempt.adapter], now });
          deliveredCount += 1;
          return finishSend(event, attempted, attempts, true);
        }
      }
    }
    return finishSend(event, attempted, attempts, false);
  }

  /**
   * Shape one `sendEvent` outcome for the batch report: the last attempt's
   * receipt/adapter/to stay top-level (same contract as before the chain
   * existed), with the full per-channel trail (`attempted`) and the
   * ordered channel list (`attemptedChannels`) alongside for operators.
   */
  function finishSend(event, attempted, attempts, delivered) {
    const last = attempted[attempted.length - 1];
    return {
      event,
      receipt: last.receipt,
      delivered,
      adapter: last.adapter,
      to: last.to,
      attempts,
      attemptedChannels: [...new Set(attempted.map((a) => a.channel))],
      attempted,
    };
  }

  /**
   * Run one batch of items to completion: each channel in an event's
   * fallback chain gets up to `maxAttempts`. An explicit `channel`
   * override bypasses fallbacks — forced means forced. Events that
   * exhaust every channel land on the dead-letter list with their channel
   * trail, never silently dropped.
   */
  async function runBatch(items, { channel = null } = {}) {
    const delivered = [];
    const failed = [];
    for (const item of items) {
      const channelName = channel ?? item.event?.channel ?? 'default';
      const result = await sendEvent(item.event, { channelName, allowFallback: channel == null });
      item.attempts = result.attempts;
      if (result.delivered) {
        delivered.push(result);
      } else {
        const entry = { event: item.event, receipt: result.receipt, attempts: result.attempts, attemptedChannels: result.attemptedChannels };
        failed.push(entry);
        dead.push(entry);
      }
    }
    return { delivered, failed };
  }

  /**
   * Drain up to `limit` events from the queue (priority order, per the
   * queue's contract) and deliver them. Failed events retry in-process up
   * to `maxAttempts` and then dead-letter — nothing is ever silently
   * dropped.
   * @param {object} [input]
   * @param {number} [input.limit] Max events to drain this pass.
   * @param {?string} [input.channel] Force every event through one channel.
   * @returns {Promise<{ dryRun: boolean, drained: number, delivered: Array, failed: Array }>}
   */
  async function dispatchAll({ limit = Infinity, channel = null } = {}) {
    const drained = queue.drain(limit);
    const items = drained.map((event) => ({ event, attempts: 0 }));
    const { delivered, failed } = await runBatch(items, { channel });
    return { dryRun, drained: drained.length, delivered, failed };
  }

  /**
   * Give every dead-lettered event a fresh attempt budget (same channel
   * resolution as `dispatchAll`). The operator's "try again now that the
   * adapter is fixed" button.
   */
  async function redispatchDead({ channel = null } = {}) {
    const items = dead.splice(0).map(({ event }) => ({ event, attempts: 0 }));
    return runBatch(items, { channel });
  }

  /** The current dead-letter list — events that exhausted every retry. */
  function deadLetter() {
    return dead.map((entry) => ({ ...entry }));
  }

  /** Registered channel names. */
  function adapterNames() {
    return [...registry.keys()];
  }

  function stats() {
    return {
      dryRun,
      adapters: adapterNames(),
      delivered: deliveredCount,
      dead: dead.length,
      maxAttempts,
    };
  }

  return { registerAdapter, dispatchAll, redispatchDead, deadLetter, adapters: adapterNames, stats };
}
