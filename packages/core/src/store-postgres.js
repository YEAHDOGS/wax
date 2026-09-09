/**
 * @file Postgres-backed Wax store (ALERT-ENGINE-PLAN.md §4: the actual
 * Postgres `store.js` swap).
 *
 * This is the one-file change the plan has been pointing at: the same
 * store shape `createStore()` returns — 20 named collections plus the
 * session helpers — backed by SQL instead of arrays. Everything that
 * talks to the store interface (handlers, the alert engine, the billing
 * sweep, the scheduler persistence) works against this with no other
 * code changes.
 *
 * ## What is deliberately NOT here
 *
 * - No `pg` import. The repo pins zero dependencies and `pg` is not
 *   installed, so the driver is **injected**: `createPostgresStore`
 *   takes a `client` with an async `query(text, params)` — a real
 *   `pg` Client/Pool works, and tests pass a fake. Brandon's swap
 *   recipe: `npm i pg` (his call — never installed by automation),
 *   `DATABASE_URL` in the environment, `new Client(...)` wired at
 *   boot wherever `createStore()` is called today.
 * - No live database connection is ever opened here. This module only
 *   builds parameterized queries; the fake-client test suite asserts
 *   every one of them, and no real connection is needed to review it.
 *
 * ## Semantics
 *
 * - The store is fully **async**: every collection method returns a
 *   promise. The in-memory store is sync; call sites switching to this
 *   store `await` the same calls. (`handlers.js` and the API routes
 *   are already async, so this is mechanical.)
 * - Rows round-trip JSON-safe, exactly like the in-memory store:
 *   `timestamptz` columns come back from `pg` as `Date` objects and
 *   are normalized to ISO strings; `jsonb` columns are parsed by the
 *   driver; `text[]` pass through as arrays.
 * - JS predicates (`find`/`filter`/`update`/`remove`) are applied in
 *   JavaScript over a `SELECT *` of the table. The interface is a dumb
 *   predicate bag by design (see `store.js`), so a SQL-backed adapter
 *   cannot push predicates down without a query language — and the
 *   design forbids a query language. The cost is O(table) per
 *   predicate call, which is the documented price of the interface,
 *   and fine at Wax's scale. Hot paths that need an index get a
 *   dedicated query later, not a predicate upgrade.
 * - All user data travels in `$1`-style parameters. Identifiers
 *   (table/column names) come only from the fixed `POSTGRES_TABLES`
 *   map or from the row's own keys, which are validated against an
 *   identifier pattern — a row key can never smuggle SQL.
 * - `undefined` values are skipped on write, so column defaults
 *   (`DEFAULT now()`, `'{}'`, etc.) apply — matching the in-memory
 *   store, whose JSON clone drops `undefined` keys too.
 *
 * Failure policy: query failures throw to the caller, same as every
 * other Wax module — a failed save is loud, never silently dropped.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote an SQL identifier. Names must come from the fixed table map or
 * from validated row keys — this is a defense-in-depth belt, not the
 * whole defense.
 */
