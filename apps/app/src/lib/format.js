/**
 * @file Formatting helpers.
 *
 * Every one of these produces a string destined for Courier Prime — money,
 * durations, timestamps, quantities. That is not a coincidence: **The Measured
 * Mono Rule** says mono type appears only where the content is a measurement,
 * an identifier, or a date, which is exactly the set of things worth having a
 * formatter for.
 *
 * Money arrives as integer cents everywhere in this codebase and is formatted
 * at the last possible moment — here, in the view layer, and nowhere earlier.
 */

/**
 * Cents to a dollar string.
 *
 * Whole dollars drop the decimals, because `$84` reads faster than `$84.00`
 * and a listing price is scanned, not audited.
 *
 * @param {?number} cents
 * @param {string} [fallback] What to print when there is no figure at all.
 * @returns {string}
 * @example money(8400) // '$84'
 * @example money(4250) // '$42.50'
 */
export function money(cents, fallback = '—') {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return fallback;
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

/**
 * Seconds to `m:ss`, or `h:mm:ss` past an hour.
 *
 * Always zero-padded past the first unit, so a column of durations lines up in
 * a monospaced face — which is the entire reason the player sets them in one.
 *
 * @param {?number} seconds
 * @returns {string}
 * @example clock(214) // '3:34'
 */
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A timestamp as elapsed time, at the coarsest unit that is still honest.
 *
 * Seconds matter here in a way they do not in most products: the gap between
 * detection and dispatch is the number Wax is judged on, so anything under a
 * minute prints in seconds rather than rounding up to "just now".
 *
 * @param {?string} iso
 * @param {number} [now] Milliseconds, for a stable render in tests.
 * @returns {string}
 * @example since(iso38SecondsAgo) // '38s ago'
 */
export function since(iso, now = Date.now()) {
  if (!iso) return '—';
  const elapsed = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (elapsed < 60) return `${Math.floor(elapsed)}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  if (elapsed < 86400 * 30) return `${Math.floor(elapsed / 86400)}d ago`;
  const months = Math.floor(elapsed / (86400 * 30));
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/**
 * The interval between two instants, in seconds, as `38s`.
 *
 * Used for exactly one figure: detection to dispatch. Sub-second gaps print as
 * `<1s` rather than `0s`, because zero would read as "not measured".
 *
 * @param {?string} fromIso
 * @param {?string} toIso
 * @returns {string}
 */
export function gap(fromIso, toIso) {
  if (!fromIso || !toIso) return '—';
  const seconds = Math.abs(Date.parse(toIso) - Date.parse(fromIso)) / 1000;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * A short absolute date, e.g. `28 JUL 2026`. Uppercase, because it sits in
 * Label or Data type wherever it appears.
 *
 * @param {?string} iso
 * @returns {string}
 */
export function stamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${String(d.getDate()).padStart(2, '0')} ${month} ${d.getFullYear()}`;
}

/**
 * A count with its noun, pluralised.
 *
 * @param {number} n
 * @param {string} singular
 * @param {string} [plural] Defaults to `singular + 's'`.
 * @returns {string}
 * @example plural(1, 'pressing') // '1 pressing'
 */
export function plural(n, singular, plural_ = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

/**
 * A 0–1 share as a whole percentage.
 * @param {number} ratio
 * @returns {string}
 */
export const percent = (ratio) => `${Math.round((ratio ?? 0) * 100)}%`;

/**
 * Initials for an avatar with no image. Square, per The Square Corner Rule —
 * the shape is decided by the component, this only supplies the letters.
 *
 * @param {string} name
 * @returns {string}
 */
export const initials = (name) =>
  String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
