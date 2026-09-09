/**
 * Smoke/regression check for `packages/core/src/store-resolve.js` —
 * boot-time store resolution (ALERT-ENGINE-PLAN.md §4, the "DATABASE_URL
 * wiring at boot" step).
 *
 * Run: `node --test packages/core/test-store-resolve.mjs`
 * Zero dependencies beyond the Node standard library. No network, no
 * live database — the Postgres path is exercised with a fake `pg`
 * driver injected through `loadPg`, so this test never needs the real
 * driver installed and never opens a socket.
 *
 * Pins:
 * 1. No `DATABASE_URL` → the in-memory demo store (`backend: 'memory'`),
 *    so every existing CLI and test keeps working unchanged.
 * 2. `DATABASE_URL` + injected driver → `createPostgresStore` over a
 *    connected `pg` client (`backend: 'postgres'`); the client gets the
 *    connection string and is connected before the store is returned.
 * 3. `DATABASE_URL` + missing driver → a loud, actionable error naming
 *    the `pg` install — never a silent fallback to the demo store (a
 *    silent fallback would fork alert state between two stores).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStore } from './src/index.js';

/** Fake `pg` module: records what the boot path did with it. */
function fakePgModule(seen) {
  return {
    Client: class FakeClient {
      constructor(config) {
        seen.config = config;
        this.connected = false;
      }
      async connect() {
        this.connected = true;
        seen.connected = true;
      }
      async query() {
        throw new Error('fake client: no SQL in this test');
      }
    },
  };
}

test('no DATABASE_URL resolves the in-memory store', async () => {
  const { store, backend } = await resolveStore({ env: {} });
  assert.equal(backend, 'memory');
  const user = await store.users.insert({ id: 'u1', email: 'a@example.com' });
  assert.equal(user.id, 'u1');
  assert.equal(await store.users.count() >= 1, true);
});

test('DATABASE_URL + driver resolves the Postgres store and connects', async () => {
  const seen = {};
  const { store, backend } = await resolveStore({
    env: { DATABASE_URL: 'postgres://db:5432/wax' },
    loadPg: async () => fakePgModule(seen),
  });
  assert.equal(backend, 'postgres');
  assert.equal(seen.config.connectionString, 'postgres://db:5432/wax');
  assert.equal(seen.connected, true, 'the client must be connected before the store is returned');
  // The Postgres store shape: SQL-backed collections over the schema tables.
  assert.equal(typeof store.alerts.all, 'function');
  assert.equal(typeof store.engineStates.find, 'function');
  assert.equal(typeof store.createSession, 'function');
});

test('DATABASE_URL + failing driver loader surfaces the error, never falls back', async () => {
  await assert.rejects(
    () =>
      resolveStore({
        env: { DATABASE_URL: 'postgres://db:5432/wax' },
        loadPg: async () => {
          throw new Error('boom');
        },
      }),
    /boom/,
    'a driver failure must be loud, not a silent demo-store fallback',
  );
});

test('DATABASE_URL + truly missing pg driver errors with the install hint', async () => {
  let pgPresent = false;
  try {
    await import('pg');
    pgPresent = true;
  } catch {
    pgPresent = false;
  }
  if (pgPresent) {
    // If Brando installs pg later, the loud-error path no longer applies —
    // skip rather than assert against a driver that now exists.
    return;
  }
  await assert.rejects(
    () => resolveStore({ env: { DATABASE_URL: 'postgres://db:5432/wax' } }),
    /`pg` driver is not installed/,
    'the missing-driver error must name the pg install',
  );
});
