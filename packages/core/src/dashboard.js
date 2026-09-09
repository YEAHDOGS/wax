/**
 * @file Watchlist status view for the alert engine (plan §4 item 6).
 *
 * A plain-text dashboard of the watchlist state: which artists are watched,
 * which merch sites are tracked (with their probe verdicts), and the most
 * recent alerts. Pure render logic — the caller hands in a store, the demo
 * CLI hands in the seeded one. No network, no browser, ever.
 */

/**
 * Render the watchlist state as plain text.
 *
 * @param {object} store A store shaped like `createStore()`.
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.alertLimit] How many recent alerts to show.
 * @returns {Promise<string>}
 */
export async function renderDashboard(store, userId, { alertLimit = 10 } = {}) {
  const lines = [];
  lines.push('WAX — watchlist status');
  lines.push('======================');

  const watches = (await store.watches
    .filter((w) => w.user_id === userId))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  lines.push('');
  lines.push(`Artists watched (${watches.length})`);
  if (watches.length === 0) {
    lines.push('  (none — add an artist to start getting drop alerts)');
  }
  for (const w of watches) {
    const artist = await store.artists.find((a) => a.id === w.artist_id);
    const name = artist ? artist.name : w.artist_id;
    const nAlerts = (await store.alerts.filter((a) => a.user_id === userId && a.watch_id === w.id)).length;
    const channels = (w.channels ?? []).join('+') || 'email';
    lines.push(`  • ${name}  [${channels}]  ${nAlerts} alert${nAlerts === 1 ? '' : 's'}`);
  }

  const sources = (await store.sources
    .filter((s) => s.user_id === userId))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  lines.push('');
  lines.push(`Merch sites tracked (${sources.length})`);
  if (sources.length === 0) {
    lines.push('  (none — add a merch site URL to scan)');
  }
  for (const s of sources) {
    const verdict = s.scannable
      ? `scannable via ${s.scan_method}`
      : `NOT scannable (${(s.scannable_reason ?? 'unknown').split(' — ')[0]})`;
    const state = s.paused ? 'paused' : `every ${s.scan_interval_secs}s`;
    const last = s.last_scan_at ? new Date(s.last_scan_at).toISOString() : 'never scanned';
    const failures = s.consecutive_failures > 0 ? `  ${s.consecutive_failures} consecutive failures` : '';
    lines.push(`  • ${s.label ?? s.url}`);
    lines.push(`    ${s.url}`);
    lines.push(`    ${verdict} · ${state} · last scan: ${last}${failures}`);
  }

  const alerts = (await store.alerts
    .filter((a) => a.user_id === userId))
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at))
    .slice(0, alertLimit);
  lines.push('');
  lines.push(`Recent alerts (${alerts.length} shown)`);
  if (alerts.length === 0) {
    lines.push('  (none yet — alerts land here when the scan loop finds a drop)');
  }
  for (const a of alerts) {
    const release = await store.releases.find((r) => r.id === a.release_id);
    const title = release ? release.title : a.release_id;
    const artist = release ? ((await store.artists.find((ar) => ar.id === release.artist_id)) ?? {}).name ?? '' : '';
    const price = a.price_cents === null || a.price_cents === undefined
      ? '—'
      : `$${(a.price_cents / 100).toFixed(2)}`;
    const when = new Date(a.detected_at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`  [${a.state}] ${a.kind} — ${artist ? `${artist} — ` : ''}${title} (${price})  ${when}`);
  }

  return lines.join('\n');
}
