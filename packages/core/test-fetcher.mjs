/**
 * Smoke/regression check for `packages/core/src/fetcher.js` — the real
 * HTTP fetcher (ALERT-ENGINE-PLAN.md §2, second half).
 *
 * Run: `node --test packages/core/test-fetcher.mjs`
 * No dependencies beyond the Node standard library. There is NO live HTTP
 * here, ever: every test injects a fake `transport`, a fake clock, and a
 * fake sleep, so robots.txt honoring, crawl-delay, adaptive backoff, and
 * the per-method parsers are pinned without touching the network. The
 * default `nodeTransport` (SSRF guard, timeouts, size caps) is construction
 * code only — it is never invoked by these tests.
 *
 * These tests pin the fetcher's contract with the worker: the WaxBot
 * user-agent, robots disallow as a throwing failure, crawl-delay sleeps,
 * 429/backoff behavior the worker turns into interval doubling, and raw
 * record shapes `scanner.js` normalizes. If any fail, the polite-fetch
 * contract with the alert engine has changed, and that is the regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  USER_AGENT,
  createHttpFetcher,
  RobotsDisallowedError,
  parseRobots,
  robotsAllows,
  parseShopifyProducts,
  normalizeProduct,
  normalizeProductList,
  runScanPass,
  scanOneSource,
} from './src/index.js';

/* ------------------------------------------------------------------ *
 * Harness: fake transport, fake clock, fake sleep.
 * ------------------------------------------------------------------ */

/** Controllable clock + sleep ledger. `advance()` is never called by the
 * fetcher; time moves only through recorded sleeps. */
function fakeTime(startMs = 1_000_000) {
  const state = { now: startMs, slept: [] };
  return {
    clock: () => state.now,
    sleep: async (ms) => {
      state.slept.push(ms);
      state.now += ms;
    },
    get slept() {
      return state.slept;
    },
    get now() {
      return state.now;
    },
  };
}

/**
 * Fake transport: `routes` maps exact URL → { status, headers, body } (or a
 * function, or an Error to throw). A URL with no route *throws* — which is
 * also how robots.txt fail-open is exercised. `calls` records every hit.
 */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (url, { headers }) => {
    calls.push({ url, headers });
    const route = routes[url];
    if (!route) throw new Error(`no route for ${url}`);
    const res = typeof route === 'function' ? route(url, calls) : route;
    if (res instanceof Error) throw res;
    return {
      status: res.status ?? 200,
      headers: Object.fromEntries(
        Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: res.body ?? '',
    };
  };
  transport.calls = calls;
  return transport;
}

/** Minimal store data for the worker-integration tests. */
function makeWorkerData() {
  return {
    users: [
      {
        id: 'usr_1', email: 'a@example.com', handle: 'a', display_name: 'A',
        plan: 'free', phone: null, phone_verified: false, email_verified: true,
      },
    ],
    profiles: [],
    follows: [],
    artists: [
      { id: 'art_miles', name: 'Miles Davis', discogs_artist_id: 1, image_url: null, genres: [] },
    ],
    releases: [],
    tracks: [],
    sources: [
      {
        id: 'src_shop', user_id: 'usr_1', url: 'https://shop.example/new',
        label: 'Shop', platform: 'shopify', scan_method: 'platform-api',
        scannable: true, scannable_reason: 'Shopify /products.json',
        snapshot_hash: null, scan_interval_secs: 60, paused: false,
        last_scan_at: null, consecutive_failures: 0,
      },
    ],
    watches: [
      { id: 'wtc_1', user_id: 'usr_1', artist_id: 'art_miles', watch_vinyl: true, merch_types: [], target_price_cents: null, channels: ['email'] },
    ],
    alerts: [],
    crateItems: [],
    wantlistItems: [],
    pricePoints: [],
    activity: [],
    scanLogs: [],
    scanSnapshots: [],
  };
}

const SHOPIFY_V1 = {
  products: [
    { title: 'Kind of Blue — 180g Vinyl LP', vendor: 'Miles Davis', handle: 'kind-of-blue', images: [{ src: 'https://cdn/x.jpg' }], variants: [{ price: '29.99' }] },
    { title: 'Bitches Brew Limited Edition', vendor: 'Miles Davis', handle: 'bitches-brew', images: [{ src: 'https://cdn/y.jpg' }], variants: [{ price: '44.99' }] },
  ],
};

