/**
 * @file Discogs collection → alert-engine batch adapter.
 *
 * The alert engine (`alert-engine.js`) speaks Discogs-shaped releases —
 * the same fields `collectionToBatch` produces here from a Discogs
 * collection-folder payload (`/users/{username}/collection/folders/0/releases`).
 * This is the fixture side of the "new-release detection for a watched
 * artist" ingestion path: in dev/tests the scheduler's `getReleases()`
 * is `() => collectionToBatch(load('dcruzship-collection.json')).releases`;
 * in production it becomes the collection probe's live response — the
 * scheduler never touches the network, and this module never fetches.
 *
 * A collection entry is NOT a live market listing, so two fields that
 * Discogs never returns on collection rows are supported as Wax-only
 * annotations (top-level `price_cents`, `in_stock` on an entry):
 *
 * - `price_cents` — an observed market price for that pressing, so the
 *   engine's `price_drop` / `max_price_cents` semantics stay exercisable
 *   against collection-shaped rows (Crate Digger's verdict data feeds it).
 * - `in_stock` — a restock/availability flag for entries mirrored from
 *   sale listings; left null when nothing is known.
 *
 * When absent, both stay null — the engine treats unknown price as
 * "not a deal" and unknown stock as no restock event. An entry's
 * Discogs release id is the engine's identity key; `instance_id` /
 * `folder_id` / `rating` ride along under `collection` for traceability.
 *
 * Validation is loud: malformed entries are skipped with a `{ index,
 * reason }` report — never silently dropped, never fed to the engine.
 * A fixture with no `releases` array throws; the scheduler's `onTick`
 * report is the place that refusal surfaces.
 */

export const COLLECTION_SKIP_REASONS = Object.freeze([
  'missing_basic_information',
  'missing_id',
  'missing_title',
]);

/**
 * Map one collection entry to an engine release, or `null` with a reason.
 * @param {object} entry
 * @returns {{ release: ?object, skip: ?{ reason: string } }}
 */
export function mapCollectionEntry(entry) {
  const info = entry?.basic_information;
  if (info == null || typeof info !== 'object') {
    return { release: null, skip: { reason: 'missing_basic_information' } };
  }
  if (info.id == null || info.id === '') {
    return { release: null, skip: { reason: 'missing_id' } };
  }
  const title = info.title;
  if (typeof title !== 'string' || title.trim() === '') {
    return { release: null, skip: { reason: 'missing_title' } };
  }
  const artists = Array.isArray(info.artists)
    ? info.artists
        .filter((a) => a != null && typeof a.name === 'string' && a.name.trim() !== '')
        .map((a) => ({
          name: a.name,
          anv: typeof a.anv === 'string' ? a.anv : '',
          join: typeof a.join === 'string' ? a.join : '',
        }))
    : [];
  const labels = Array.isArray(info.labels)
    ? info.labels
        .filter((l) => l != null && typeof l.name === 'string' && l.name.trim() !== '')
        .map((l) => ({
          name: l.name,
          catno: typeof l.catno === 'string' ? l.catno : '',
        }))
    : [];
  const formats = Array.isArray(info.formats)
    ? info.formats.map((f) => ({
        name: typeof f?.name === 'string' ? f.name : '',
        qty: f?.qty != null ? String(f.qty) : '',
        descriptions: Array.isArray(f?.descriptions)
          ? f.descriptions.filter((d) => typeof d === 'string')
          : [],
      }))
    : [];
  const price = entry?.price_cents;
  const stock = entry?.in_stock;
  const id = info.id;
  const release = {
    id,
    title,
    artists,
    labels,
    formats,
    year: typeof info.year === 'number' ? info.year : null,
    uri: `https://www.discogs.com/release/${id}`,
    thumb: typeof info.thumb === 'string' ? info.thumb : '',
    price_cents: typeof price === 'number' && Number.isFinite(price) ? price : null,
    in_stock: stock === true ? true : stock === false ? false : null,
    collection: {
      instance_id: entry?.instance_id ?? null,
      folder_id: entry?.folder_id ?? null,
      rating: typeof entry?.rating === 'number' ? entry.rating : null,
    },
  };
  return { release, skip: null };
}

/**
 * Convert a Discogs collection-folder payload into engine releases.
 * @param {object} fixture Collection-folder payload with `releases`.
 * @returns {{ releases: Array<object>, skipped: Array<{ index: number, reason: string }> }}
 */
export function collectionToBatch(fixture) {
  if (fixture == null || typeof fixture !== 'object' || !Array.isArray(fixture.releases)) {
    throw new TypeError(
      'collectionToBatch expects a Discogs collection-folder payload with a `releases` array',
    );
  }
  const releases = [];
  const skipped = [];
  fixture.releases.forEach((entry, index) => {
    const { release, skip } = mapCollectionEntry(entry);
    if (release) {
      releases.push(release);
    } else {
      skipped.push({ index, reason: skip.reason });
    }
  });
  return { releases, skipped };
}

/**
 * Wrap a fixture into a scheduler-ready `getReleases` provider.
 * Usage: `createAlertScheduler({ getReleases: createCollectionProvider(fixture), ... })`.
 * Skipped entries are reported through `onSkipped` (and ignored by default)
 * — the batch the engine sees contains only valid releases.
 * @param {object} fixture
 * @param {{ onSkipped?: (skipped: Array<{ index: number, reason: string }>) => void }} [opts]
 * @returns {() => Array<object>}
 */
export function createCollectionProvider(fixture, { onSkipped } = {}) {
  return () => {
    const { releases, skipped } = collectionToBatch(fixture);
    if (skipped.length > 0 && typeof onSkipped === 'function') {
      onSkipped(skipped);
    }
    return releases;
  };
}
