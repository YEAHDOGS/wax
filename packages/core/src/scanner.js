import { createHash } from 'node:crypto';

/**
 * @file Scan loop core — gate 2 of the alert engine.
 *
 * `docs/ALERT-ENGINE-PLAN.md` section 2: each scan runs
 * `fetch → normalize product list → hash → diff against snapshot_hash →
 * new items become candidate releases → match against followed artists →
 * dedupe across sources → queue alerts`.
 *
 * This module is the pure half of that pipeline. It performs zero network
 * I/O: the caller fetches each source (honouring the plan's adaptive
 * intervals, backoff, robots.txt, and the `WaxBot/1.0` user-agent), hands the
 * raw parsed records to `scanSnapshot`, and persists the returned snapshot
 * itself (e.g. into the `sources.snapshot_hash` column from `schema.sql`).
 * The caller also enforces per-source `consecutive_failures` — failures never
 * reach this module.
 *
 * Every function here is deterministic, so the whole pipeline is
 * unit-testable against fixture arrays with no live scraping.
 */

/**
 * Canonical product record after normalization.
 *
 * @typedef {object} Product
 * @property {string} identity_key Deterministic key used for diffing: the
 *   lower-cased, whitespace-collapsed `artist \u2014 title` pair.
 * @property {string} title
 * @property {string} artist
 * @property {string} url
 * @property {string|null} image
 * @property {number|null} price_cents
 * @property {string|null} currency ISO-4217, e.g. 'USD'
 * @property {string} method  The probe method that produced this record.
 */

/**
 * Normalize one raw parsed record into the canonical product shape.
 *
 * Raw records arrive from heterogeneous parsers (Shopify JSON, feed items,
 * JSON-LD nodes, sitemap URL lists, HTML heuristic cards), so fields are
 * best-effort: `title`/`name`, `artist`/`vendor`, `link`/`url`/`@id`,
 * `image`/`image.src`, `price` as number/string/cents. Records that cannot
 * yield a usable identity are dropped — a scan must never alert on "unknown".
 *
 * @param {object} raw The raw parsed record.
 * @param {string} method One of the `PROBE_METHODS` from `probe.js`.
 * @returns {Product|null} The canonical product, or `null` if unusable.
 */
export function normalizeProduct(raw, method) {
  if (!raw || typeof raw !== 'object') return null;

  const title = pickString(raw, ['title', 'name', 'product_title']);
  const artist = pickString(raw, ['artist', 'vendor', 'brand', 'performer']);
  if (!title || !artist) return null;

  const url = pickString(raw, ['url', 'link', '@id', 'handle']);
  const image = pickNested(raw, [['image', 'src'], ['image'], ['thumbnail']]);
  // A numeric `price_cents` field is already cents — don't run it through
  // the string parser, which would multiply by 100 again.
  const priceRaw = typeof raw.price_cents === 'number'
    ? { cents: Math.round(raw.price_cents), currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : null }
    : parsePrice(pickNested(raw, [['price'], ['offers', 'price'], ['offers', 'priceSpecification', 'price']]));
  const { cents, currency } = priceRaw;

  const identity_key = [
    normalizeArtistName(artist),
    normalizeIdentity(title),
  ].join(' — ');

  return { identity_key, title: title.trim(), artist: artist.trim(), url: url ?? '', image: image ?? null, price_cents: cents, currency, method };
}

/**
 * Normalize a raw list into canonical products. Unusable records are dropped
 * and reported as `skipped` so the scan log can say why a source shrank.
 *
 * @param {Array<object>} rawList
 * @param {string} method
 * @returns {{ products: Product[], skipped: number }}
 */
export function normalizeProductList(rawList, method) {
  const products = [];
  let skipped = 0;
  for (const raw of rawList ?? []) {
    const p = normalizeProduct(raw, method);
    if (p) products.push(p);
    else skipped += 1;
  }
  return { products, skipped };
}

/**
 * Stable snapshot hash for a normalized product list.
 *
 * Sorts identity keys, concatenates the full canonical record of each, and
 * hashes with SHA-256. Any product-level change — new item, removed item,
 * title edit, price change — moves the hash, which is exactly what
 * `snapshot_hash` in the schema is for: cheap change detection without
 * storing the whole previous list.
 *
 * @param {Product[]} products
 * @returns {string} Hex digest.
 */
export function snapshotHash(products) {
  const rows = (products ?? [])
    .map((p) => `${p.identity_key}\t${p.title}\t${p.artist}\t${p.url}\t${p.image ?? ''}\t${p.price_cents ?? ''}\t${p.currency ?? ''}\t${p.method}`)
    .sort();
  return sha256hex(rows.join('\n'));
}

/**
 * Diff two normalized snapshots. Identity keys are the anchor; a title edit
 * is a remove+add (reported separately so the UI can render "renamed").
 *
 * @param {Product[]} prevProducts
 * @param {Product[]} nextProducts
 * @returns {{ added: Product[], removed: Product[], unchanged: Product[] }}
 */
export function diffSnapshots(prevProducts, nextProducts) {
  const prevByKey = new Map((prevProducts ?? []).map((p) => [p.identity_key, p]));
  const nextByKey = new Map((nextProducts ?? []).map((p) => [p.identity_key, p]));
  const added = [];
  const removed = [];
  const unchanged = [];
  for (const [key, p] of nextByKey) {
    if (prevByKey.has(key)) unchanged.push(p);
    else added.push(p);
  }
  for (const [key, p] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(p);
  }
  return { added, removed, unchanged };
}

