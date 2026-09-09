/**
 * @file Real HTTP fetcher — the network half of the alert engine (plan §2).
 *
 * `poller.js` is the orchestrating half of the scan worker: due queue,
 * snapshots, adaptive backoff, scan log, alert feed. It performs zero
 * network I/O — fetching is an injected `fetcher(source)`. This module is
 * the production implementation of that contract:
 *
 *   fetcher(source) => Promise<{ status: number, rawList: Array<object> }>
 *
 * honoring everything the plan demands:
 *
 * - Identifies as `WaxBot/1.0; +https://wax.wearedogs.net/bot` (the
 *   `USER_AGENT` export from `poller.js` — single source of truth).
 * - Fetches and respects `robots.txt` per host (cached 24h), including
 *   `crawl-delay`. A disallowed path is a *throw*, never a silent skip, so
 *   the worker's failure path backs the source off honestly.
 * - Per-host politeness: crawl-delay, a default inter-request floor, and
 *   adaptive backoff on 429s (Retry-After honored, exponential otherwise).
 * - Parses per `source.scan_method`: Shopify `/products.json`, RSS/Atom
 *   feeds, JSON-LD product nodes, sitemaps, and a best-effort heuristic
 *   card extractor. Output shapes match what `scanner.js` normalizes
 *   (see `test-scan.mjs` fixtures).
 *
 * ## Security posture (Brandon: default-deny)
 *
 * - Zero new dependencies — `node:http`, `node:https`, `node:dns`,
 *   `node:net` only. Nothing to install, nothing to audit upstream.
 * - GET only, no request body, no cookies, no credentials ever sent. The
 *   fetcher reads public pages; it never transmits user data anywhere.
 * - http(s) only, re-validated on every redirect hop; redirects are
 *   followed at most `FETCH_MAX_REDIRECTS` and never to a non-http(s) URL.
 * - SSRF guard: the default transport resolves the hostname and refuses
 *   private/loopback/link-local targets, pinning the connection to the
 *   resolved public IP.
 * - Timeouts (`FETCH_TIMEOUT_MS`) and a response size cap
 *   (`FETCH_MAX_BYTES`) so one pathological page can't wedge a scan pass.
 *
 * ## Known limitations (honest, not silent)
 *
 * - `sitemap` sources yield URL records with a slug-derived title and no
 *   artist, which `normalizeProduct` drops (they surface as `skipped` in the
 *   scan log). A sitemap alone can't identify *who* a release is by, so it
 *   can't produce artist-matched alerts without per-product fetches — that
 *   upgrade is future work, not a silent no-op.
 * - Throttle state (robots cache, crawl-delay, backoff) lives in memory
 *   per fetcher instance. The worker's durable state (snapshots, intervals,
 *   failure counts) lives in the store, so a cold start loses nothing but
 *   the politeness ledger. Persisting the ledger to the store is a
 *   follow-up.
 * - Bandcamp / Big Cartel `platform-api` fetches throw "not implemented
 *   yet" — the worker treats that as a failure and backs off rather than
 *   pretending the source scanned.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { USER_AGENT, canFetch } from './poller.js';

/** Request timeout — one slow site must not wedge the scan pass. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Largest response body accepted — a pathological page gets cut off. */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Redirects followed before giving up. */
export const FETCH_MAX_REDIRECTS = 5;

/** Per-host inter-request floor when robots.txt names no crawl-delay. */
export const DEFAULT_POLITENESS_SECS = 1;

/** How long one robots.txt fetch stays trusted. */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-host backoff after a 429 with no Retry-After: starts here, doubles, caps here. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

/** Max child sitemaps followed from a sitemapindex. */
export const SITEMAP_CHILD_LIMIT = 10;

/** Thrown when robots.txt disallows the fetch path. The worker treats it
 * as a fetch failure, so the source backs off honestly instead of silently
 * pretending to scan. */
