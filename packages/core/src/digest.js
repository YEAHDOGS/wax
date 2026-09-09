/**
 * @file Digest queue — the "held for digest" half of alert delivery
 * (alert engine plan §3, the rest of `notify.js`'s rate-limit contract).
 *
 * The scan worker promises that a held-back alert is never silently
 * dropped: `shouldDispatch` folds the excess into "the next digest
 * instead". This module is that next digest. Two worker steps:
 *
 * - `queueHeldAlerts({ store, alerts })` — after `dispatchScanAlerts`,
 *   sweep the persisted alert rows for deliveries the verdict held back
 *   (rate caps, free-tier SMS denial, unverified phone) and queue one
 *   digest row per held alert. Idempotent: re-running never double-queues.
 * - `flushDigestQueue({ store, channels })` — once per pass (or on its own
 *   schedule), group queued items by user and send one digest email each:
 *   held during quiet hours (rules.js `shouldFlushDigest` — the first place
 *   quiet hours actually gate something in the production pipeline),
 *   at most one digest per user per hour, verified email only, stale
 *   items expire after a week instead of accumulating forever.
 *
 * Zero network I/O here: the email channel is injected, exactly like the
 * dispatch layer. A missing or throwing channel is a held digest, never a
 * lost one — the queue survives and the next pass retries.
 */

/* eslint-disable no-await-in-loop */

import { newId } from './store.js';
import { shouldFlushDigest, buildDigestBatch } from './rules.js';
import { recordScanLog } from './poller.js';

/** At most one digest email per user per interval, so the digest itself can't flood. */
export const DIGEST_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Held alerts expire after a week — the queue is a buffer, not an archive. */
export const DIGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound the digest email size; overflow stays queued for the next flush. */
export const DIGEST_MAX_ITEMS = 25;

/**
 * The dedupe key for a queued item: one digest row per (user, alert).
 * @param {object} item
 */
const queueKey = (item) => `${item?.user_id ?? ''}\u001f${item?.alert_id ?? ''}`;

/**
 * Queue every held-back delivery from a dispatch pass.
 *
 * Reads the receipts `dispatchScanAlerts` persisted on each alert row:
 * a receipt with `skipped: true` means the verdict held that delivery
 * back and it now belongs in the user's digest. Alerts with no held
 * deliveries are untouched. Safe to call twice for the same pass — the
 * (user_id, alert_id) unique key makes re-queueing a no-op.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {Array<object>} [input.alerts] Persisted alert rows from `dispatchScanAlerts`.
 * @param {number} [input.nowMs]
 * @returns {{ queued: number, skipped: number }}
 */
export function queueHeldAlerts({ store, alerts = [], nowMs = Date.now() }) {
  let queued = 0;
  let skipped = 0;
  const isoNow = new Date(nowMs).toISOString();

  for (const alert of alerts) {
    const held = (alert?.dispatches ?? []).filter((r) => r?.skipped === true);
    if (!held.length) {
      skipped += 1;
      continue;
    }
    if (store.digestQueue.find((q) => queueKey(q) === queueKey({ user_id: alert?.user_id, alert_id: alert?.id }))) {
      skipped += 1;
      continue;
    }
    const reasons = [...new Set(held.map((r) => String(r.reason ?? 'held for digest')))].slice(0, 3);
    store.digestQueue.insert({
      id: newId('dgq'),
      user_id: alert.user_id,
      alert_id: alert.id,
      kind: alert.kind ?? 'drop',
      artist_name: alert.artist_name ?? 'Unknown artist',
      title: alert.title ?? 'Untitled',
      price_cents: alert.price_cents ?? null,
      listing_url: alert.listing_url ?? null,
      source_label: alert.source_label ?? null,
      reason: reasons.join(' | '),
      queued_at: isoNow,
    });
    queued += 1;
  }

  return { queued, skipped };
}

/**
 * When this user's last digest left, read from the scan log's 'digest'
 * rows — the same transparency pattern as scan attempts and dispatch
 * receipts.
 * @param {object} store
 * @param {string} userId
 */
