/**
 * Delivery and catalog-source adapters.
 *
 * Delivery is an interface, not a vendor. The MVP ships:
 * - `RecordingAdapter` — test double that records sends in memory.
 * - `ConsoleAdapter`   — dev stub that logs instead of sending.
 *
 * Real provider adapters (Resend for email, Twilio for SMS) land with the
 * polling loop. `dispatch()` routes each alert to the adapters matching the
 * rule's channels and stamps `dispatched_at` — the gap between that and
 * `detected_at` is the product's headline metric.
 *
 * The catalog source side is also an interface: `CatalogSource.poll(scope)`
 * returns a Snapshot. The MVP ships `FixtureSource` only. The live Discogs
 * adapter must honor the rate budget (see docs/ALERT-ENGINE-PLAN.md cadence)
 * and will never be called from the evaluation core.
 */

/**
 * @typedef {object} SendResult
 * @property {boolean} ok
 * @property {?string} messageId
 * @property {?string} error
 */

/**
 * The delivery contract. Every real channel adapter implements this.
 *
 * @interface
 */
export class ChannelAdapter {
  /** @type {'email'|'sms'|'push'} */
  get name() {
    throw new Error('ChannelAdapter.name is abstract');
  }
  /** @param {import('./types.js').AlertCandidate} alert @returns {Promise<SendResult>} */
  async send(alert) {
    throw new Error('ChannelAdapter.send is abstract');
  }
}

/** Test double: records every send, always succeeds. */
export class RecordingAdapter extends ChannelAdapter {
  /**
   * @param {'email'|'sms'|'push'} name
   */
  constructor(name = 'push') {
    super();
    this._name = name;
    /** @type {{ alert: import('./types.js').AlertCandidate, at: string }[]} */
    this.sent = [];
  }
  get name() {
    return this._name;
  }
  async send(alert) {
    const at = new Date().toISOString();
    this.sent.push({ alert, at });
    return { ok: true, messageId: `rec_${this.sent.length}`, error: null };
  }
  reset() {
    this.sent = [];
  }
}

/** Dev stub: logs to stdout instead of sending. Never used in tests. */
export class ConsoleAdapter extends ChannelAdapter {
  constructor(name = 'push') {
    super();
    this._name = name;
  }
  get name() {
    return this._name;
  }
  async send(alert) {
    console.log(`[wax:${this._name}] ${alert.kind} ${alert.release_id} ${alert.price_cents ?? ''}`.trim());
    return { ok: true, messageId: `console_${Date.now()}`, error: null };
  }
}

/**
 * Route alert candidates to the adapters matching each rule's channels.
 * Mutates nothing on the candidates; returns delivery receipts.
 *
 * @param {import('./types.js').AlertCandidate[]} alerts
 * @param {Map<string, import('./types.js').AlertRule>} ruleById
 * @param {Map<string, ChannelAdapter>} adaptersByChannel  e.g. email -> adapter
 * @returns {Promise<{ alert: import('./types.js').AlertCandidate, channel: string,
 *                      ok: boolean, messageId: ?string, error: ?string }[]>}
 */
export async function dispatch(alerts, ruleById, adaptersByChannel) {
  const receipts = [];
  for (const alert of alerts) {
    const rule = ruleById.get(alert.rule_id);
    const channels = rule?.channels?.length ? rule.channels : ['push'];
    for (const channel of channels) {
      const adapter = adaptersByChannel.get(channel);
      if (!adapter) {
        receipts.push({ alert, channel, ok: false, messageId: null, error: `no_adapter:${channel}` });
        continue;
      }
      try {
        const res = await adapter.send(alert);
        receipts.push({ alert, channel, ...res });
      } catch (err) {
        receipts.push({ alert, channel, ok: false, messageId: null, error: String(err?.message ?? err) });
      }
    }
  }
  return receipts;
}

/**
 * The catalog contract: poll a watched scope, get back a Snapshot.
 * The live Discogs implementation is NOT here — network stays out of the
 * evaluation core. Shape it must implement:
 *
 *   class DiscogsSource {
 *     async poll({ scope_type, scope_id }) -> Snapshot
 *   }
 *
 * Respect the polling budget (60 req/min unauthenticated): hot rules 5 min,
 * warm 15 min, cool 60 min, cold 6 h. See docs/ALERT-ENGINE-PLAN.md.
 */

/**
 * Fixture source: returns prebuilt snapshots in sequence, then repeats the
 * last. Lets the evaluator run end-to-end without any network.
 */
export class FixtureSource {
  /**
   * @param {import('./types.js').Snapshot[]} snapshots
   */
  constructor(snapshots) {
    this._snapshots = snapshots;
    this._calls = 0;
  }
  /** @returns {Promise<import('./types.js').Snapshot>} */
  async poll() {
    const snap = this._snapshots[Math.min(this._calls, this._snapshots.length - 1)];
    this._calls += 1;
    return structuredClone(snap);
  }
  get calls() {
    return this._calls;
  }
}
