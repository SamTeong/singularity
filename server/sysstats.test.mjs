import { test } from 'node:test';
import assert from 'node:assert';
import { createRustBackend } from './rust-backend.mjs';

test('Rust sysstats starts empty, samples every two seconds, and stops cleanly', async () => {
  const backend = createRustBackend({ binaryPath: process.env.SINGULARITY_SYSSTATS_TEST_BINARY });
  await backend.start();
  try {
    const initial = await backend.sysStats();
    assert.strictEqual(initial.cpu, null);
    assert.ok(initial.mem.total > 0);
    assert.ok(initial.mem.used >= 0 && initial.mem.used <= initial.mem.total);
    assert.ok(Number.isInteger(initial.mem.pct) && initial.mem.pct >= 0 && initial.mem.pct <= 100);
    assert.deepStrictEqual(initial.history, { cpu: [], mem: [], stepMs: 2000 });

    await new Promise((resolve) => setTimeout(resolve, 2150));
    const sampled = await backend.sysStats();
    assert.ok(Number.isInteger(sampled.cpu) && sampled.cpu >= 0 && sampled.cpu <= 100);
    assert.strictEqual(sampled.history.cpu.length, 1);
    assert.strictEqual(sampled.history.cpu.length, sampled.history.mem.length);
    for (const value of sampled.history.mem) assert.ok(Number.isInteger(value) && value >= 0 && value <= 100);
  } finally {
    await backend.stop();
  }
});