function lastDigestAt(store, userId) {
  let latest = 0;
  for (const row of store.scanLogs.filter((l) => l?.outcome === 'digest' && l?.user_id === userId)) {
    const t = Date.parse(row.scanned_at ?? '');
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

/**
 * Send every due digest email.
 *
 * Per user with queued items:
 *
 * 1. Gone user → queue rows dropped (Postgres would cascade them).
 * 2. Quiet hours → held. This is quiet-hours enforcement for the whole
 *    deferred-alert path: nothing leaves while the user sleeps, the digest
 *    lands after the window ends.
 * 3. Digest sent within `DIGEST_MIN_INTERVAL_MS` → held, to avoid the
 *    digest itself becoming the flood the rate caps exist to prevent.
 * 4. Unverified email → held. A digest to an unverified address is a
 *    spam complaint waiting to happen; the row expires after a week.
 * 5. Otherwise → oldest `DIGEST_MAX_ITEMS` rows folded into one email
 *    via `buildDigestBatch`, sent through `channels.email`, queue cleared
 *    on success, one scan-log row with outcome 'digest'.
 *
 * A throwing channel is a failed flush, not a lost digest: the rows stay
 * queued and the next pass retries.
 *
 * @param {object} input
 * @param {object} input.store A `@wax/core` store.
 * @param {Record<string, object>} [input.channels] Channel map (`'email'` is used).
 * @param {number} [input.nowMs]
 * @returns {Promise<{ expired: number, users: Array<{ user_id: string, sent: boolean, items: number, reason: string }> }>}
 */
export async function flushDigestQueue({ store, channels = {}, nowMs = Date.now() }) {
  const expired = store.digestQueue.remove((q) => Date.parse(q?.queued_at ?? '') <= nowMs - DIGEST_MAX_AGE_MS);

  const byUser = new Map();
  for (const q of store.digestQueue.all()) {
    if (!byUser.has(q.user_id)) byUser.set(q.user_id, []);
    byUser.get(q.user_id).push(q);
  }

  const users = [];
  for (const [userId, rows] of byUser) {
    const user = store.users.find((u) => u.id === userId);
    if (!user) {
      store.digestQueue.remove((q) => q.user_id === userId);
      users.push({ user_id: userId, sent: false, items: rows.length, reason: 'user gone — queue dropped' });
      continue;
    }

    const ordered = rows.slice().sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
    const emailChannel = channels.email ?? null;
    const to = user.email_verified === true ? user.email : null;

    let held = null;
    if (!shouldFlushDigest({ user, nowMs })) {
      held = `quiet hours (${user.quiet_hours_start}–${user.quiet_hours_end} UTC) — digest held until the window ends`;
    } else if (lastDigestAt(store, userId) > nowMs - DIGEST_MIN_INTERVAL_MS) {
      held = 'digest already sent within the last hour — held for the next window';
    } else if (!emailChannel) {
      held = "no email channel configured — held, nothing lost";
    } else if (!to) {
      held = 'email not verified — digest held; verify to receive it';
    }

    if (held) {
      users.push({ user_id: userId, sent: false, items: ordered.length, reason: held });
      continue;
    }

    const batch = ordered.slice(0, DIGEST_MAX_ITEMS);
    const oldest = batch[0]?.queued_at ?? new Date(nowMs).toISOString();
    const { subject, text, count } = buildDigestBatch({
      items: batch.map((q) => ({
        item: {
          kind: q.kind,
          artist_name: q.artist_name,
          title: q.title,
          price_cents: q.price_cents,
          listing_url: q.listing_url,
          source_label: q.source_label,
        },
      })),
      windowLabel: `since ${oldest.slice(0, 10)}`,
    });

    let receipt;
    try {
      receipt = await emailChannel.send({
        alert: null,
        channel: 'email',
        to,
        message: { subject, text },
        nowMs,
      });
    } catch (err) {
      receipt = { ok: false, channel: 'email', error: `digest channel threw: ${err?.message ?? String(err)}` };
    }

    if (receipt?.ok) {
      const sentIds = new Set(batch.map((q) => q.id));
      store.digestQueue.remove((q) => sentIds.has(q.id));
      recordScanLog(store, {
        source_id: `digest:${userId}`,
        user_id: userId,
        scanned_at: new Date(nowMs).toISOString(),
        outcome: 'digest',
        delivered: count,
        attempted: 1,
        failures: 0,
        skipped: 0,
        receipts: [{ ...receipt, via: emailChannel.name, channel: 'email', digest_items: count }],
      });
      users.push({ user_id: userId, sent: true, items: count, reason: `digest sent to ${to} (${count} items)` });
    } else {
      recordScanLog(store, {
        source_id: `digest:${userId}`,
        user_id: userId,
        scanned_at: new Date(nowMs).toISOString(),
        outcome: 'digest',
        delivered: 0,
        attempted: 1,
        failures: 1,
        skipped: 0,
        error: String(receipt?.error ?? 'email channel failed'),
      });
      users.push({ user_id: userId, sent: false, items: ordered.length, reason: `email channel failed — held: ${receipt?.error ?? 'unknown'}` });
    }
  }

  return { expired, users };
}
