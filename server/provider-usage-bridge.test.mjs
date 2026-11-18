import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRustBackend } from './rust-backend.mjs';

test('spawned Rust provider normalizer preserves DTOs, errors, correlation, and lone UTF-16 surrogates', async () => {
  const backend = createRustBackend();
  try {
    await backend.start();
    const reset = '\ud83d';
    const claude = await backend.providerUsageNormalize('claude', {
      five_hour: { utilization: '0', resets_at: reset },
      seven_day: { utilization: true },
      seven_day_omelette: { utilization: 5 },
      extra_usage: { is_enabled: false, used_credits: 0, utilization: null },
      spend: { percent: '12' },
    }, { plan: 'max' });
    assert.equal(claude.session.resetsAt.length, 1);
    assert.equal(claude.session.resetsAt.charCodeAt(0), 0xd83d);
    assert.deepEqual(claude.weekly.models, [{ model: 'design', pctUsed: 5 }]);
    assert.deepEqual(claude.extra, { enabled: false, used: 0, monthlyLimit: null, pctUsed: 12, resetsAt: null });

    const ollama = await backend.providerUsageNormalize('ollama', { ok: 'yes', session: false, needsAuth: [] });
    assert.deepEqual(ollama, {
      ok: true, source: 'ollama', plan: null, session: false, weekly: null, extra: null,
      fetchedAt: null, stale: false, needsAuth: true, error: null,
    });
    await assert.rejects(backend.providerUsageNormalize('claude', null), /five_hour/);
    await assert.rejects(
      backend.providerUsageNormalize('claude', { five_hour: { utilization: { toString: 1 } } }),
      /Cannot convert object to primitive value/,
    );
    const ordinaryObject = await backend.providerUsageNormalize('claude', {
      five_hour: { utilization: {} },
    });
    assert.equal(ordinaryObject.session.pctUsed, null);
    assert.equal((await backend.providerUsageNormalize('codex', {})), null);
  } finally { await backend.stop(); }
});