export class RobotsDisallowedError extends Error {
  constructor(url, host) {
    super(`robots.txt disallows ${url} (host ${host})`);
    this.name = 'RobotsDisallowedError';
    this.code = 'ROBOTS_DISALLOWED';
    this.url = url;
    this.host = host;
  }
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

/**
 * Parse a robots.txt body (RFC 9309, lite). Returns the rule set for the
 * WaxBot group (exact `waxbot` user-agent match) or the `*` group if the
 * bot has no named group.
 *
 * @param {string} text The robots.txt body.
 * @param {string} [botName] Defaults to 'waxbot'.
 * @returns {{ rules: Array<{ type: 'allow'|'disallow', path: string }>, crawlDelaySecs: number|null }}
 */
export function parseRobots(text, botName = 'waxbot') {
  const groups = [];
  let current = null;
  const commit = () => {
    if (current) {
      groups.push(current);
      current = null;
    }
  };
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const field = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // A group ends at the first rule; a new user-agent line after rules
      // starts a new group.
      if (current && current.hasRules) commit();
      if (!current) current = { agents: [], hasRules: false, rules: [], crawlDelay: null };
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue; // directives before any user-agent line are ignored
    if (field === 'disallow') {
      current.hasRules = true;
      // An empty Disallow means "allow everything" — add no rule.
      if (value) current.rules.push({ type: 'disallow', path: value });
    } else if (field === 'allow') {
      current.hasRules = true;
      if (value) current.rules.push({ type: 'allow', path: value });
    } else if (field === 'crawl-delay') {
      current.hasRules = true;
      const n = parseFloat(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else {
      // sitemap:, host:, and anything else are informational here — but
      // they still terminate the user-agent run that opened the group.
      current.hasRules = true;
    }
  }
  commit();

  const name = String(botName).toLowerCase();
  const group =
    groups.find((g) => g.agents.includes(name)) ??
    groups.find((g) => g.agents.includes('*')) ??
    null;
  return {
    rules: group ? group.rules : [],
    crawlDelaySecs: group && group.crawlDelay != null ? group.crawlDelay : null,
  };
}

/**
 * Whether `path` is fetchable under the parsed rules. Longest matching
 * rule wins; ties go to Allow.
 *
 * @param {Array<{ type: string, path: string }>} rules
 * @param {string} path e.g. '/new?limit=250'
 * @returns {boolean}
 */
export function robotsAllows(rules, path) {
  const p = path || '/';
  let best = null;
  for (const r of rules ?? []) {
    if (!r || !r.path) continue;
    if (!p.startsWith(r.path)) continue;
    if (!best || r.path.length > best.path.length) {
      best = r;
    } else if (r.path.length === best.path.length && r.type === 'allow' && best.type === 'disallow') {
      best = r;
    }
  }
  return best ? best.type === 'allow' : true;
}

/* ------------------------------------------------------------------ *
 * Default transport — node:http(s), with an SSRF guard
 * ------------------------------------------------------------------ */

/** True for IPs the fetcher must never touch (private, loopback,
 * link-local, multicast, documentation ranges). Best-effort belt over the
 * DNS-resolved address. */
function isNonPublicIp(addr) {
  if (isIP(addr) === 4) {
    const b = addr.split('.').map(Number);
    if (b[0] === 10) return true; // 10/8
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16/12
    if (b[0] === 192 && b[1] === 168) return true; // 192.168/16
    if (b[0] === 127) return true; // 127/8 loopback
    if (b[0] === 169 && b[1] === 254) return true; // 169.254/16 link-local
    if (b[0] >= 224 && b[0] <= 239) return true; // multicast
    if (b[0] === 0) return true; // 0/8
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return true; // TEST-NET-1
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true; // TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true; // TEST-NET-3
    return false;
  }
  if (isIP(addr) === 6) {
    const low = addr.toLowerCase();
    if (low === '::1' || low === '::ffff:127.0.0.1') return true;
    if (low.startsWith('fe80:')) return true; // link-local
    if (/^fc[0-9a-f]{2}:/.test(low) || low.startsWith('fd')) return true; // unique-local
    if (low === '::') return true;
    return false;
  }
  return true; // not an IP at all — refuse
}

function dnsLookupAsync(hostname) {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

/**
 * The production transport: one GET, no redirects (the fetcher loop
 * handles hops so robots.txt can be re-checked per host). Enforces the
 * SSRF guard, timeout, and response size cap.
 *
 * @param {string} url
 * @param {{ headers: object, timeoutMs: number, maxBytes: number }} opts
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
async function nodeTransport(url, { headers, timeoutMs, maxBytes }) {
  const u = new URL(url);

  // SSRF guard: resolve first, refuse non-public targets, and pin the
  // connection to the resolved address so a rebinding DNS answer can't
  // steer the socket elsewhere mid-request.
  let resolved;
  try {
    resolved = await dnsLookupAsync(u.hostname);
  } catch (err) {
    throw new Error(`DNS lookup failed for ${u.hostname}: ${err.message}`);
  }
  if (isNonPublicIp(resolved.address)) {
    throw new Error(`refusing to fetch non-public address ${resolved.address} (${u.hostname})`);
  }

  return new Promise((resolve, reject) => {
    const requestFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: 'GET',
        headers,
        timeout: timeoutMs,
        // Pin the resolved public IP.
        lookup: (hostname, options, callback) =>
          callback(null, resolved.address, isIP(resolved.address)),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let failed = false;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            failed = true;
            res.destroy();
            reject(new Error(`response exceeded ${maxBytes} byte cap`));
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          if (!failed) {
            resolve({
              status: res.statusCode ?? 0,
              headers: normalizeHeaders(res.headers),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          }
        });
        res.on('error', (err) => {
          if (!failed) reject(err);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`fetch timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Lowercase every header name; keep the first value of multi-valued ones. */
function normalizeHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Per-method parsers — all exported for testability
 * ------------------------------------------------------------------ */

/**
 * Shopify `/products.json` → raw records shaped for `normalizeProduct`
 * (title, vendor, url, image, price).
 */
export function parseShopifyProducts(json, pageUrl) {
  const origin = new URL(pageUrl).origin;
  return (json?.products ?? []).map((p) => ({
    title: p?.title,
    vendor: p?.vendor,
    url: p?.handle ? `${origin}/products/${p.handle}` : (p?.online_store_url ?? ''),
    image: p?.images?.[0]?.src ?? p?.image?.src ?? null,
    price: p?.variants?.[0]?.price ?? null,
  }));
}

function textOf(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * RSS 2.0 / Atom feed → raw records shaped for `normalizeProduct`
 * (name, brand, link, thumbnail). Feeds rarely carry prices; price is
 * best-effort and null when absent.
 */
export function parseFeedItems(xml) {
  const doc = String(xml ?? '');
  const blocks = [...doc.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  const out = [];
  for (const block of blocks) {
    const title = textOf(block, 'title');
    // RSS: <link>url</link>; Atom: <link href="url"/>
    let link = textOf(block, 'link');
    if (!link || /^https?:/.test(link) === false) {
      const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      link = href ? href[1] : null;
    }
    const brand =
      textOf(block, 'dc:creator') ??
      textOf(block, 'author') ??
      (() => {
        const a = block.match(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i);
        return a ? decodeEntities(a[1]).trim() : null;
      })();
    const media = block.match(/<(?:media:content|enclosure)\b[^>]*(?:url|href)=["']([^"']+)["']/i);
    out.push({ name: title, brand, link, thumbnail: media ? media[1] : null });
  }
  return out;
}

function jsonLdString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const el of v) {
      const s = jsonLdString(el);
      if (s) return s;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    return jsonLdString(v.name ?? v.url ?? v['@id'] ?? null);
  }
  return null;
}

/** Collect Product/MusicAlbum/MusicRelease nodes, descending into ItemList wrappers. */
function jsonLdProductNodes(doc) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const type = String(node['@type'] ?? '');
    if (/^(Product|MusicAlbum|MusicRelease)$/i.test(type)) {
      found.push(node);
      return;
    }
    if (/^ItemList$/i.test(type)) {
      visit(node.itemListElement);
      return;
    }
    if (node['@graph']) visit(node['@graph']);
  };
  visit(doc);
  return found;
}

/**
 * HTML with JSON-LD `<script type="application/ld+json">` blocks →
 * raw records (name, brand, url, image, price, currency). ItemList
 * wrappers are descended into.
 */
export function parseJsonLdProducts(html) {
  const doc = String(html ?? '');
  const blocks = doc.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const out = [];
  for (const block of blocks) {
    const inner = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue; // malformed JSON-LD is not our signal (same as probe.js)
    }
    for (const node of jsonLdProductNodes(parsed)) {
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      out.push({
        '@type': node['@type'],
        name: jsonLdString(node.name),
        brand: jsonLdString(node.brand),
        url: node.url ?? node['@id'] ?? null,
        image: jsonLdString(node.image),
        price: offers?.price ?? null,
        currency: offers?.priceCurrency ?? null,
      });
    }
  }
  return out;
}

