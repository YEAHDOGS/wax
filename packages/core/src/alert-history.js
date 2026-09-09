/**
 * @file Alert history view (plan §4 item 6 — "alert history UI").
 *
 * A standalone, static HTML page rendering one user's full alert history:
 * every alert joined to its release and artist, a filter row with per-state
 * counts, and an unread marker. Pure render logic like `dashboard.js` — the
 * caller hands in a store, the demo CLI hands in the seeded one. No network,
 * no client-side JS, no CSS framework, ever. The page is filterable through
 * plain `?state=` links, which is the entire "app" the static page needs.
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

/** @type {import('./types.js').AlertState[]} */
const STATES = ['live', 'caught', 'sold_out', 'watching', 'missed'];

/** Human labels for why an alert fired (AlertKind in types.js). */
const KIND_LABELS = { drop: 'new drop', price: 'price hit', restock: 'restock', merch: 'merch' };

/**
 * Only http(s) listing URLs become links. Anything else (javascript:, data:,
 * a relative string, garbage) renders as inert escaped text — an alert is
 * the wrong place to learn what an href can do.
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
 * @param {string} iso
 * @returns {string}
 */
const when = (iso) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Render the full alert history as a standalone HTML page.
 *
 * @param {object} store A store shaped like `createStore()`.
 * @param {string} userId
 * @param {object} [opts]
 * @param {import('./types.js').AlertState|'all'} [opts.state] Filter, default all.
 * @returns {string} A complete HTML document.
 */
export function renderAlertHistory(store, userId, { state = 'all' } = {}) {
  const active = STATES.includes(state) ? state : 'all';

  const rows = store.alerts
    .filter((a) => a.user_id === userId && (active === 'all' || a.state === active))
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at));

  const of = (s) => store.alerts.filter((a) => a.user_id === userId && a.state === s).length;
  const all = store.alerts.filter((a) => a.user_id === userId).length;
  const unread = store.alerts.filter((a) => a.user_id === userId && a.read_at === null).length;

  const filters = ['all', ...STATES]
    .map((s) => {
      const count = s === 'all' ? all : of(s);
      const label = s === 'all' ? 'all' : s;
      const current = s === active ? ' current" aria-current="page' : '';
      return `<a class="filter${current}" href="?state=${esc(s)}">${esc(label)} (${count})</a>`;
    })
    .join('\n      ');

  const items = rows
    .map((a) => {
      const release = store.releases.find((r) => r.id === a.release_id);
      const artist = release
        ? (store.artists.find((ar) => ar.id === release.artist_id) ?? {}).name ?? ''
        : '';
      const title = release ? release.title : a.release_id;
      const kind = KIND_LABELS[a.kind] ?? a.kind;
      const channels = (a.channels ?? []).join(' + ') || 'email';
      const link = a.listing_url
        ? isSafeUrl(a.listing_url)
          ? `<a href="${esc(a.listing_url)}">open listing</a>`
          : `<span class="url">${esc(a.listing_url)}</span>`
        : '';
      return `      <li data-id="${esc(a.id)}">
        <span class="state">[${esc(a.state)}]</span>
        ${a.read_at === null ? '<span class="unread">unread</span>' : ''}
        <strong><a href="?id=${esc(a.id)}">${artist ? `${esc(artist)} — ` : ''}${esc(title)}</a></strong>
        <span class="kind">${esc(kind)}</span>
        <span class="price">${esc(money(a.price_cents))}</span>
        <span class="when">${esc(when(a.detected_at))}</span>
        <span class="channels">${esc(channels)}</span>
        ${link}
      </li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wax — alert history</title>
<style>
  body { font-family: ui-monospace, monospace; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  .filter { margin-right: 1rem; }
  .filter.current { font-weight: bold; color: inherit; text-decoration: none; }
  .unread-marker { margin-left: 1rem; color: #555; }
  ul { list-style: none; padding: 0; }
  li { border-bottom: 1px solid #ddd; padding: 0.5rem 0; }
  .state { color: #555; }
  .unread { color: #b00; font-weight: bold; }
  .kind, .channels, .when { color: #555; font-size: 0.85em; }
  .url { color: #555; }
</style>
</head>
<body>
  <h1>Wax — alert history</h1>
  <nav class="filters">
      ${filters}
  </nav>
  <p class="unread-marker">${unread} unread</p>
  ${rows.length === 0
    ? '<p>nothing here yet — alerts land here when the scan loop finds a drop for you.</p>'
    : `<ul>\n${items}\n  </ul>`}
</body>
</html>`;
}
