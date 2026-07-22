import { test } from 'node:test';
import assert from 'node:assert';
import { getSysStats } from './sysstats.mjs';

test('mem stats are sane', () => {
  const { mem } = getSysStats();
  assert.ok(mem.total > 0);
  assert.ok(Number.isInteger(mem.pct) && mem.pct >= 0 && mem.pct <= 100);
  assert.ok(mem.used > 0 && mem.used <= mem.total);
});

test('cpu is null or an int 0..100', () => {
  const { cpu } = getSysStats();
  assert.ok(cpu === null || (Number.isInteger(cpu) && cpu >= 0 && cpu <= 100));
});

test('cpu becomes a sampled int after a tick', async () => {
  await new Promise((r) => setTimeout(r, 2100));
  const { cpu } = getSysStats();
  assert.ok(Number.isInteger(cpu) && cpu >= 0 && cpu <= 100);
});

test('history has cpu/mem arrays with 2s step', () => {
  const { history } = getSysStats();
  assert.ok(Array.isArray(history.cpu));
  assert.ok(Array.isArray(history.mem));
  assert.strictEqual(history.stepMs, 2000);
});

test('history is populated with sane values after a tick', async () => {
  const { history } = getSysStats();
  assert.ok(history.cpu.length > 0);
  assert.ok(history.mem.length > 0);
  for (const v of history.cpu) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
  for (const v of history.mem) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
});
