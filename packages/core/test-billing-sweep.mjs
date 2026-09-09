/**
 * Smoke/regression check for the `wax billing sweep` CLI command.
 *
 * Run: `node --test packages/core/test-billing-sweep.mjs`
 * No dependencies beyond the Node standard library. It shells out to
 * `packages/core/bin/wax` and asserts on exit code + output shape, so it
 * guards the cron's entry point (the plan asks for hourly trial sweeps):
 * text mode prints the human summary, `--json` prints `{"expired": N}`,
 * and both stay idempotent against the seeded demo store (no trials, so 0).
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

test('wax billing sweep prints the human summary and exits 0', () => {
  const out = run(['billing', 'sweep']);
  assert.match(out, /^\[wax\] billing sweep — \d+ trials? expired back to free\n$/);
});

test('wax billing sweep --json prints a machine-readable count', () => {
  const out = run(['billing', 'sweep', '--json']);
  assert.deepEqual(JSON.parse(out), { expired: 0 });
});

test('wax billing sweep is idempotent on the seeded store', () => {
  assert.deepEqual(JSON.parse(run(['billing', 'sweep', '--json'])), { expired: 0 });
});

test('existing CLI paths are untouched (dashboard + alert dispatch)', () => {
  // Default dashboard branch still renders for a user id.
  const dash = run(['usr_test']);
  assert.ok(dash.length > 0);
  // The alert-dispatch dry-run path still works.
  const dispatch = run(['alert', 'dispatch', '--dry-run', '--limit=1']);
  assert.match(dispatch, /\[wax\] alert dispatch/);
});