const SHOPIFY_V2 = {
  products: [
    ...SHOPIFY_V1.products,
    { title: 'Time Out LP', vendor: 'Miles Davis', handle: 'time-out', images: [{ src: 'https://cdn/z.jpg' }], variants: [{ price: '24.99' }] },
  ],
};

function shopifyRoutes(productsJson, robotsBody = null) {
  const routes = {
    'https://shop.example/products.json?limit=250': { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(productsJson) },
  };
  if (robotsBody != null) {
    routes['https://shop.example/robots.txt'] = { status: 200, body: robotsBody };
  }
  return routes;
}

/* ------------------------------------------------------------------ *
 * Identity + guards
 * ------------------------------------------------------------------ */

test('fetcher sends the WaxBot user-agent on every request', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://ua.example/feed.xml': {
      status: 200,
      body: '<rss version="2.0"><channel></channel></rss>',
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  await fetcher({ url: 'https://ua.example/feed.xml', scan_method: 'feed' });
  assert.ok(transport.calls.length >= 1);
  for (const call of transport.calls) {
    assert.equal(call.headers['user-agent'], USER_AGENT);
  }
  assert.match(USER_AGENT, /^WaxBot\/1\.0/);
});

test('fetcher refuses non-http(s) URLs, and unknown scan methods', async () => {
  const t = fakeTime();
  const fetcher = createHttpFetcher({ transport: fakeTransport({}), clock: t.clock, sleep: t.sleep, jitter: () => 0 });
  await assert.rejects(
    fetcher({ url: 'file:///etc/passwd', scan_method: 'feed' }),
    /non-http/,
  );
  await assert.rejects(
    fetcher({ url: 'https://x.example/', scan_method: 'telepathy' }),
    /unknown scan_method/,
  );
});

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

test('parseRobots: WaxBot group wins over the wildcard group', () => {
  const parsed = parseRobots(
    'User-agent: WaxBot\nDisallow: /new\nCrawl-delay: 5\n\nUser-agent: *\nDisallow: /secret\nCrawl-delay: 1\n',
  );
  assert.equal(parsed.crawlDelaySecs, 5);
  assert.equal(robotsAllows(parsed.rules, '/new'), false);
  assert.equal(robotsAllows(parsed.rules, '/secret'), true);
  assert.equal(robotsAllows(parsed.rules, '/'), true);
});

test('parseRobots: longest rule wins, ties go to Allow, empty Disallow allows all', () => {
  const parsed = parseRobots(
    'User-agent: *\nDisallow: /shop\nAllow: /shop/new\nDisallow:\n',
  );
  assert.equal(robotsAllows(parsed.rules, '/shop/hidden'), false);
  assert.equal(robotsAllows(parsed.rules, '/shop/new'), true);
  assert.equal(robotsAllows(parsed.rules, '/'), true);
  assert.equal(robotsAllows(parsed.rules, '/shop/new?x=1&y=2'), true);
});

test('fetcher throws RobotsDisallowedError on a disallowed path, allows the rest', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://rb.example/robots.txt': {
      status: 200,
      body: 'User-agent: *\nDisallow: /new\n',
    },
    'https://rb.example/other': { status: 200, body: '<html></html>' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  await assert.rejects(
    fetcher({ url: 'https://rb.example/new', scan_method: 'heuristic' }),
    (err) => {
      assert.ok(err instanceof RobotsDisallowedError);
      assert.equal(err.code, 'ROBOTS_DISALLOWED');
      return true;
    },
  );
  const ok = await fetcher({ url: 'https://rb.example/other', scan_method: 'heuristic' });
  assert.equal(ok.status, 200);
});

