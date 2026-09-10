/**
 * Smoke/regression check for the alert-engine restart recipe against the
 * Postgres store (ALERT-ENGINE-PLAN.md §4, the "persist prevStates + the
 * queue's seen-set in Postgres with the `alerts` table" step).
 *
 * `alert-persistence.js` claims to work against the Postgres store
 * unchanged; `store-postgres.js` claims the same Collection contract over
 * SQL. This file pins that handshake with exact SQL assertions over a
 * fake client — no live DB, no network:
 *
 * 1. `savePrevStates` INSERTs `engine_state` rows with the `state` object
 *    JSON-encoded (the composite PK is `(user_id, state_key)`).
 * 2. A re-save UPDATEs the existing composite-key row (SET + composite
 *    WHERE), never INSERTs a duplicate.
 * 3. `loadPrevStates` SELECTs `engine_state` and rebuilds the exact
 *    `prevStateKey` entries `runEngine` consumes.
 * 4. `recordAlert` INSERTs durable `alerts` rows with the engine→board
 *    kind mapping (new→drop, price_drop→price, restock→restock).
 * 5. `restoreQueueSeen` replays dispatched `alerts` rows into the queue's
 *    seen-set — a re-enqueue after replay is a dupe, never a resend.
 * 6. Hostile user ids / state keys travel only in `$n` params, never
 *    interpolated into SQL text.
 *
 * If any of them fail, the Postgres swap would re-alert every user on the
 * first restart — the exact flood the persistence layer exists to prevent.
 *
 * Run: `node --test packages/core/test-alert-persistence-postgres.mjs`
 * Zero dependencies beyond the Node standard library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresStore } from './src/store-postgres.js';
import {
  ENGINE_STATE_KEY_SEP,
  ENGINE_TO_ALERT_KIND,
  createAlertPersistence,
} from './src/alert-persistence.js';
import { createAlertQueue } from './src/alert-queue.js';
import { prevStateKey } from './src/alert-engine.js';

/** Fake pg-compatible client: records every query, answers from canned rows. */
function fakeClient() {
  const calls = [];
  const canned = [];
  const client = {
    calls,
    /** Queue canned rows for the next query whose text includes `match`. */
    respond(match, rows) {
      canned.push({ match, rows });
      return client;
    },
    async query(text, params = []) {
      calls.push({ text, params });
      const hit = canned.find((c) => text.includes(c.match));
      return { rows: hit ? hit.rows : [] };
    },
  };
  return client;
}

function makePersistence(client) {
  const store = createPostgresStore({ client });
  return { store, persistence: createAlertPersistence(store) };
}

const STATE = { price_cents: 4500, in_stock: true, seen_at: '2026-09-09T10:00:00.000Z' };

function insertCall(client, table) {
  return client.calls.find((c) => c.text.startsWith(`INSERT INTO "${table}"`));
}

test('savePrevStates INSERTs engine_state rows with jsonb-encoded state', async () => {
  const client = fakeClient();
  const { persistence } = makePersistence(client);
  const key = `usr_1${ENGINE_STATE_KEY_SEP}9900210`;
  const upserted = await persistence.savePrevStates({ [key]: STATE });
  assert.equal(upserted, 1);

  const call = insertCall(client, 'engine_state');
  assert.ok(call, 'expected an INSERT INTO "engine_state"');
  assert.equal(
    call.text,
    'INSERT INTO "engine_state" ("user_id", "state_key", "state", "updated_at") VALUES ($1, $2, $3, $4) RETURNING *',
  );
  assert.equal(call.params[0], 'usr_1');
  assert.equal(call.params[1], '9900210');
  assert.equal(call.params[2], JSON.stringify(STATE));
  assert.equal(new Date(call.params[3]).toISOString(), call.params[3]);
});

test('re-save UPDATEs the existing composite-key row, never duplicates', async () => {
  const client = fakeClient().respond('FROM "engine_state"', [
    { user_id: 'usr_1', state_key: '9900210', state: STATE, updated_at: new Date('2026-09-09T10:00:00.000Z') },
  ]);
  const { persistence } = makePersistence(client);
  const key = `usr_1${ENGINE_STATE_KEY_SEP}9900210`;
  const next = { ...STATE, price_cents: 3000 };
  const upserted = await persistence.savePrevStates({ [key]: next });
  assert.equal(upserted, 1);

  assert.equal(insertCall(client, 'engine_state'), undefined);
  const upd = client.calls.find((c) => c.text.startsWith('UPDATE "engine_state"'));
  assert.ok(upd, 'expected an UPDATE "engine_state"');
  assert.equal(
    upd.text,
    'UPDATE "engine_state" SET "state" = $1, "updated_at" = $2 WHERE "user_id" = $3 AND "state_key" = $4 RETURNING *',
  );
  assert.equal(upd.params[0], JSON.stringify(next));
  assert.equal(upd.params[2], 'usr_1');
  assert.equal(upd.params[3], '9900210');
});