/**
 * Run one full scan against a stored source snapshot.
 *
 * The caller passes the source's previous snapshot (kept opaque — the
 * caller decides where `snapshot_hash` + product rows live) and the raw
 * parse of the current fetch. Returns everything the queue needs: the
 * candidate releases (added products), the new snapshot to persist, and a
 * scan log entry in the same transparency pattern as the plan demands.
 *
 * @param {object} input
 * @param {string} input.source_id
 * @param {string} input.method One of `PROBE_METHODS`.
 * @param {{ products: Product[], hash: string } | null} input.prevSnapshot Null on the source's first scan.
 * @param {Array<object>} input.rawList The raw parsed product list from this fetch.
 * @returns {{ candidates: Product[], snapshot: { products: Product[], hash: string }, log: object }}
 */
export function scanSnapshot({ source_id, method, prevSnapshot, rawList }) {
  const { products, skipped } = normalizeProductList(rawList, method);
  const hash = snapshotHash(products);
  const diff = prevSnapshot ? diffSnapshots(prevSnapshot.products, products) : { added: products, removed: [], unchanged: [] };

  const log = {
    source_id,
    method,
    scanned_at: new Date().toISOString(),
    parsed: rawList?.length ?? 0,
    skipped,
    hash_changed: !prevSnapshot || prevSnapshot.hash !== hash,
    added: diff.added.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged.length,
  };

  return { candidates: diff.added, snapshot: { products, hash }, log };
}

/**
 * Match candidate releases against a user's followed artists (name + alias
 * match; the plan's Discogs ID match happens upstream when the ID is known
 * and present on the product — the schema's `artists.discogs_artist_id`).
 *
 * @param {Product[]} candidates
 * @param {Array<{ id: string, name: string, aliases?: string[] }>} artists
 * @returns {{ product: Product, artist: object }[]} Matches, in candidate order.
 */
export function matchArtists(candidates, artists) {
  const terms = [];
  for (const artist of artists ?? []) {
    terms.push({ key: normalizeArtistName(artist.name), artist });
    for (const alias of artist.aliases ?? []) {
      terms.push({ key: normalizeArtistName(alias), artist });
    }
  }
  const matches = [];
  for (const product of candidates ?? []) {
    const artistKey = normalizeArtistName(product.artist);
    const hit = terms.find((t) => t.key && artistKey.includes(t.key));
    if (hit) matches.push({ product, artist: hit.artist });
  }
  return matches;
}

/**
 * Dedupe matched candidates across sources — the same release on three
 * sites is one alert, not three. Winner is the first seen in input order;
 * losers are kept on `sources_seen` so the UI can show "also at 2 other
 * shops" without sending duplicate alerts.
 *
 * @param {Array<{ product: Product, artist: object, source_id: string }>} matches
 * @returns {Array<{ product: Product, artist: object, source_id: string, sources_seen: string[] }>}
 */
export function dedupeCandidates(matches) {
  const byKey = new Map();
  for (const m of matches ?? []) {
    const key = `${normalizeArtistName(m.artist.name ?? m.artist.id)} — ${normalizeIdentity(m.product.title)}`;
    if (byKey.has(key)) {
      byKey.get(key).sources_seen.push(m.source_id);
    } else {
      byKey.set(key, { ...m, sources_seen: [m.source_id] });
    }
  }
  return [...byKey.values()];
}

// ------------------------------------------------------------------ helpers

/** First non-empty string from any of the given field names. */
function pickString(raw, names) {
  for (const name of names) {
    const v = raw[name];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** Walk nested paths like ['offers','price'], returning the first non-empty value. */
function pickNested(raw, paths) {
  for (const path of paths) {
    let v = raw;
    for (const key of path) {
      if (v == null || typeof v !== 'object') { v = undefined; break; }
      v = v[key];
    }
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/**
 * Normalize an artist/shop name for keying/matching: lowercase, collapse
 * whitespace, strip non-alphanumerics. Unlike `normalizeIdentity` it does
 * NOT strip edition noise — "Vinyl Den" is a shop name, not a pressing
 * description.
 */
function normalizeArtistName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize an identity string for keying/matching: lowercase, collapse
 * whitespace, strip the vinyl-edition noise that makes the same record look
 * different ("Vinyl LP", "180g", "Limited Edition", reissue years).
 */
function normalizeIdentity(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')            // parenthetical editions
    .replace(/\b(180g|vinyl|lp|2lp|limited\s+edition|reissue|remaster(ed)?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a price into cents + currency. Accepts numbers, numeric strings,
 * "$49.99" style strings, or `{ amount, currency }` objects.
 *
 * @returns {{ cents: number|null, currency: string|null }}
 */
function parsePrice(v) {
  if (v === undefined || v === null) return { cents: null, currency: null };
  if (typeof v === 'object') {
    const cents = typeof v.amount === 'number' ? Math.round(v.amount * 100) : parsePrice(v.amount).cents;
    const currency = typeof v.currency === 'string' ? v.currency.toUpperCase() : null;
    return { cents, currency };
  }
  const str = String(v);
  const currency = str.includes('$') ? 'USD' : str.includes('€') ? 'EUR' : str.includes('£') ? 'GBP' : null;
  const num = parseFloat(str.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3})/g, ''));
  if (Number.isNaN(num)) return { cents: null, currency };
  return { cents: Math.round(num * 100), currency };
}

/**
 * SHA-256 hex of a string, via the node:crypto built-in (no dependency).
 *
 * @param {string} s
 * @returns {string}
 */
function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
