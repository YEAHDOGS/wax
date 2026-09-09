/**
 * Smoke/regression check for the `wax alert drop-pass` CLI command.
 *
 * Run: `node --test packages/core/test-alert-drop-pass-cli.mjs`
 * No dependencies beyond the Node standard library. It shells out to
 * `packages/core/bin/wax` and asserts on exit code + output shape, so it
 * guards the per-minute cron's entry point (ALERT-ENGINE-PLAN.md §3):
 * `wax alert drop-pass [--dry-run] [--live]` hangs `createDropCron`'s
 * `runDropPass` off the board path so tracked-release drops flow through
 * the same dispatch receipts as the scan path.
 *
 * Invariants pinned:
 * - dry-run (default) never sends anything: the dry-run adapter prints
 *   exactly what would be sent and records dry-run delivery-log rows.
 * - `--live` without Brando's keys is loud: every due alert is refused by
 *   the NOT-WIRED stubs, NOTHING is recorded, and the stub's error is
 *   printed per refusal — no quiet no-op, no socket opened.
 * - Delivered alerts are recorded durably (the delivery log rows the next
 *   boot replays), so a restart can never re-alert.
 * - Existing CLI paths (dashboard, alert dispatch, billing sweep) are
 *   untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wax = join(here, 'bin', 'wax');

function run(args) {
  return execFileSync(process.execPath, [wax, ...args], { encoding: 'utf8' });
}

function summary(out) {
  const m = out.match(
    /due: (\d+), suppressed: (\d+), delivered: (\d+), failed: (\d+), recorded: (\d+)/,
  );
  assert.ok(m, `drop-pass summary line missing in output:\n${out}`);
  return {
    due: Number(m[1]),
    suppressed: Number(m[2]),
    delivered: Number(m[3]),
    failed: Number(m[4]),
    recorded: Number(m[5]),
  };
}

test('wax alert drop-pass --dry-run exits 0 and prints the pass report', () => {
  const out = run(['alert', 'drop-pass', '--dry-run']);
  assert.match(
    out,
    /^\[wax\] alert drop-pass — dry-run \(nothing is sent\) — store: \w+\n/,
  );
  assert.match(out, /board: \d+ releases, \d+ rules, 0 skipped\n/);
  const s = summary(out);
  assert.equal(s.failed, 0);
  assert.equal(s.delivered, s.recorded);
});

test('wax alert drop-pass defaults to dry-run (no flag needed)', () => {
  const plain = run(['alert', 'drop-pass']);
  const explicit = run(['alert', 'drop-pass', '--dry-run']);
  assert.ok(plain.includes('dry-run (nothing is sent)'));
  // Same shape: same due / delivered / recorded counts on the seeded store.
  assert.deepEqual(summary(plain), summary(explicit));
});

test('wax alert drop-pass --live refuses loudly and records nothing without keys', () => {
  const out = run(['alert', 'drop-pass', '--live']);
  assert.match(out, /^\[wax\] alert drop-pass — LIVE \(NOT-WIRED stubs without keys\) — store: \w+\n/);
  assert.ok(
    out.includes('LIVE refused: NOT WIRED — resend sends are disabled'),
    'each refused send must print the stub\'s loud error',
  );
  const s = summary(out);
  assert.ok(s.due > 0, 'the seeded store must surface due alerts for this test to mean anything');
  assert.equal(s.failed, s.due);
  assert.equal(s.delivered, 0);
  assert.equal(s.recorded, 0);
  assert.ok(!out.includes('delivery log:'), 'a refused send must never record a delivery row');
});

test('dry-run delivery rows carry the drop kind + rule channels', () => {
  const out = run(['alert', 'drop-pass', '--dry-run']);
  const s = summary(out);
  assert.ok(s.recorded > 0, 'the seeded store must deliver at least one alert');
  assert.match(out, /\n  delivery log:\n/);
  assert.match(out, /\(drop\) via \S+/);
});

test('existing CLI paths are untouched (dashboard, alert dispatch, billing sweep)', () => {
  const dash = run(['usr_test']);
  assert.ok(dash.length > 0);
  const dispatch = run(['alert', 'dispatch', '--dry-run', '--limit=1']);
  assert.match(dispatch, /\[wax\] alert dispatch/);
  const sweep = run(['billing', 'sweep', '--json']);
  assert.deepEqual(JSON.parse(sweep), { expired: 0 });
});