test('loadPrevStates SELECTs engine_state and rebuilds prevStateKey entries', async () => {
  const client = fakeClient().respond('FROM "engine_state"', [
    {
      user_id: 'usr_1',
      state_key: '9900210',
      state: STATE,
      updated_at: new Date('2026-09-09T10:00:00.000Z'), // driver Date must not corrupt the key
    },
    {
      user_id: 'usr_1',
      state_key: 'benji::madvillainy',
      state: { price_cents: null, in_stock: false, seen_at: 'x' },
      updated_at: new Date('2026-09-09T10:01:00.000Z'),
    },
  ]);
  const { persistence } = makePersistence(client);
  const loaded = await persistence.loadPrevStates();

  assert.ok(
    client.calls.some((c) => c.text === 'SELECT * FROM "engine_state"'),
    'expected a SELECT * FROM "engine_state"',
  );
  assert.deepEqual(loaded, {
    [prevStateKey('usr_1', { id: '9900210' })]: STATE,
    [prevStateKey('usr_1', { id: 'benji::madvillainy' })]: {
      price_cents: null,
      in_stock: false,
      seen_at: 'x',
    },
  });
});

test('recordAlert INSERTs durable alerts rows with the engine→board kind mapping', async () => {
  const cases = [
    ['new', 'drop'],
    ['price_drop', 'price'],
    ['restock', 'restock'],
    ['bogus-kind', 'drop'],
  ];
  for (const [engineKind, boardKind] of cases) {
    const client = fakeClient().respond('INSERT INTO "alerts"', [{ id: 'alr_echo', user_id: 'usr_1' }]);
    const { persistence } = makePersistence(client);
    const row = await persistence.recordAlert(
      {
        user_id: 'usr_1',
        release_id: 'rel_9',
        want_id: 'want_2',
        kind: engineKind,
        listing_url: 'https://shop.example/vinyl/rel9',
        price_cents: 4500,
        matched_at: '2026-09-09T10:00:00.000Z',
      },
      { channels: ['email'], now: () => new Date('2026-09-09T11:00:00.000Z').getTime() },
    );
    assert.equal(row.id, 'alr_echo');

    const call = insertCall(client, 'alerts');
    assert.ok(call, `expected an INSERT INTO "alerts" for ${engineKind}`);
    const params = Object.fromEntries(
      call.text.match(/"(\w+)"/g).slice(1).map((q, i) => [q.slice(1, -1), call.params[i]]),
    );
    assert.equal(params.kind, boardKind, `kind mapping for ${engineKind}`);
    assert.equal(params.user_id, 'usr_1');
    assert.equal(params.release_id, 'rel_9');
    assert.equal(params.watch_id, 'want_2');
    assert.equal(params.state, 'live');
    assert.deepEqual(params.channels, ['email']);
    assert.match(params.id, /^alr_/);
    assert.equal(ENGINE_TO_ALERT_KIND[engineKind] ?? 'drop', boardKind);
  }
});

test('restoreQueueSeen replays dispatched alerts into the queue — no resend after restart', async () => {
  const client = fakeClient().respond('FROM "alerts"', [
    { id: 'alr_1', user_id: 'usr_1', release_id: 'rel_9', kind: 'drop' },
    { id: 'alr_2', user_id: 'usr_1', release_id: 'rel_10', kind: 'price' },
    { id: 'alr_3', user_id: 'usr_2', release_id: null }, // malformed: replayed count skips it
  ]);
  const { persistence } = makePersistence(client);
  const queue = createAlertQueue();
  const restored = await persistence.restoreQueueSeen(queue);
  assert.equal(restored, 2);

  const outcome = queue.enqueue([
    { user_id: 'usr_1', release_id: 'rel_9', kind: 'new' },
    { user_id: 'usr_1', release_id: 'rel_10', kind: 'new' },
    { user_id: 'usr_1', release_id: 'rel_11', kind: 'new' },
  ]);
  assert.equal(outcome.dupes.length, 2, 'replayed user+release pairs must not re-queue');
  assert.equal(outcome.queued.length, 1);
  assert.equal(outcome.queued[0].release_id, 'rel_11');
});

test('hostile user ids and state keys travel in $n params, never interpolated', async () => {
  const hostileUser = 'usr_1" OR "1"="1';
  const hostileKey = '9900"); DROP TABLE users; --';
  const client = fakeClient();
  const { persistence } = makePersistence(client);
  const upserted = await persistence.savePrevStates({
    [`${hostileUser}${ENGINE_STATE_KEY_SEP}${hostileKey}`]: STATE,
  });
  assert.equal(upserted, 1);

  for (const { text } of client.calls) {
    assert.ok(!text.includes(hostileUser), `SQL text must not contain hostile user id: ${text}`);
    assert.ok(!text.includes(hostileKey), `SQL text must not contain hostile state key: ${text}`);
  }
  const call = insertCall(client, 'engine_state');
  assert.equal(call.params[0], hostileUser);
  assert.equal(call.params[1], hostileKey);
});
