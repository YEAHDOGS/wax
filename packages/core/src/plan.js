/**
 * @file Read-path plan enforcement. Leaf module — no imports, no cycles.
 *
 * The hourly `expireTrials` sweep in `billing.js` is the writer: it flips
 * expired trials to `free` in the store. But dispatch runs between sweeps —
 * up to an hour after a trial ends — and trusting the stale row would keep
 * handing a lapsed trial the series features (unlimited watches/sources,
 * SMS sends) until the next sweep lands. The read path must not trust it.
 *
 * `effectivePlan` is the read-path counterpart: a `trial` whose
 * `trial_ends_at` is past returns `'free'`, exactly what the sweep will
 * write. Pure, clock-injectable, no store access — callers pass the row
 * they already have (`effectivePlan(user, { now })`).
 *
 * Enforcement points (dispatch + free-tier gates):
 * - `poller.js` `buildAlerts` — the `plan` handed to `shouldDispatch`
 * - `handlers.js` `addWatch` — the FREE_WATCH_LIMIT gate
 * - `tracking.js` `addSource` — the FREE_SOURCE_LIMIT gate
 */

/**
 * The plan the dispatch path actually enforces for this user, right now.
 *
 * @param {?object} user The user row (`plan`, `trial_ends_at`).
 * @param {{ now?: number }} [opts] Epoch millis; defaults to `Date.now()`.
 * @returns {'free'|'trial'|'series'} The plan dispatch enforces.
 */
export function effectivePlan(user, { now = Date.now() } = {}) {
  const plan = user?.plan;
  if (plan === 'trial' && user.trial_ends_at && Date.parse(user.trial_ends_at) <= now) {
    return 'free';
  }
  return plan === 'trial' || plan === 'series' ? plan : 'free';
}
