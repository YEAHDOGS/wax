/**
 * Regression tests for the delivery and catalog-source adapters.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelAdapter,
  RecordingAdapter,
  ConsoleAdapter,
  dispatch,
  FixtureSource,
  makeSnapshot,
  makeRule,
  evaluate,
} from '../src/index.js';

const NOW = '2026-09-10T12:00:00.000Z';

describe('RecordingAdapter', () => {
  it('records sends and reports ok', async () => {
    const adapter = new RecordingAdapter('email');
    assert.equal(adapter.name, 'email');
    const alert = { kind: 'drop', release_id: 'rel_a' };
    const res = await adapter.send(alert);
    assert.equal(res.ok, true);
    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].alert, alert);
    adapter.reset();
    assert.equal(adapter.sent.length, 0);
  });

  it('abstract base refuses to send', async () => {
    const base = new ChannelAdapter();
    await assert.rejects(() => base.send({}), /abstract/);
    assert.throws(() => base.name, /abstract/);
  });
});

describe('ConsoleAdapter', () => {
  it('sends without throwing and defaults to push', async () => {
    const adapter = new ConsoleAdapter();
    assert.equal(adapter.name, 'push');
    const res = await adapter.send({ kind: 'drop', release_id: 'rel_a', price_cents: null });
    assert.equal(res.ok, true);
  });
});

describe('dispatch', () => {
  const alertFor = (ruleId) => ({
    kind: 'drop',
    rule_id: ruleId,
    user_id: 'usr_1',
    release_id: 'rel_a',
    detected_at: NOW,
  });

  it('routes each alert to the adapters matching its rule channels', async () => {
    const rule = makeRule({ id: 'wtc_1', channels: ['email', 'push'] });
    const email = new RecordingAdapter('email');
    const push = new RecordingAdapter('push');
    const receipts = await dispatch(
      [alertFor('wtc_1')],
      new Map([['wtc_1', rule]]),
      new Map([['email', email], ['push', push]]),
    );
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.ok));
    assert.equal(email.sent.length, 1);
    assert.equal(push.sent.length, 1);
  });

  it('reports no_adapter when a channel has no adapter', async () => {
    const rule = makeRule({ id: 'wtc_1', channels: ['sms'] });
    const receipts = await dispatch([alertFor('wtc_1')], new Map([['wtc_1', rule]]), new Map());
    assert.equal(receipts[0].ok, false);
    assert.match(receipts[0].error, /no_adapter:sms/);
  });

  it('turns adapter exceptions into error receipts', async () => {
    const bad = {
      name: 'email',
      send: async () => {
        throw new Error('provider down');
      },
    };
    const rule = makeRule({ id: 'wtc_1', channels: ['email'] });
    const receipts = await dispatch(
      [alertFor('wtc_1')],
      new Map([['wtc_1', rule]]),
      new Map([['email', bad]]),
    );
    assert.equal(receipts[0].ok, false);
    assert.match(receipts[0].error, /provider down/);
  });

  it('defaults to push when the rule names no channels', async () => {
    const rule = makeRule({ id: 'wtc_1', channels: [] });
    const push = new RecordingAdapter('push');
    const receipts = await dispatch(
      [alertFor('wtc_1')],
      new Map([['wtc_1', rule]]),
      new Map([['push', push]]),
    );
    assert.equal(receipts[0].channel, 'push');
    assert.equal(push.sent.length, 1);
  });
});

describe('FixtureSource', () => {
  it('replays snapshots in order, then holds the last', async () => {
    const a = makeSnapshot({ taken_at: '2026-09-10T10:00:00.000Z' });
    const b = makeSnapshot({ taken_at: '2026-09-10T11:00:00.000Z' });
    const source = new FixtureSource([a, b]);
    assert.equal((await source.poll()).taken_at, a.taken_at);
    assert.equal((await source.poll()).taken_at, b.taken_at);
    assert.equal((await source.poll()).taken_at, b.taken_at);
    assert.equal(source.calls, 3);
  });

  it('drives the evaluator end-to-end without network', async () => {
    const source = new FixtureSource([makeSnapshot(), makeSnapshot()]);
    const prev = await source.poll();
    const next = await source.poll();
    const { alerts } = evaluate([], prev, next, { now: NOW });
    assert.deepEqual(alerts, []);
  });
});
