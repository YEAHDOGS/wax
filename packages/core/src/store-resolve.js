/**
 * @file Boot-time store resolution — the last inch of the Postgres swap
 * (ALERT-ENGINE-PLAN.md §4: "Brando's `pg` install + `DATABASE_URL` wiring
 * at boot").
 *
 * `resolveStore()` picks the store every long-lived process should run on:
 *
 * - `DATABASE_URL` set → Postgres, via `createPostgresStore` over a `pg`
 *   `Client`. The driver is loaded lazily and *only* on this path: a
 *   missing driver is a loud, actionable error, never a silent fallback
 *   to the demo store (silent fallback would fork the data and nobody
 *   would know until an alert went missing).
 * - `DATABASE_URL` unset → the in-memory `createStore()` demo store,
 *   exactly as today. Every existing CLI and test keeps working.
 *
 * Callers (`bin/wax`, the future serverless boot) `await resolveStore()`
 * once and pass the store into the worker pipeline. The pipeline's
 * modules all await their store calls, so Postgres and in-memory stores
 * behave identically — that is the whole point of the await-pass.
 *
 * Zero dependencies. No network here — the socket opens only when the
 * Postgres path connects its client.
 */

import { createStore } from './store.js';
import { createPostgresStore } from './store-postgres.js';

/**
 * Load the `pg` driver. Kept behind a parameter so tests can inject a
 * fake without installing anything, and so production can vendor or
 * `npm i pg` whenever Brando approves the install (default-deny: this
 * module never installs anything itself).
 * @returns {Promise<{ Client: new (config: object) => { connect: () => Promise<void>, query: Function } }>}
 */
async function defaultLoadPg() {
  try {
    return await import('pg');
  } catch {
    throw new Error(
      'wax: DATABASE_URL is set but the `pg` driver is not installed. ' +
        'Install it (e.g. `npm i pg` in the workspace root) or unset DATABASE_URL ' +
        'to keep running the in-memory demo store. Refusing to fall back silently: ' +
        'a quiet fallback would fork alert state between two stores.',
    );
  }
}

/**
 * Resolve the store for this process.
 * @param {object} [input]
 * @param {Record<string, string|undefined>} [input.env] Defaults to `process.env`.
 * @param {() => Promise<{ Client: new (config: object) => any }>} [input.loadPg]
 *   Driver loader — inject a fake in tests.
 * @returns {Promise<{ store: object, backend: 'memory'|'postgres' }>}
 */
export async function resolveStore({ env = globalThis.process?.env ?? {}, loadPg = defaultLoadPg } = {}) {
  const url = env.DATABASE_URL;
  if (!url) {
    return { store: createStore(), backend: 'memory' };
  }
  const { Client } = await loadPg();
  const client = new Client({ connectionString: url });
  await client.connect();
  return { store: createPostgresStore({ client }), backend: 'postgres' };
}
