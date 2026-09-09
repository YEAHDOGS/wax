/**
 * @file Scannability probe — the first gate of the alert engine.
 *
 * ## Why this file exists
 *
 * A user pastes a merch site URL. Before Wax promises to watch it, the probe
 * answers one question synchronously, in seconds: *can this page's
 * new-release/stock list be scanned cheaply and reliably?*
 *
 * `docs/ALERT-ENGINE-PLAN.md` defines the probe order (cheapest reliable
 * signal first): feed discovery → platform APIs → JSON-LD → sitemap → HTML
 * heuristic. This module is the pure decision logic for that order.
 *
 * ## What this file is not
 *
 * It is not a fetcher. It performs zero network I/O: the caller fetches the
 * page (honouring robots.txt, crawl-delay, and the `WaxBot/1.0` user-agent)
 * and hands the result to `probeScannability`. That split is what keeps this
 * logic unit-testable against fixture strings with no live scraping.
 *
 * ## Verdicts
 *
 *   { scannable: true, method, confidence, detail }   — method is one of
 *        'feed' | 'platform-api' | 'structured-data' | 'sitemap' | 'heuristic'
 *        confidence is 'high' | 'medium' | 'low'
 *   { scannable: false, method: null, confidence: 'none', reason, detail } —
 *        reason is one of 'bot-wall' | 'login-required' | 'js-spa' |
 *        'no-product-structure'
 *
 * Never silently accept an unscannable site — the caller renders the reason
 * verbatim in the UI verdict so the user knows what blocked it.
 */

/**
 * Methods ordered by probe order — the first match wins, so this array is
 * also the priority table. Do not reorder without updating the plan doc.
 */
export const PROBE_METHODS = ['feed', 'platform-api', 'structured-data', 'sitemap', 'heuristic'];

/** Reasons a site verdicts NOT SCANNABLE. */
export const PROBE_FAILURE_REASONS = ['bot-wall', 'login-required', 'js-spa', 'no-product-structure'];

/**
 * Decide whether a fetched merch page can be scanned.
 *
 * @param {object} input
 * @param {string} input.url      The page URL that was fetched.
 * @param {string} input.html     The raw HTML of the fetched page.
 * @param {string} [input.headers] Optional `Content-Type`-ish header string; only used to spot non-HTML payloads.
 * @returns {object} The verdict, shaped as documented above.
 */
export function probeScannability({ url, html }) {
  if (!url || typeof url !== 'string') {
    throw new Error('probeScannability: url is required');
  }
  const doc = (html ?? '').toString();
  if (!doc.trim()) {
    return notScannable('no-product-structure', 'The page returned an empty document.');
  }

  const wall = detectBotWall(doc);
  if (wall) return notScannable('bot-wall', wall);

  const login = detectLoginWall(doc);
  if (login) return notScannable('login-required', login);

  const feed = detectFeed(doc);
  if (feed) return scannable('feed', 'high', `Feed found: ${feed}`);

  const platform = detectPlatform(doc);
  if (platform) {
    return scannable('platform-api', 'high', `${platform.name} storefront — structured product endpoint at ${platform.endpoint}`);
  }

  const structured = detectJsonLd(doc);
  if (structured) return scannable('structured-data', 'medium', structured);

  const sitemap = detectSitemap(doc, url);
  if (sitemap) return scannable('sitemap', 'medium', `Sitemap referenced: ${sitemap}`);

  const heuristic = detectProductGrid(doc);
  if (heuristic) {
    return scannable('heuristic', 'low', `Product-grid heuristic: ${heuristic.count} product-like cards (${heuristic.priceHits} with prices). Flagged fragile — confirm by eye.`);
  }

  if (detectJsSpaShell(doc)) {
    return notScannable('js-spa', 'JavaScript-rendered shell with no server-rendered product content — needs a headless renderer.');
  }

  return notScannable('no-product-structure', 'No feed, platform marker, structured data, sitemap, or product grid found.');
}

/** @returns {object} A SCANNABLE verdict. */
function scannable(method, confidence, detail) {
  return { scannable: true, method, confidence, reason: null, detail };
}

/** @returns {object} A NOT SCANNABLE verdict. */
function notScannable(reason, detail) {
  return { scannable: false, method: null, confidence: 'none', reason, detail };
}

/**
 * Feed discovery — the cheapest reliable signal. A `<link rel="alternate"
 * type="application/rss+xml|atom+xml">` means scanning is trivial.
 */
