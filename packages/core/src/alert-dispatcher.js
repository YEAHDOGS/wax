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
 * event: it is retried inside `dispatchAll` up to `maxAttempts` total
 * attempts. An event that exhausts its attempts lands on the dead-letter
 * list (returned in the report and readable via `deadLetter()`), where it
 * waits for an operator — or for `redispatchDead()`, which gives every
 * dead letter a fresh set of attempts (e.g. after a broken adapter is
 * fixed or replaced).
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

/** Default retry budget: a failing adapter gets this many attempts per event, per pass. */
export const DISPATCH_DEFAULT_MAX_ATTEMPTS = 3;

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
 * @param {number} [input.maxAttempts] Attempts per event per dispatch pass
 *   before dead-lettering. Must be a positive integer.
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
  now = () => Date.now(),
  out = process.stdout,
} = {}) {
  if (!queue || typeof queue.drain !== 'function' || typeof queue.markSeen !== 'function') {
    throw new TypeError('alert dispatcher needs a queue with drain and markSeen');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`alert dispatcher needs a positive integer maxAttempts, got ${maxAttempts}`);
  }
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
   * Deliver one event through one adapter. Never throws: a throwing
   * adapter becomes an `{ ok: false }` receipt, and a non-object receipt
   * becomes a refusal — both feed the retry path instead of crashing the
   * run. A successful delivery re-marks the seen-set and writes the
   * durable delivery-log row (when `persistence` is present).
   */
  async function sendEvent(event, { channelName }) {
    const at = now();
    const adapter = resolveAdapter(channelName);
    if (!adapter) {
      return { event, receipt: missingAdapterReceipt(channelName, at), delivered: false, adapter: channelName, to: null };
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
    if (delivered) {
      queue.markSeen({ user_id: event?.user_id, release_id: event?.release_id });
      if (persistence) await persistence.recordAlert(event, { channels: [receipt.channel ?? adapter.name], now });
      deliveredCount += 1;
    }
    return { event, receipt, delivered, adapter: adapter.name, to };
  }

  /** Run one batch of items to completion: up to `maxAttempts` each. */
  async function runBatch(items, { channel = null } = {}) {
    const delivered = [];
    const failed = [];
    for (const item of items) {
      const channelName = channel ?? item.event?.channel ?? 'default';
      let result = null;
      while (item.attempts < maxAttempts) {
        item.attempts += 1;
        result = await sendEvent(item.event, { channelName });
        if (result.delivered) break;
      }
      if (result.delivered) {
        delivered.push(result);
      } else {
        const entry = { event: item.event, receipt: result.receipt, attempts: item.attempts };
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
