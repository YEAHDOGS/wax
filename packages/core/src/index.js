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
 * | `probe.js`    | Scannability probe (alert engine gate 1). Pure decision    |
 * |               | logic, zero network I/O.                                  |
 * | `scanner.js`  | Scan loop core (alert engine gate 2): normalize product     |
 * |               | lists, snapshot hashing, diffing, artist matching,         |
 * |               | cross-source dedupe. Pure logic, zero network I/O.        |
 * | `tracking.js` | Per-site tracking config (alert engine gates 3+): add/      |
 * |               | update/remove/list merch sites with probe verdicts,        |
 * |               | pause and interval control, free-tier caps.                |
 * | `notify.js`   | Alert delivery content (plan §3): drop email/SMS            |
 * |               | formatting, digest folding, per-user rate-limit gate.      |
 * |               | Pure decision logic — providers wire up later.             |
 * | `poller.js`   | Scan worker (plan §2): due-source queue, fetch dispatch,    |
 * |               | snapshot persistence, adaptive backoff, scan log, and the   |
 * |               | alert feed into the notify path. Fetcher is injected —     |
 * |               | zero network I/O here.                                      |
 * | `fetcher.js`  | Real HTTP fetcher (plan §2): WaxBot user-agent, robots.txt   |
 * |               | + crawl-delay, per-host politeness, adaptive backoff,     |
 * |               | per-method parsers. The production `fetcher` for the       |
 * |               | worker above; transport is injectable for tests.          |
 * | `dispatch.js`  | Pluggable delivery channels (plan §3): webhook, log,       |
 * |               | Resend/Twilio stubs, exactly-once dispatch with receipts.    |
 * | `rules.js`    | Alert rule engine (plan §4 item 4, after dispatch): watch      |
 * |               | rule matchers + conditions, dedupe, quiet hours, digest      |
 * |               | batching. Pure decision logic — the worker persists.        |
 * | `dashboard.js`| Watchlist status view (plan §4 item 6): artists, sites,    |
 * |               | alerts as plain text. Pure render — see `bin/wax`.         |
 * | `digest.js`   | Digest queue (plan §3, the rest of notify's rate contract):   |
 * |               | queue held-back deliveries, flush due digest emails with  |
 * |               | quiet-hours gating. Channel is injected — zero network.    |
 * | `closeout.js` | Alert close-out (plan §3, the wiring the pieces were       |
 * |               | missing): `runWorkerTick` is the cron entry point — scan  |
 * |               | every due source, dispatch what may go, queue held        |
 * |               | deliveries into the digest queue, flush due digests.      |
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
export {
  PLANS,
  SERIES_PRICE_CENTS,
  SERIES_CURRENCY,
  TRIAL_DAYS,
  startTrial,
  expireTrials,
  activateSeries,
  checkoutSession,
  getCheckoutSession,
} from './billing.js';
export { store, createStore, newId, newToken } from './store.js';
export { seed } from './seed.js';
export { TYPES_VERSION } from './types.js';
export { probeScannability, PROBE_METHODS, PROBE_FAILURE_REASONS } from './probe.js';
export {
  addSource,
  updateSource,
  removeSource,
  listSources,
  FREE_SOURCE_LIMIT,
  MIN_SCAN_INTERVAL_SECS,
} from './tracking.js';
export {
  formatPrice,
  formatDropEmail,
  formatDropSms,
  formatDigest,
  shouldDispatch,
  SMS_PER_HOUR_CAP,
  EMAIL_PER_HOUR_CAP,
} from './notify.js';
export {
  USER_AGENT,
  BASE_SCAN_INTERVAL_SECS,
  MAX_SCAN_INTERVAL_SECS,
  PASS_LIMIT,
  canFetch,
  selectDueSources,
  escalateIntervalSecs,
  watchedArtists,
  sentThisWindow,
  recordScanLog,
  scanOneSource,
  runScanPass,
} from './poller.js';
export { renderDashboard } from './dashboard.js';
export { renderAlertHistory } from './alert-history.js';
export {
  createHttpFetcher,
  RobotsDisallowedError,
  parseRobots,
  robotsAllows,
  parseShopifyProducts,
  parseFeedItems,
  parseJsonLdProducts,
  parseSitemapUrls,
  parseHeuristicCards,
  FETCH_TIMEOUT_MS,
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  DEFAULT_POLITENESS_SECS,
  ROBOTS_CACHE_TTL_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} from './fetcher.js';
export {
  normalizeProduct,
  normalizeProductList,
  snapshotHash,
  diffSnapshots,
  scanSnapshot,
  matchArtists,
  dedupeCandidates,
} from './scanner.js';
export {
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_MAX_BODY_BYTES,
  PROVIDER_TIMEOUT_MS,
  canPost,
  assertChannel,
  createWebhookChannel,
  createLogChannel,
  createResendChannel,
  createTwilioChannel,
  dispatchAlert,
  dispatchScanAlerts,
} from './dispatch.js';
export {
  normText,
  alertDedupeKey,
  parseQuietBound,
  isQuietHour,
  evaluateWatchRule,
  alreadyAlerted,
  routeAlert,
  routeAlerts,
  shouldFlushDigest,
  buildDigestBatch,
  ROUTE,
} from './rules.js';
export {
  DIGEST_MIN_INTERVAL_MS,
  DIGEST_MAX_AGE_MS,
  DIGEST_MAX_ITEMS,
  queueHeldAlerts,
  flushDigestQueue,
} from './digest.js';
export {
  filterAlreadyAlerted,
  runAlertCloseout,
  runWorkerTick,
} from './closeout.js';