/** Human title from a sitemap URL slug: last path segment, de-dashed. */
function slugTitle(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segs[segs.length - 1] ?? '';
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Sitemap XML → raw records. Only `{ url, title, artist }`; the artist is
 * always null because a bare URL list cannot say who a release is by —
 * `normalizeProduct` drops these (they surface as `skipped` in the scan
 * log). Sitemap *index* files are followed one level, bounded.
 *
 * @param {string} xml
 * @returns {{ records: Array<{ url: string, title: string|null, artist: null }> }}
 */
export function parseSitemapUrls(xml) {
  const doc = String(xml ?? '');
  const urlLocs = [...doc.matchAll(/<url\b[\s\S]*?<loc>([^<]+)<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim());
  const locs = urlLocs.length
    ? urlLocs
    : [...doc.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim());
  const records = locs.map((url) => ({ url, title: slugTitle(url), artist: null }));
  const isIndex = /<sitemapindex\b/i.test(doc) || (!urlLocs.length && /<sitemap\b/i.test(doc));
  return { records, isIndex };
}

/** Strip tags → collapsed plain text. */
function textContent(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best site/vender name from page metadata, else the hostname. */
function pageVendorName(html, pageUrl) {
  const og = html.match(/<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (og?.[1]?.trim()) return og[1].trim();
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const t = textContent(title[1]).split(/[|\-–—]/)[0].trim();
    if (t) return t;
  }
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Best-effort product-card extraction from shop HTML: anchors that contain
 * an image and a price pattern. Vendor falls back to the page's site name
 * (og:site_name / <title> / hostname) because these stores are typically
 * single-vendor merch pages. Flagged fragile by the probe — this parser is
 * the same bargain.
 */
export function parseHeuristicCards(html, pageUrl) {
  const doc = String(html ?? '');
  const vendor = pageVendorName(doc, pageUrl);
  const priceRe = /[$€£¥]\s?\d[\d.,]*/;
  const seen = new Set();
  const out = [];
  for (const m of doc.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue;
    const inner = m[2];
    if (!/<img\b/i.test(inner)) continue;
    const priceHit = inner.match(priceRe);
    if (!priceHit) continue;
    let absolute;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const img = inner.match(/<img\b[^>]*src=["']([^"']+)["']/i);
    let image = null;
    if (img) {
      try {
        image = new URL(img[1], pageUrl).toString();
      } catch {
        image = img[1];
      }
    }
    const text = textContent(inner);
    // Title is the text before the price; fall back to the whole snippet.
    const title = text.split(priceHit[0])[0].trim().slice(0, 160) || text.slice(0, 160);
    out.push({ title, vendor, url: absolute, image, price: priceHit[0] });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The fetcher
 * ------------------------------------------------------------------ */

/**
 * Build the real HTTP fetcher for the scan worker.
 *
 * `transport`, `clock`, and `sleep` are injectable so the whole polite
 * dance (robots, crawl-delay, backoff) is unit-testable with zero live
 * HTTP. Production uses the default `nodeTransport` with the SSRF guard.
 *
 * @param {object} [options]
 * @param {(url: string, opts: object) => Promise<{ status: number, headers: object, body: string }>} [options.transport]
 * @param {() => number} [options.clock]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.politenessSecs] Per-host floor between requests.
 * @param {number} [options.robotsTtlMs]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 * @param {() => number} [options.jitter] Extra 0..n ms added to waits; tests pass `() => 0`.
 * @returns {(source: object) => Promise<{ status: number, rawList: Array<object> }>}
 */
export function createHttpFetcher(options = {}) {
  const ctx = {
    clock: options.clock ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: options.transport ?? nodeTransport,
    userAgent: options.userAgent ?? USER_AGENT,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? FETCH_MAX_BYTES,
    maxRedirects: options.maxRedirects ?? FETCH_MAX_REDIRECTS,
    politenessSecs: options.politenessSecs ?? DEFAULT_POLITENESS_SECS,
    robotsTtlMs: options.robotsTtlMs ?? ROBOTS_CACHE_TTL_MS,
    backoffBaseMs: options.backoffBaseMs ?? BACKOFF_BASE_MS,
    backoffMaxMs: options.backoffMaxMs ?? BACKOFF_MAX_MS,
    jitter: options.jitter ?? (() => Math.floor(Math.random() * 250)),
    hosts: new Map(),
  };

  return async function httpFetcher(source) {
    if (!source || !canFetch(source?.url)) {
      // Defense in depth — the worker never hands us these, but the
      // fetcher enforces the URL guard again per its own contract.
      throw new Error(`refusing to fetch non-http(s) URL: ${String(source?.url)}`);
    }
    const startUrl = fetchUrlFor(source);
    const { status, body, finalUrl } = await fetchWithRedirects(ctx, startUrl);
    if (status === 429 || status >= 500) {
      // The worker treats these as failures and doubles the source's
      // interval — the adaptive backoff half of the plan's promise.
      return { status, rawList: [] };
    }
    if (status < 200 || status >= 300) {
      return { status, rawList: [] };
    }
    let rawList = await parseFetchBody(ctx, source, body, finalUrl);
    return { status, rawList };
  };
}

/** Which URL the method actually fetches. `platform-api` hits the
 * structured endpoint (Shopify `/products.json`), everything else fetches
 * the source URL the probe verdict was stored against. */
function fetchUrlFor(source) {
  switch (source.scan_method) {
    case 'platform-api':
      return platformApiEndpoint(source);
    case 'feed':
    case 'structured-data':
    case 'sitemap':
    case 'heuristic':
      return source.url;
    default:
      throw new Error(`unknown scan_method: ${String(source.scan_method)}`);
  }
}

function platformApiEndpoint(source) {
  const platform = String(source.platform ?? '').toLowerCase();
  const url = String(source.url ?? '');
  if (platform === 'shopify' || /shopify|myshopify/i.test(url)) {
    return `${new URL(url).origin}/products.json?limit=250`;
  }
  if (platform === 'bandcamp' || /bandcamp/i.test(url)) {
    throw new Error('platform-api: Bandcamp fetch is not implemented yet');
  }
  if (platform === 'bigcartel' || /bigcartel/i.test(url)) {
    throw new Error('platform-api: Big Cartel fetch is not implemented yet');
  }
  throw new Error(`platform-api: unrecognized platform '${source.platform ?? ''}' for ${url}`);
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

function pathOf(url) {
  const u = new URL(url);
  return (u.pathname || '/') + (u.search || '');
}

function hostStateFor(ctx, host) {
  let state = ctx.hosts.get(host);
  if (!state) {
    state = {
      robots: null, // { rules, crawlDelaySecs, fetchedAt }
      crawlDelaySecs: 0,
      lastFetchAt: 0,
      backoffMs: 0,
      backoffUntil: 0,
    };
    ctx.hosts.set(host, state);
  }
  return state;
}

/** Load (or reuse the cached) robots.txt rules for a host. A failed
 * robots fetch is fail-open per RFC 9309 — the host just gets no rules. */
async function ensureRobots(ctx, host, startUrl) {
  const state = hostStateFor(ctx, host);
  const now = ctx.clock();
  if (state.robots && now - state.robots.fetchedAt < ctx.robotsTtlMs) return state.robots;
  const robotsUrl = `${new URL(startUrl).origin}/robots.txt`;
  let parsed = { rules: [], crawlDelaySecs: null };
  try {
    const res = await ctx.transport(robotsUrl, {
      headers: requestHeaders(ctx, robotsUrl),
      timeoutMs: ctx.timeoutMs,
      maxBytes: ctx.maxBytes,
    });
    if (res.status >= 200 && res.status < 300 && res.body) {
      parsed = parseRobots(res.body, 'waxbot');
    }
  } catch {
    // Fail-open: unreachable robots.txt imposes no rules.
  }
  state.robots = { ...parsed, fetchedAt: now };
  state.crawlDelaySecs = parsed.crawlDelaySecs ?? 0;
  return state.robots;
}

/** Wait out crawl-delay, the politeness floor, and any active backoff. */
async function waitPolite(ctx, state) {
  const now = ctx.clock();
  const wait = Math.max(
    0,
    state.crawlDelaySecs * 1000 - (now - state.lastFetchAt),
    ctx.politenessSecs * 1000 - (now - state.lastFetchAt),
    state.backoffUntil - now,
  );
  if (wait > 0) await ctx.sleep(wait + ctx.jitter());
}

/** Record a 429: honor Retry-After, otherwise escalate exponentially. */
function noteRateLimit(ctx, state, headers) {
  const now = ctx.clock();
  const retryAfter = parseRetryAfter(headers?.['retry-after'], now);
  if (retryAfter != null) {
    state.backoffUntil = Math.max(state.backoffUntil, retryAfter);
  } else {
    state.backoffMs = Math.min(
      state.backoffMs > 0 ? state.backoffMs * 2 : ctx.backoffBaseMs,
      ctx.backoffMaxMs,
    );
    state.backoffUntil = Math.max(state.backoffUntil, now + state.backoffMs);
  }
}

/** Retry-After is seconds or an HTTP date; returns the absolute ms timestamp, or null. */
function parseRetryAfter(value, now) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return now + secs * 1000;
  const when = Date.parse(String(value));
  return Number.isFinite(when) ? when : null;
}

function requestHeaders(ctx, url) {
  return {
    'user-agent': ctx.userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.1',
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET with redirect following. Each hop re-checks the target host's
 * robots.txt, the URL guard, and politeness — a redirect to a new host
 * does not inherit the old host's manners.
 */
async function fetchWithRedirects(ctx, startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= ctx.maxRedirects; hop++) {
    if (!canFetch(current)) {
      throw new Error(`refusing to follow redirect to non-http(s) URL: ${current}`);
    }
    const host = hostOf(current);
    const state = hostStateFor(ctx, host);
    await ensureRobots(ctx, host, current);
    const path = pathOf(current);
    if (!robotsAllows(state.robots.rules, path)) {
      throw new RobotsDisallowedError(current, host);
    }
    await waitPolite(ctx, state);

    const res = await ctx.transport(current, {
      headers: requestHeaders(ctx, current),
      timeoutMs: ctx.timeoutMs,
      maxBytes: ctx.maxBytes,
    });
    state.lastFetchAt = ctx.clock();

    if (res.status === 429) {
      noteRateLimit(ctx, state, res.headers);
      return { status: 429, body: '', finalUrl: current };
    }
    // Any non-429 response resets the congestion backoff for this host.
    state.backoffMs = 0;

    if (REDIRECT_STATUSES.has(res.status) && res.headers?.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { status: res.status, body: res.body ?? '', finalUrl: current };
  }
  throw new Error(`too many redirects (>${ctx.maxRedirects}) starting at ${startUrl}`);
}

/** Parse the fetched body per the source's scan method. */
async function parseFetchBody(ctx, source, body, finalUrl) {
  switch (source.scan_method) {
    case 'platform-api': {
      let json;
      try {
        json = JSON.parse(body);
      } catch (err) {
        throw new Error(`platform-api: invalid JSON from ${finalUrl}: ${err.message}`);
      }
      return parseShopifyProducts(json, finalUrl);
    }
    case 'feed':
      return parseFeedItems(body);
    case 'structured-data':
      return parseJsonLdProducts(body);
    case 'sitemap': {
      const { records, isIndex } = parseSitemapUrls(body);
      if (isIndex && records.length) {
        // Sitemapindex: follow child sitemaps one level, bounded, with the
        // same politeness and robots rules as everything else.
        const merged = [];
        for (const child of records.slice(0, SITEMAP_CHILD_LIMIT)) {
          const res = await fetchWithRedirects(ctx, child.url);
          if (res.status >= 200 && res.status < 300) {
            merged.push(...parseSitemapUrls(res.body).records);
          }
        }
        return merged.length ? merged : records;
      }
      return records;
    }
    case 'heuristic':
      return parseHeuristicCards(body, finalUrl);
    default:
      throw new Error(`unknown scan_method: ${String(source.scan_method)}`);
  }
}