function detectFeed(doc) {
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of doc.match(linkRe) ?? []) {
    if (!/\brel=["']?alternate["']?/i.test(tag)) continue;
    if (!/type=["']?(?:application\/(?:rss|atom)\+xml|text\/xml)["']?/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    return href?.[1] ?? 'feed link without href';
  }
  return null;
}

/**
 * Platform API detection — Shopify, Bandcamp, Big Cartel. Structured JSON
 * endpoints, no scraping required.
 */
function detectPlatform(doc) {
  if (/cdn\.shopify\.(com|io)|shopifycdn|Shopify\.shop\s*=/i.test(doc)) {
    return { name: 'Shopify', endpoint: '/products.json' };
  }
  if (/\bbandcamp\.com\b/i.test(doc) || /\bBandData\s*=/.test(doc)) {
    return { name: 'Bandcamp', endpoint: 'public discography endpoints' };
  }
  if (/\bbigcartel\.com\b|\.bigcartel\.com/i.test(doc)) {
    return { name: 'Big Cartel', endpoint: 'shop API' };
  }
  return null;
}

/**
 * JSON-LD structured data — `Product` / `ItemList` blocks embedded in the
 * page. Reports how many product-ish nodes were found.
 */
function detectJsonLd(doc) {
  const blocks = doc.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  let productNodes = 0;
  for (const block of blocks) {
    let parsed;
    try {
      const raw = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON-LD is not our signal
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (node && typeof node === 'object' && /^(Product|ItemList|MusicAlbum|MusicRelease)$/i.test(node['@type'] ?? '')) {
        productNodes += 1;
      }
    }
  }
  if (productNodes > 0) {
    return `${productNodes} product-ish JSON-LD node${productNodes === 1 ? '' : 's'}`;
  }
  return null;
}

/**
 * Sitemap reference — `sitemap.xml` mentioned in robots meta or link.
 * Product URLs can be diffed on each scan.
 */
function detectSitemap(doc, url) {
  const meta = doc.match(/<link\b[^>]*rel=["']?sitemap["']?[^>]*>/i);
  if (meta) {
    const href = meta[0].match(/href=["']([^"']+)["']/i);
    return href?.[1] ?? 'sitemap link';
  }
  try {
    const origin = new URL(url).origin;
    if (/sitemap\.xml/i.test(doc)) return `${origin}/sitemap.xml (referenced in page)`;
  } catch {
    /* url validation happened above; unreachable */
  }
  return null;
}

/**
 * HTML heuristic — product-grid detection. Counts cards that look like a
 * product tile: an image, a title-ish heading or link, and a price pattern.
 * Lowest confidence, flagged fragile.
 */
function detectProductGrid(doc) {
  const priceRe = /(?:[$€£¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP))/g;
  const priceHits = (doc.match(priceRe) ?? []).length;
  if (priceHits < 3) return null;

  const cardRe = /<(?:article|div|li|a)\b[^>]*(?:class|data-test-id|data-product)[^>]*>/gi;
  const cards = doc.match(cardRe) ?? [];
  const withImg = cards.filter((tag) => /product|card|item|tile/i.test(tag)).length;
  const imgRe = /<img\b[^>]*>/gi;
  const images = (doc.match(imgRe) ?? []).length;

  const count = Math.min(withImg || cards.length, images);
  if (count >= 3 && priceHits >= 3) {
    return { count, priceHits };
  }
  return null;
}

/**
 * Bot-wall detection — Cloudflare / generic IAM challenge pages. These are
 * the "never silently accept" cases: scanning is blocked outright.
 */
function detectBotWall(doc) {
  const markers = [
    [/why did this happen\?.*?cloudflare/i, 'Cloudflare challenge page'],
    [/cf-challenge|<div[^>]*id=["']?cf-[^"']*["']?/i, 'Cloudflare challenge markup'],
    [/Attention Required!?\s*\|\s*Cloudflare/i, 'Cloudflare "Attention Required" wall'],
    [/perimeterx|px-captcha|human verification/i, 'bot-mitigation challenge page'],
    [/are you a robot|captcha/i, 'CAPTCHA interstitial'],
  ];
  for (const [re, label] of markers) {
    if (re.test(doc)) return label;
  }
  return null;
}

/**
 * Login-required detection — the page is a sign-in form with no product
 * content around it.
 */
function detectLoginWall(doc) {
  const hasLoginForm = /<form\b[^>]*>/i.test(doc) && /type=["']?password["']?/i.test(doc);
  if (!hasLoginForm) return null;
  const priceRe = /[$€£¥]\s?\d[\d.,]*/g;
  const productImg = /<img\b[^>]*>/gi;
  const hasProducts = ((doc.match(priceRe) ?? []).length >= 3) && ((doc.match(productImg) ?? []).length >= 3);
  if (!hasProducts) return 'Sign-in form with no product content — the catalog sits behind login.';
  return null;
}

/**
 * JS-SPA shell — a root mount div plus bundle scripts, with almost no
 * server-rendered text. Scanning without a headless renderer will fail.
 */
function detectJsSpaShell(doc) {
  const mount = /<div\b[^>]*(?:id=["']?(?:root|app|__next|__nuxt)["']?)[^>]*>\s*<\/div>/i.test(doc);
  const text = doc.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  const wordCount = (text.match(/\S+/g) ?? []).length;
  return mount && wordCount < 50;
}