function ident(name) {
  if (!IDENT.test(name)) throw new Error(`store-postgres: unsafe identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * Collection key → Postgres table + key column(s) + jsonb columns.
 * Every table here has a matching `CREATE TABLE` in `schema.sql` and a
 * matching collection in `store.js`; the plan's "change all three"
 * convention applies here as the fourth.
 */
export const POSTGRES_TABLES = {
  users:             { table: 'users',               key: 'id' },
  profiles:          { table: 'profiles',            key: 'user_id' },
  follows:           { table: 'follows',             key: ['follower_id', 'followee_id'] },
  artists:           { table: 'artists',             key: 'id' },
  releases:          { table: 'releases',            key: 'id' },
  tracks:            { table: 'tracks',              key: 'id' },
  sources:           { table: 'sources',             key: 'id' },
  scanLogs:          { table: 'scan_logs',           key: 'id' },
  scanSnapshots:     { table: 'scan_snapshots',      key: 'source_id' },
  digestQueue:       { table: 'digest_queue',        key: 'id' },
  subscriptions:     { table: 'alert_subscriptions', key: 'id', jsonb: ['filter', 'confirm_receipt'] },
  subscribeAttempts: { table: 'subscribe_attempt',   key: 'id' },
  watches:           { table: 'watches',             key: 'id' },
  alerts:            { table: 'alerts',              key: 'id' },
  crateItems:        { table: 'crate_items',         key: 'id' },
  wantlistItems:     { table: 'wantlist_items',      key: 'id' },
  pricePoints:       { table: 'price_points',       key: 'id' },
  activity:          { table: 'activity',            key: 'id' },
  engineStates:      { table: 'engine_state',        key: ['user_id', 'state_key'], jsonb: ['state'] },
  sessions:          { table: 'sessions',            key: 'token' },
};

/** How long a freshly minted session lives, in milliseconds. Thirty days. Mirrors store.js. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalize one row coming back from the driver: `Date` → ISO string
 * so rows are JSON-safe exactly like the in-memory store's clones.
 */
function decodeRow(row) {
  if (row == null || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * Encode a row for a write: validate identifier-shaped keys, drop
 * `undefined`, JSON-stringify jsonb columns. `text[]` and scalars pass
 * through — `pg` serializes JS arrays to `text[]` natively.
 */
function encodeRow(row, jsonbCols) {
  const jsonb = new Set(jsonbCols ?? []);
  const columns = [];
  const values = [];
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v === undefined) continue;
    ident(k); // throws on anything that is not a bare identifier
    columns.push(k);
    values.push(jsonb.has(k) ? JSON.stringify(v) : v);
  }
  return { columns, values };
}

const keyColsOf = (spec) => (Array.isArray(spec.key) ? spec.key : [spec.key]);

/**
 * One SQL-backed collection implementing the same contract as the
 * in-memory `collection()` in `store.js`.
 *
 * @param {object} client A pg-compatible client: `query(text, params)` → `Promise<{ rows }>`.
 * @param {{ table: string, key: string|string[], jsonb?: string[] }} spec
 */
export function sqlCollection(client, spec) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('sqlCollection needs a client with an async query(text, params) method');
  }
  if (!spec || typeof spec.table !== 'string') throw new TypeError('sqlCollection needs a spec with a table name');
  ident(spec.table); // fixed-map names only; a hostile table name is refused here
  for (const c of keyColsOf(spec)) ident(c);
  for (const c of spec.jsonb ?? []) ident(c);
  const t = ident(spec.table);
  const keys = keyColsOf(spec);

  /** Load every row of the table, JSON-safe. */
  async function loadAll() {
    const { rows } = await client.query(`SELECT * FROM ${t}`);
    return rows.map(decodeRow);
  }

  /** Extract the key values of a (raw or decoded) row, driver-encoded. */
  function keyValuesOf(row) {
    return keys.map((k) => {
      const v = row[k];
      return (spec.jsonb ?? []).includes(k) ? JSON.stringify(v) : v;
    });
  }

  return {
    /** Every row, JSON-safe. */
    async all() {
      return loadAll();
    },

    /** First match of `pred`, JSON-safe, or undefined. Predicates run in JS over the table. */
    async find(pred) {
      const rows = await loadAll();
      return rows.find(pred);
    },

    /** All matches of `pred`, JSON-safe. Predicates run in JS over the table. */
    async filter(pred) {
      const rows = await loadAll();
      return rows.filter(pred);
    },

    /**
     * Adds a row, returns it JSON-safe (via `RETURNING *`, so DB
     * defaults like `created_at` come back resolved).
     */
    async insert(row) {
      const { columns, values } = encodeRow(row, spec.jsonb);
      if (columns.length === 0) throw new Error(`store-postgres: insert into ${spec.table} got an empty row`);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await client.query(
        `INSERT INTO ${t} (${columns.map(ident).join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return decodeRow(rows[0]);
    },

    /**
     * Merges `patch` into the first match. Returns the updated row
     * JSON-safe, or undefined when nothing matched (no query issued).
     */
    async update(pred, patch) {
      const raw = (await client.query(`SELECT * FROM ${t}`)).rows;
      const targetRaw = raw.find((r) => pred(decodeRow(r)));
      if (!targetRaw) return undefined;
      const { columns, values } = encodeRow(patch, spec.jsonb);
      if (columns.length === 0) return decodeRow(targetRaw);
      const sets = columns.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
      const where = keys.map((c, i) => `${ident(c)} = $${columns.length + i + 1}`).join(' AND ');
      const { rows } = await client.query(
        `UPDATE ${t} SET ${sets} WHERE ${where} RETURNING *`,
        [...values, ...keyValuesOf(targetRaw)],
      );
      return decodeRow(rows[0]);
    },

    /**
     * Deletes matches, returns the count. Issues no query when
     * nothing matched.
     */
    async remove(pred) {
      const raw = (await client.query(`SELECT * FROM ${t}`)).rows;
      const matches = raw.filter((r) => pred(decodeRow(r)));
      if (matches.length === 0) return 0;
      const keySets = matches.map(keyValuesOf);
      let where;
      let params;
      if (keys.length === 1) {
        where = `${ident(keys[0])} = ANY($1)`;
        params = [keySets.map((s) => s[0])];
      } else {
        const tuples = keySets
          .map((set, n) => `(${set.map((_, i) => `$${n * keys.length + i + 1}`).join(', ')})`)
          .join(', ');
        where = `(${keys.map(ident).join(', ')}) IN (${tuples})`;
        params = keySets.flat();
      }
      await client.query(`DELETE FROM ${t} WHERE ${where}`, params);
      return matches.length;
    },

    /** Row count. */
    async count() {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      return rows[0].n;
    },
  };
}

/**
 * Build the full Postgres-backed Wax store.
 *
 * @param {object} opts
 * @param {object} opts.client A pg-compatible client (`query(text, params)` → `Promise<{ rows }>`).
 * @param {object} [opts.tables] Override table map (tests use a subset).
 * @returns {Promise-free store object with async collections and async helpers.}
 */
export function createPostgresStore({ client, tables = POSTGRES_TABLES } = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('createPostgresStore needs { client } with an async query(text, params) method');
  }
  const store = {};
  for (const [name, spec] of Object.entries(tables)) {
    store[name] = sqlCollection(client, spec);
  }

  /**
   * Mint a session for a user. Mirrors the in-memory store's helper.
   */
  store.createSession = async (userId) => {
    const now = Date.now();
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const token = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return store.sessions.insert({
token,
      user_id: userId,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    });
  };

  /**
   * Resolve a Bearer <redacted> to its user, checking expiry on read.
   * Expired rows are swept lazily, like the in-memory store.
   */
  store.userForToken = async (token) => {
    if (!token) return null;
    const session = await store.sessions.find((s) => s.token === token);
    if (!session) return null;
    if (Date.parse(session.expires_at) <= Date.now()) {
      await store.sessions.remove((s) => s.token === token);
      return null;
    }
    return (await store.users.find((u) => u.id === session.user_id)) ?? null;
  };

  /** Drop a session. Idempotent. */
  store.endSession = async (token) => {
    if (token) await store.sessions.remove((s) => s.token === token);
  };

  /** The most recent price observation for a release. */
  store.latestPrice = async (releaseId) => {
    const points = await store.pricePoints.filter((p) => p.release_id === releaseId);
    points.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
    return points[0] ?? null;
  };

  return store;
}