test('robots.txt fetch failure is fail-open: the fetch proceeds', async () => {
  const t = fakeTime();
  // No route for /robots.txt → transport throws → permissive.
  const transport = fakeTransport({
    'https://fo.example/page': { status: 200, body: '<html></html>' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://fo.example/page', scan_method: 'heuristic' });
  assert.equal(res.status, 200);
  assert.ok(transport.calls.some((c) => c.url === 'https://fo.example/robots.txt'));
});

/* ------------------------------------------------------------------ *
 * crawl-delay + politeness
 * ------------------------------------------------------------------ */

test('crawl-delay is honored between sequential fetches', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://cd.example/robots.txt': { status: 200, body: 'User-agent: *\nCrawl-delay: 2\n' },
    'https://cd.example/a': { status: 200, body: '<rss version="2.0"><channel></channel></rss>' },
    'https://cd.example/b': { status: 200, body: '<rss version="2.0"><channel></channel></rss>' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const source = (url) => ({ url, scan_method: 'feed' });
  await fetcher(source('https://cd.example/a'));
  await fetcher(source('https://cd.example/b'));
  // First contact goes out immediately; the second waits the full 2s crawl-delay.
  assert.deepEqual(t.slept, [2000]);
  // The robots fetch itself carries the user-agent too.
  assert.ok(transport.calls.some((c) => c.url === 'https://cd.example/robots.txt'));
});

test('a WaxBot crawl-delay beats the politeness floor', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://cd2.example/robots.txt': { status: 200, body: 'User-agent: WaxBot\nCrawl-delay: 5\n' },
    'https://cd2.example/feed.xml': { status: 200, body: '<rss version="2.0"><channel></channel></rss>' },
  });
  const fetcher = createHttpFetcher({
    transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 1,
  });
  const source = { url: 'https://cd2.example/feed.xml', scan_method: 'feed' };
  await fetcher(source);
  await fetcher(source);
  assert.ok(t.slept.some((ms) => ms >= 5000), `expected a >=5s sleep, got ${JSON.stringify(t.slept)}`);
});

/* ------------------------------------------------------------------ *
 * 429 / backoff
 * ------------------------------------------------------------------ */

test('429 returns a failure the worker backs off on, and Retry-After is honored', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://rl.example/products.json?limit=250': {
      status: 429,
      headers: { 'retry-after': '5' },
      body: '',
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const source = { url: 'https://rl.example/new', scan_method: 'platform-api', platform: 'shopify' };

  const first = await fetcher(source);
  assert.deepEqual(first, { status: 429, rawList: [] });

  const second = await fetcher(source);
  assert.equal(second.status, 429);
  // The second fetch waited out the 5s Retry-After before trying.
  assert.ok(t.slept.some((ms) => ms >= 5000), `expected a >=5s sleep, got ${JSON.stringify(t.slept)}`);
});

test('repeated 429s without Retry-After escalate exponentially', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://bo.example/products.json?limit=250': { status: 429, headers: {}, body: '' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const source = { url: 'https://bo.example/new', scan_method: 'platform-api', platform: 'shopify' };

  await fetcher(source); // 429 → backoff 5s
  await fetcher(source); // sleeps 5s, 429 → backoff 10s
  await fetcher(source); // sleeps 10s
  assert.deepEqual(t.slept, [5000, 10000]);
});

test('a 429 through the worker doubles the source interval and logs the failure', async () => {
  const t = fakeTime();
  const store = createStore(makeWorkerData());
  const transport = fakeTransport({
    'https://shop.example/products.json?limit=250': { status: 429, headers: {}, body: '' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const source = store.sources.find((s) => s.id === 'src_shop');

  const result = await scanOneSource({ store, source, fetcher, nowMs: t.now });
  assert.equal(result.ok, false);
  assert.equal(result.matches.length, 0);

  const row = store.sources.find((s) => s.id === 'src_shop');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.scan_interval_secs, 120); // 60 → 120
  const log = store.scanLogs.filter((l) => l.source_id === 'src_shop').at(-1);
  assert.equal(log.outcome, 'fetch_failed');
  assert.match(log.error, /HTTP 429/);
});

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

test('redirects are followed; non-http(s) redirect targets are refused', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://rd.example/old': { status: 301, headers: { location: '/new' }, body: '' },
    'https://rd.example/new': {
      status: 200,
      body: '<html><head><meta property="og:site_name" content="RD Shop"></head>' +
        '<body><a href="/p/1"><img src="/i/1.jpg"><h3>Cool LP</h3><span>$19.99</span></a></body></html>',
    },
    'https://rd.example/evil': { status: 301, headers: { location: 'ftp://x.example/f' }, body: '' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });

  const res = await fetcher({ url: 'https://rd.example/old', scan_method: 'heuristic' });
  assert.equal(res.status, 200);
  assert.equal(res.rawList.length, 1);
  assert.equal(res.rawList[0].title, 'Cool LP');
  assert.equal(res.rawList[0].url, 'https://rd.example/p/1');

  await assert.rejects(
    fetcher({ url: 'https://rd.example/evil', scan_method: 'heuristic' }),
    /non-http/,
  );
});

