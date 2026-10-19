// Statusline cost-history rotation: lock-guarded rotate, and the cap holds when rotation fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = join(import.meta.dirname, 'statusline.mjs');
const CAP = 2 * 1024 * 1024;
const sid = 'abcdef01-2345';

function run(state) {
  const input = JSON.stringify({ session_id: sid, cost: { total_cost_usd: Math.random() + 1 } });
  const r = spawnSync(process.execPath, [script], { input, env: { ...process.env, USAGE_REPORT_STATE: state }, encoding: 'utf8' });
  assert.equal(r.status, 0);
}
const withState = (fn) => {
  const state = mkdtempSync(join(tmpdir(), 'statusline-'));
  try { fn(state, join(state, 'cost-history.jsonl')); } finally { rmSync(state, { recursive: true, force: true }); }
};

test('over-cap history rotates to .1 and releases the lock', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(CAP + 1, 'x'));
  run(state);
  assert.equal(statSync(hist + '.1').size, CAP + 1);
  assert.ok(statSync(hist).size < 1024);
  assert.ok(!existsSync(hist + '.lock'));
}));

test('a fresh ownerless legacy lock stays protected', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(CAP + 1, 'x'));
  writeFileSync(hist + '.1', 'older');
  const lock = hist + '.lock';
  mkdirSync(lock);
  run(state);
  assert.equal(statSync(hist + '.1').size, 5);
  assert.ok(existsSync(lock));
}));

test('an old ownerless legacy lock stays protected regardless of age', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(CAP + 1, 'x'));
  writeFileSync(hist + '.1', 'older');
  const lock = hist + '.lock';
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  run(state);
  assert.equal(statSync(hist + '.1').size, 5);
  assert.ok(existsSync(lock));
}));

test('a stale lock is recovered and preserves the changed row beyond the rotation cap', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(CAP + 1, 'x'));
  mkdirSync(hist + '.lock');
  writeFileSync(join(hist + '.lock', 'owner'), '2147483647');
  run(state);
  assert.equal(statSync(hist + '.1').size, CAP + 1);
  assert.ok(statSync(hist).size > 0);
  assert.ok(!existsSync(hist + '.lock'));
}));

test('a live lock owner is never reclaimed', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(CAP + 1, 'x'));
  writeFileSync(hist + '.1', 'older');
  mkdirSync(hist + '.lock');
  writeFileSync(join(hist + '.lock', 'owner'), String(process.pid));
  run(state);
  assert.equal(statSync(hist + '.1').size, 5);
  assert.ok(existsSync(join(hist + '.lock', 'owner')));
}));

test('repeated rotation failure stops appending past 2x cap', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(2 * CAP + 1, 'x'));
  mkdirSync(hist + '.1'); // rename over a directory fails
  run(state);
  assert.equal(statSync(hist).size, 2 * CAP + 1);
}));

test('history at the 2x retention boundary does not append', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(2 * CAP, 'x'));
  mkdirSync(hist + '.1');
  run(state);
  assert.equal(statSync(hist).size, 2 * CAP);
}));

test('a near-cap history reserves room for the encoded row when rotation fails', () => withState((state, hist) => {
  writeFileSync(hist, Buffer.alloc(2 * CAP - 1, 'x'));
  mkdirSync(hist + '.1');
  run(state);
  assert.equal(statSync(hist).size, 2 * CAP - 1);
}));
