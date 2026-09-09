/**
 * @file Alert detail view — the page one history row links to.
 *
 * Same contract as `alert-history.js`: a standalone, static HTML page, pure
 * render logic, zero JS, zero CSS framework, every user string escaped, only
 * http(s) URLs become links. The caller (a handler) has already scoped the
 * alert to the session user, so this never sees another user's rows.
 */

/**
 * Escape a value for safe inclusion in HTML text or an attribute.
 *
 * @param {*} value
 * @returns {string}
 */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Human labels for why an alert fired (AlertKind in types.js). */
const KIND_LABELS = { drop: 'new drop', price: 'price hit', restock: 'restock', merch: 'merch' };

/**
 * Only http(s) listing URLs become links. Same rule as the history page:
 * an alert is the wrong place to learn what an href can do.
 *
 * @param {?string} url
 * @returns {boolean}
 */
const isSafeUrl = (url) => /^https?:\/\//i.test(String(url ?? '').trim());

/**
 * @param {number|null|undefined} cents
 * @returns {string}
 */
const money = (cents) =>
  cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`;

/**
 * @param {?string} iso
 * @returns {string}
 */
const when = (iso) =>
  iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—';

/**
 * Render one alert as a standalone HTML page.
 *
 * @param {object} store A store shaped like `createStore()`.
 * @param {object} alert The alert row — already scoped to the requesting user.
 * @returns {Promise<string>} A complete HTML document.
 */
export async function renderAlertDetail(store, alert) {
  const release = await store.releases.find((r) => r.id === alert.release_id);
  const artist = release
    ? ((await store.artists.find((ar) => ar.id === release.artist_id)) ?? {}).name ?? ''
    : '';
  const title = release ? release.title : alert.release_id;
  const kind = KIND_LABELS[alert.kind] ?? alert.kind;
  const channels = (alert.channels ?? []).join(' + ') || 'email';
  const link = alert.listing_url
    ? isSafeUrl(alert.listing_url)
      ? `<a href="${esc(alert.listing_url)}">open listing</a>`
      : `<span class="url">${esc(alert.listing_url)}</span>`
    : '';

  const releaseLine = release
    ? [release.label, release.year, release.format, release.cat]
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map(esc)
        .join(' · ')
    : 'release removed from the catalog — showing the stored id';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wax — ${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  .state { color: #555; }
  .unread { color: #b00; font-weight: bold; }
  .meta, .when { color: #555; font-size: 0.9em; }
  dl { display: grid; grid-template-columns: 8rem 1fr; gap: 0.25rem 1rem; }
  dt { color: #555; }
  .back { display: inline-block; margin-bottom: 1rem; }
</style>
</head>
<body>
  <a class="back" href="/api/alerts/history">← alert history</a>
  <h1>${artist ? `${esc(artist)} — ` : ''}${esc(title)}</h1>
  <p>
    <span class="state">[${esc(alert.state)}]</span>
    ${alert.read_at === null ? '<span class="unread">unread</span>' : ''}
    <span class="meta">${esc(kind)} · ${esc(channels)}</span>
  </p>
  <p class="meta">${esc(releaseLine)} ${link}</p>
  <dl>
    <dt>price</dt><dd>${esc(money(alert.price_cents))}</dd>
    <dt>detected</dt><dd class="when">${esc(when(alert.detected_at))}</dd>
    <dt>dispatched</dt><dd class="when">${esc(alert.dispatched_at ? when(alert.dispatched_at) : 'not yet dispatched')}</dd>
    <dt>read</dt><dd class="when">${esc(alert.read_at ? when(alert.read_at) : 'unread')}</dd>
  </dl>
</body>
</html>`;
}