/* ------------------------------------------------------------------ *
 * Per-method parsers
 * ------------------------------------------------------------------ */

test('platform-api: Shopify products.json shape normalizes cleanly', () => {
  const raw = parseShopifyProducts(
    {
      products: [
        { title: 'T', vendor: 'V', handle: 't', images: [{ src: 'https://cdn/i.jpg' }], variants: [{ price: '$29.99' }] },
      ],
    },
    'https://shop.example/new',
  );
  assert.deepEqual(raw, [
    { title: 'T', vendor: 'V', url: 'https://shop.example/products/t', image: 'https://cdn/i.jpg', price: '$29.99' },
  ]);
  const p = normalizeProduct(raw[0], 'platform-api');
  assert.equal(p.price_cents, 2999);
  assert.equal(p.currency, 'USD');
});

test('platform-api: invalid JSON is a throwing failure, not an empty scan', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://bj.example/products.json?limit=250': { status: 200, body: 'this is not json' },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  await assert.rejects(
    fetcher({ url: 'https://bj.example/new', scan_method: 'platform-api', platform: 'shopify' }),
    /invalid JSON/,
  );
});

test('feed: RSS items become records the scanner accepts', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://feed.example/feed.xml': {
      status: 200,
      body: `<rss version="2.0"><channel>
        <item><title><![CDATA[Bitches Brew LP]]></title><link>https://feed.example/bb</link><dc:creator>Miles Davis</dc:creator><enclosure url="https://feed.example/t.jpg" type="image/jpeg"/></item>
      </channel></rss>`,
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://feed.example/feed.xml', scan_method: 'feed' });
  assert.equal(res.status, 200);
  assert.equal(res.rawList.length, 1);
  const p = normalizeProduct(res.rawList[0], 'feed');
  assert.equal(p.title, 'Bitches Brew LP');
  assert.equal(p.artist, 'Miles Davis');
  assert.equal(p.url, 'https://feed.example/bb');
  assert.equal(p.image, 'https://feed.example/t.jpg');
});

test('structured-data: JSON-LD Product nodes (incl. ItemList) become records', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://ld.example/shop': {
      status: 200,
      body: `<html><head><script type="application/ld+json">
        {"@type":"ItemList","itemListElement":[
          {"@type":"Product","name":"A Love Supreme LP","brand":{"name":"Blue Note Shop"},"url":"https://ld.example/als","image":"https://ld.example/a.jpg","offers":{"price":"27.50","priceCurrency":"USD"}}
        ]}
      </script></head><body></body></html>`,
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://ld.example/shop', scan_method: 'structured-data' });
  assert.equal(res.rawList.length, 1);
  const p = normalizeProduct(res.rawList[0], 'structured-data');
  assert.equal(p.title, 'A Love Supreme LP');
  assert.equal(p.artist, 'Blue Note Shop');
  assert.equal(p.price_cents, 2750);
  assert.equal(p.currency, 'USD');
});

