import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalog, reconcilePricing, syncModelPrices } from './sync-model-prices.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'singularity-pricing-'));
after(() => rm(scratch, { recursive: true, force: true }));
process.env.SINGULARITY_HOME = scratch;
process.env.USAGE_REPORT_STATE = scratch;
const old = {
  base: { 'gpt-6': [10, 50, 1, 12.5], opus: [5, 25, 0.5, 6.25], sonnet: [3, 15, 0.3, 3.75], haiku: [1, 5, 0.1, 1.25], fable: [10, 50, 1, 12.5], custom: [9, 8, 7, 6] },
  above_200k: { custom: [10, 9, 8, 7] },
  long_context_threshold: 200000,
  default_key: 'opus',
};

test('reconciliation fixes version shadowing while preserving custom rates, fallbacks and order', () => {
  const updated = reconcilePricing(old);
  for (const [key, rate] of Object.entries(catalog.pricing.base)) {
    const model = /^(gpt-|claude-)/.test(key) ? key : `claude-${key}`;
    const matched = Object.keys(updated.base).find((candidate) => model.includes(candidate));
    assert.equal(matched, key, model);
    assert.deepEqual(updated.base[matched], rate);
  }
  assert.deepEqual(updated.base.custom, old.base.custom);
  assert.deepEqual(updated.above_200k.custom, old.above_200k.custom);
  assert.equal(updated.default_key, 'opus');
  assert.equal(updated.long_context_threshold, 272000);
  assert.equal(JSON.stringify(reconcilePricing(updated)), JSON.stringify(updated));
  assert.deepEqual(reconcilePricing(old.base).base, updated.base);
  assert.equal(reconcilePricing({}).default_key, '');
});

test('sync defaults to dry run, backs up original bytes, skips unchanged files and preserves invalid input', async () => {
  const target = join(scratch, 'sync.json');
  const original = JSON.stringify(old);
  await writeFile(target, original);
  assert.equal((await syncModelPrices(target)).written, false);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await syncModelPrices(target, true)).written, true);
  assert.equal(await readFile(`${target}.bak`, 'utf8'), original);
  const before = await stat(target);
  assert.equal((await syncModelPrices(target, true)).changed, false);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  await writeFile(target, 'broken');
  await assert.rejects(syncModelPrices(target, true), SyntaxError);
  assert.equal(await readFile(target, 'utf8'), 'broken');
  assert.throws(() => reconcilePricing({ base: { bad: [-1, 0, 0, 0] } }), /nonnegative/);
});

test('shared report resolves every catalog version and uses request thresholds including cached input', async () => {
  await writeFile(join(scratch, 'pricing.json'), JSON.stringify(reconcilePricing(old)));
  const report = await import('../.claude/skills/harness-usage-report/scripts/stats.mjs');
  for (const [key, rate] of Object.entries(catalog.pricing.base)) {
    const model = /^(gpt-|claude-)/.test(key) ? key : `claude-${key}-20261119`;
    assert.equal(report._price_key(model), key);
    assert.equal(report._msg_cost_tiered(model, 1000, 200, 300, 400),
      (1000 * rate[0] + 200 * rate[1] + 300 * rate[2] + 400 * rate[3]) / 1e6, model);
  }
  for (const [key, long] of Object.entries(catalog.pricing.above_200k)) {
    const threshold = key === 'haiku-5-5' ? 100000 : 272000;
    const base = catalog.pricing.base[key];
    assert.equal(report._msg_cost_tiered(key, threshold - 1000, 100, 1000, 0),
      ((threshold - 1000) * base[0] + 100 * base[1] + 1000 * base[2]) / 1e6, key);
    assert.equal(report._msg_cost_tiered(key, threshold - 1000, 100, 1001, 0),
      ((threshold - 1000) * long[0] + 100 * long[1] + 1001 * long[2]) / 1e6, key);
  }
});

test('embedded session estimator agrees with current and historical Claude rate cards and TTLs', async () => {
  const { parseByPath } = await import('../server/stats.mjs');
  const cases = [
    ['claude-fable-5-2', 8, 40, 0.2], ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-fable-5-20260609', 10, 50, 1],
    ['claude-sonnet-5-5', 2, 10, 0.1], ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-opus-4', 15, 75, 1.5], ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-haiku-3-5', 0.8, 4, 0.08], ['claude-3-5-haiku', 0.8, 4, 0.08],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ];
  for (const [model, input, output, cached] of cases) {
    const target = join(scratch, `${model}.jsonl`);
    await writeFile(target, JSON.stringify({ type: 'assistant', message: { model, usage: {
      input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
    } } }));
    const expected = (1000 * input + 200 * output + 300 * cached + 100 * input * 1.25 + 300 * input * 2) / 1e6;
    assert.ok(Math.abs((await parseByPath(target)).estCostUsd - expected) < 1e-12, model);
  }
  for (const [cached, inputRate, outputRate] of [[1000, 0.1, 0.5], [1001, 0.5, 2.5]]) {
    const target = join(scratch, `haiku-boundary-${cached}.jsonl`);
    await writeFile(target, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: {
      input_tokens: 99000, cache_read_input_tokens: cached, output_tokens: 100,
    } } }));
    const expected = (99000 * inputRate + cached * inputRate * 0.1 + 100 * outputRate) / 1e6;
    assert.ok(Math.abs((await parseByPath(target)).estCostUsd - expected) < 1e-12);
  }
});
