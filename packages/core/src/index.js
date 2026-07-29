/**
 * @file `@wax/core` — the domain layer.
 *
 * Four modules, in dependency order:
 *
 * | module        | what it is                                              |
 * |---------------|---------------------------------------------------------|
 * | `schema.sql`  | The relational schema. The source of truth for shape.    |
 * | `types.js`    | JSDoc typedefs mirroring every table. No runtime code.   |
 * | `seed.js`     | The demo dataset. Real audio, synthetic vinyl figures.   |
 * | `store.js`    | Row storage. Swap this for Postgres; nothing else moves. |
 * | `handlers.js` | Every read and write, as plain functions.                |
 *
 * Two consumers import from here and they get identical behaviour:
 *
 * - `/api/*.js` — Vercel serverless functions, thin HTTP adapters
 * - `apps/app`  — in local mode, calling the handlers directly with no server
 *
 * That symmetry is the point. There is one implementation of every rule in the
 * product, and the transport is a detail bolted on at the edge.
 */

export * from './handlers.js';
export { store, createStore, newId, newToken } from './store.js';
export { seed } from './seed.js';
export { TYPES_VERSION } from './types.js';