test('heuristic: product cards extract with the site name as vendor', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://hz.example/': {
      status: 200,
      body: `<html><head><meta property="og:site_name" content="Miles Davis Official Store"></head><body>
        <a href="/p/a"><img src="/i/a.jpg"><h3>Kind of Blue LP</h3><span>$29.99</span></a>
        <a href="/p/b"><img src="/i/b.jpg"><h3>Sketches of Spain LP</h3><span>$24.99</span></a>
        <a href="/about">About us</a>
      </body></html>`,
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://hz.example/', scan_method: 'heuristic' });
  assert.equal(res.rawList.length, 2);
  assert.equal(res.rawList[0].title, 'Kind of Blue LP');
  assert.equal(res.rawList[0].vendor, 'Miles Davis Official Store');
  assert.equal(res.rawList[0].url, 'https://hz.example/p/a');
  assert.equal(res.rawList[0].image, 'https://hz.example/i/a.jpg');
  const p = normalizeProduct(res.rawList[0], 'heuristic');
  assert.equal(p.price_cents, 2999);
});

test('sitemap: URL records surface as skipped, honestly — no fabricated artists', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://sm.example/sitemap.xml': {
      status: 200,
      body: `<urlset><url><loc>https://sm.example/vinyl/kind-of-blue-lp</loc></url></urlset>`,
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://sm.example/sitemap.xml', scan_method: 'sitemap' });
  assert.equal(res.rawList.length, 1);
  assert.equal(res.rawList[0].url, 'https://sm.example/vinyl/kind-of-blue-lp');
  assert.equal(res.rawList[0].artist, null);
  // The scanner drops them (no artist to match on) — the scan log shows it.
  const { products, skipped } = normalizeProductList(res.rawList, 'sitemap');
  assert.equal(products.length, 0);
  assert.equal(skipped, 1);
});

test('sitemap: a sitemapindex is followed one level, bounded', async () => {
  const t = fakeTime();
  const transport = fakeTransport({
    'https://si.example/sitemap.xml': {
      status: 200,
      body: `<sitemapindex>
        <sitemap><loc>https://si.example/s1.xml</loc></sitemap>
        <sitemap><loc>https://si.example/s2.xml</loc></sitemap>
      </sitemapindex>`,
    },
    'https://si.example/s1.xml': {
      status: 200,
      body: `<urlset><url><loc>https://si.example/p/one</loc></url></urlset>`,
    },
    'https://si.example/s2.xml': {
      status: 200,
      body: `<urlset><url><loc>https://si.example/p/two</loc></url></urlset>`,
    },
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });
  const res = await fetcher({ url: 'https://si.example/sitemap.xml', scan_method: 'sitemap' });
  assert.deepEqual(
    res.rawList.map((r) => r.url).sort(),
    ['https://si.example/p/one', 'https://si.example/p/two'],
  );
});

/* ------------------------------------------------------------------ *
 * End-to-end wiring: real fetcher + real worker, fake network
 * ------------------------------------------------------------------ */

test('wiring: runScanPass with the real HTTP fetcher — baseline, then one alert on restock', async () => {
  const t = fakeTime(Date.parse('2026-09-09T12:00:00.000Z'));
  const store = createStore(makeWorkerData());
  let catalog = SHOPIFY_V1;
  const transport = fakeTransport({
    'https://shop.example/robots.txt': { status: 404, body: '' },
    'https://shop.example/products.json?limit=250': () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(catalog),
    }),
  });
  const fetcher = createHttpFetcher({ transport, clock: t.clock, sleep: t.sleep, jitter: () => 0, politenessSecs: 0 });

  const pass1 = await runScanPass({ store, fetcher, nowMs: t.now });
  assert.equal(pass1.due, 1);
  assert.equal(pass1.succeeded, 1);
  assert.equal(pass1.newAlerts, 0, 'baseline never alerts');

  // The products.json endpoint — not the shop page — is what got fetched.
  assert.ok(
    transport.calls.some((c) => c.url === 'https://shop.example/products.json?limit=250'),
    'fetcher hit /products.json for the platform-api source',
  );

  catalog = SHOPIFY_V2;
  const pass2 = await runScanPass({ store, fetcher, nowMs: t.now + 61_000 });
  assert.equal(pass2.newAlerts, 1);
  const alert = pass2.alerts[0];
  assert.equal(alert.artist_name, 'Miles Davis');
  assert.equal(alert.title, 'Time Out LP');
  assert.equal(alert.listing_url, 'https://shop.example/products/time-out');
  assert.equal(alert.deliveries[0].channel, 'email');
  assert.equal(alert.deliveries[0].verdict.dispatch, true);
});
