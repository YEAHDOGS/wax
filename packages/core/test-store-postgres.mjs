/**
 * Smoke/regression check for `packages/core/src/store-postgres.js` —
 * the actual Postgres `store.js` swap (ALERT-ENGINE-PLAN.md §4).
 *
 * Run: `node --test packages/core/test-store-postgres.mjs`
 * Zero dependencies beyond the Node standard library, and — by design —
 * zero network: the pg client is injected, so every test runs against a
 * fake client that records the SQL and returns canned rows. This pins
 * the properties the swap exists for:
 *
 * 1. Constructor guards: no client (or a client without `query`) throws —
 *    a half-wired store must never silently behave like the in-memory one.
 * 2. The table map covers all 20 collections with the right Postgres
 *    tables and key columns (composite keys for `follows` and
 *    `engine_state`, token-keyed `sessions`, jsonb columns where the
 *    schema says jsonb).
 * 3. The full Collection contract over SQL: all/find/filter/insert/
 *    update/remove/count — with exact SQL text assertions.
 * 4. Security: user data travels only in `$n` parameters, never
 *    interpolated into SQL; identifiers come from the fixed map or
 *    validated row keys, and a hostile row key throws instead of
 *    smuggling SQL.
 * 5. JSON-safety: `Date` rows come back as ISO strings (matching the
 *    in-memory store's clones), jsonb columns are JSON-encoded on write,
 *    and `undefined` keys are skipped so DB defaults apply.
 * 6. The async store helpers (`createSession`, `userForToken`,
 *    `endSession`, `latestPrice`) mirror the in-memory store's logic —
 *    including lazy expiry sweeps.
 *
 * If any of them fail, the swap is not drop-in and must not ship.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresStore, sqlCollection, POSTGRES_TABLES } from './src/store-postgres.js';

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

const spec = (name) => POSTGRES_TABLES[name];

// --- 1. constructor guards -------------------------------------------------

test('createPostgresStore throws without a client or without query', () => {
  assert.throws(() => createPostgresStore(), TypeError);
  assert.throws(() => createPostgresStore({}), TypeError);
  assert.throws(() => createPostgresStore({ client: {} }), TypeError);
  assert.throws(() => sqlCollection(null, spec('users')), TypeError);
  assert.throws(() => sqlCollection({}, spec('users')), TypeError);
});

test('sqlCollection rejects a non-identifier table at construction', () => {
  const client = fakeClient();
  assert.throws(() => sqlCollection(client, { table: 'users; DROP TABLE users; --', key: 'id' }), /unsafe/);
});

// --- 2. table map -----------------------------------------------------------

test('POSTGRES_TABLES covers all 20 collections with the schema.sql tables and keys', () => {
  const expected = {
    users: ['users', 'id'],
    profiles: ['profiles', 'user_id'],
    follows: ['follows', ['follower_id', 'followee_id']],
    artists: ['artists', 'id'],
    releases: ['releases', 'id'],
    tracks: ['tracks', 'id'],
    sources: ['sources', 'id'],
    scanLogs: ['scan_logs', 'id'],
    scanSnapshots: ['scan_snapshots', 'source_id'],
    digestQueue: ['digest_queue', 'id'],
    subscriptions: ['alert_subscriptions', 'id'],
    subscribeAttempts: ['subscribe_attempt', 'id'],
    watches: ['watches', 'id'],
    alerts: ['alerts', 'id'],
    crateItems: ['crate_items', 'id'],
    wantlistItems: ['wantlist_items', 'id'],
    pricePoints: ['price_points', 'id'],
    activity: ['activity', 'id'],
    engineStates: ['engine_state', ['user_id', 'state_key']],
    sessions: ['sessions', 'token'],
  };
  assert.deepEqual(Object.keys(POSTGRES_TABLES).sort(), Object.keys(expected).sort());
  for (const [name, [table, key]] of Object.entries(expected)) {
    assert.equal(POSTGRES_TABLES[name].table, table, name);
    assert.deepEqual(POSTGRES_TABLES[name].key, key, name);
  }
  assert.deepEqual(POSTGRES_TABLES.subscriptions.jsonb.sort(), ['confirm_receipt', 'filter']);
  assert.deepEqual(POSTGRES_TABLES.engineStates.jsonb, ['state']);
});

// --- 3. Collection contract -------------------------------------------------

test('all() issues a bare SELECT * and normalizes Dates to ISO strings', async () => {
  const client = fakeClient().respond('FROM "users"', [
    { id: 'usr_1', plan: 'free', created_at: new Date('2026-09-09T12:00:00.000Z') },
  ]);
  const store = createPostgresStore({ client });
  const rows = await store.users.all();
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].text, 'SELECT * FROM "users"');
  assert.equal(rows[0].created_at, '2026-09-09T12:00:00.000Z');
});

test('find/filter run the predicate in JS — no predicate text reaches SQL', async () => {
  const client = fakeClient().respond('FROM "alerts"', [
    { id: 'alr_1', user_id: 'usr_1' },
    { id: 'alr_2', user_id: 'usr_2' },
  ]);
  const store = createPostgresStore({ client });
  // A hostile value must not be able to smuggle anything into the SQL text.
  const evil = `usr_1' OR '1'='1`;
  const one = await store.alerts.find((r) => r.user_id === evil);
  assert.equal(one, undefined);
  assert.equal(client.calls[0].text, 'SELECT * FROM "alerts"');
  const many = await store.alerts.filter((r) => r.id.startsWith('alr_'));
  assert.equal(many.length, 2);
});

test('insert builds parameterized SQL in column order and returns RETURNING *', async () => {
  const client = fakeClient().respond('INSERT INTO "users"', [
    { id: 'usr_9', email: 'a@b.c', created_at: new Date('2026-09-09T12:00:00.000Z') },
  ]);
  const store = createPostgresStore({ client });
  const row = await store.users.insert({ id: 'usr_9', email: 'a@b.c', nick: undefined });
  assert.equal(client.calls.length, 1);
  assert.equal(
    client.calls[0].text,
    'INSERT INTO "users" ("id", "email") VALUES ($1, $2) RETURNING *',
  );
  assert.deepEqual(client.calls[0].params, ['usr_9', 'a@b.c']);
  assert.equal(row.created_at, '2026-09-09T12:00:00.000Z'); // DB default came back resolved
});

test('insert JSON-stringifies jsonb columns and refuses an empty row', async () => {
  const client = fakeClient().respond('INSERT INTO "alert_subscriptions"', [{ id: 'sub_1' }]);
  const store = createPostgresStore({ client });
  await store.subscriptions.insert({
    id: 'sub_1',
    filter: { artist_id: 'art_1', max_price_cents: 4000 },
    channel: 'email',
  });
  const { text, params } = client.calls[0];
  assert.equal(
    text,
    'INSERT INTO "alert_subscriptions" ("id", "filter", "channel") VALUES ($1, $2, $3) RETURNING *',
  );
  assert.equal(params[1], JSON.stringify({ artist_id: 'art_1', max_price_cents: 4000 }));
  await assert.rejects(store.users.insert({}), /empty row/);
});

test('update merges the first match by key, or returns undefined with no extra query', async () => {
  const client = fakeClient()
    .respond('FROM "users"', [
      { id: 'usr_1', plan: 'free' },
      { id: 'usr_2', plan: 'trial' },
    ])
    .respond('UPDATE "users"', [{ id: 'usr_2', plan: 'series' }]);
  const store = createPostgresStore({ client });
  const updated = await store.users.update((r) => r.plan === 'trial', { plan: 'series' });
  assert.equal(updated.plan, 'series');
  assert.equal(client.calls.length, 2);
  assert.equal(
    client.calls[1].text,
    'UPDATE "users" SET "plan" = $1 WHERE "id" = $2 RETURNING *',
  );
  assert.deepEqual(client.calls[1].params, ['series', 'usr_2']);

  const missed = await store.users.update((r) => r.id === 'nope', { plan: 'free' });
  assert.equal(missed, undefined);
  assert.equal(client.calls.length, 3); // the SELECT; no UPDATE issued
  assert.ok(client.calls[2].text.startsWith('SELECT'));
});

test('update with an empty patch returns the row without issuing UPDATE', async () => {
  const client = fakeClient().respond('FROM "users"', [{ id: 'usr_1', plan: 'free' }]);
  const store = createPostgresStore({ client });
  const row = await store.users.update((r) => r.id === 'usr_1', { plan: undefined });
  assert.equal(row.plan, 'free');
  assert.equal(client.calls.length, 1);
});

test('remove deletes matches by key with ANY($1) and returns the count', async () => {
  const client = fakeClient()
    .respond('FROM "sessions"', [
      { token: 'TOK_A', user_id: 'usr_1' },
      { token: 'TOK_B', user_id: 'usr_1' },
    ])
    .respond('DELETE FROM "sessions"', []);
  const store = createPostgresStore({ client });
  const n = await store.sessions.remove((s) => s.user_id === 'usr_1');
  assert.equal(n, 2);
  assert.equal(client.calls[1].text, 'DELETE FROM "sessions" WHERE "token" = ANY($1)');
  assert.deepEqual(client.calls[1].params, [['TOK_A', 'TOK_B']]);

  const zero = await store.sessions.remove(() => false);
  assert.equal(zero, 0);
  assert.equal(client.calls.length, 3); // the SELECT; no DELETE issued
});

test('remove on a composite-key table uses row-value IN', async () => {
  const client = fakeClient()
    .respond('FROM "follows"', [
      { follower_id: 'usr_1', followee_id: 'usr_2' },
      { follower_id: 'usr_1', followee_id: 'usr_3' },
    ])
    .respond('DELETE FROM "follows"', []);
  const store = createPostgresStore({ client });
  const n = await store.follows.remove((r) => r.follower_id === 'usr_1');
  assert.equal(n, 2);
  assert.equal(
    client.calls[1].text,
    'DELETE FROM "follows" WHERE ("follower_id", "followee_id") IN (($1, $2), ($3, $4))',
  );
  assert.deepEqual(client.calls[1].params, ['usr_1', 'usr_2', 'usr_1', 'usr_3']);
});

test('count() parses the COUNT', async () => {
  const client = fakeClient().respond('COUNT(*)', [{ n: 7 }]);
  const store = createPostgresStore({ client });
  assert.equal(await store.alerts.count(), 7);
  assert.equal(client.calls[0].text, 'SELECT COUNT(*)::int AS n FROM "alerts"');
});

// --- 4. injection resistance --------------------------------------------------

test('hostile values and row keys can never smuggle SQL', async () => {
  const client = fakeClient().respond('INSERT INTO "users"', [{ id: 'usr_evil' }]);
  const store = createPostgresStore({ client });
  await store.users.insert({ id: "x'; DROP TABLE users; --", email: 'a@b.c' });
  assert.ok(!client.calls[0].text.includes('DROP TABLE'));
  assert.ok(client.calls[0].params.includes("x'; DROP TABLE users; --"));

  // A hostile *key* (identifier position) is refused outright.
  await assert.rejects(
    store.users.insert({ id: 'usr_1', 'email"; DROP TABLE users; --': 'a@b.c' }),
    /unsafe identifier/,
  );
});

// --- 6. store helpers ---------------------------------------------------------

test('createSession mints a 64-hex-char token and inserts the session row', async () => {
  const client = fakeClient().respond('INSERT INTO "sessions"', [{ token: 'tok_new' }]);
  const store = createPostgresStore({ client });
  const session = await store.createSession('usr_1');
  assert.equal(session.token, 'tok_new');
  assert.match(client.calls[0].params[0], /^[0-9a-f]{64}$/);
  assert.equal(client.calls[0].params[1], 'usr_1');
});

test('userForToken resolves, sweeps expired sessions, and nulls unknown tokens', async () => {
  const live = { token: 'tok_live', user_id: 'usr_1', expires_at: new Date(Date.now() + 3600_000).toISOString() };
  const dead = { token: 'tok_dead', user_id: 'usr_1', expires_at: new Date(Date.now() - 1000).toISOString() };
  const client = fakeClient()
    .respond('FROM "sessions"', [live, dead])
    .respond('FROM "users"', [{ id: 'usr_1', handle: 'kestrel' }])
    .respond('DELETE FROM "sessions"', []);
  const store = createPostgresStore({ client });

  const user = await store.userForToken('tok_live');
  assert.equal(user.handle, 'kestrel');

  const swept = await store.userForToken('tok_dead');
  assert.equal(swept, null);
  assert.ok(client.calls.some((c) => c.text.startsWith('DELETE FROM "sessions"')));

  const unknown = await store.userForToken('tok_nope');
  assert.equal(unknown, null);
  assert.equal(await store.userForToken(null), null);
});

test('endSession deletes by token; latestPrice returns the newest observation', async () => {
  const client = fakeClient()
    .respond('FROM "sessions"', [{ token: 'tok_bye', user_id: 'usr_1' }])
    .respond('DELETE FROM "sessions"', [])
    .respond('FROM "price_points"', [
      { release_id: 'rel_1', low_cents: 100, observed_at: '2026-09-08T00:00:00.000Z' },
      { release_id: 'rel_1', low_cents: 200, observed_at: '2026-09-09T00:00:00.000Z' },
      { release_id: 'rel_2', low_cents: 50, observed_at: '2026-09-09T00:00:00.000Z' },
    ]);
  const store = createPostgresStore({ client });
  await store.endSession('tok_bye');
  assert.ok(client.calls.some((c) => c.text.startsWith('DELETE FROM "sessions"')));

  const latest = await store.latestPrice('rel_1');
  assert.equal(latest.low_cents, 200);
  assert.equal(await store.latestPrice('rel_missing'), null);
});
