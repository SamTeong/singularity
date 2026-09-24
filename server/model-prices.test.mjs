import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// model-prices.mjs imports app-dir.mjs (USAGE_SKILL_STATE), which needs
// SINGULARITY_HOME set before import. USAGE_REPORT_STATE points the skill's
// pricing.json — the only store this module reads/writes — at a scratch dir
// (see model-store.test.mjs for the SINGULARITY_HOME dynamic-import pattern).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-modelprices-'));
process.env.USAGE_REPORT_STATE = mkdtempSync(join(tmpdir(), 'sing-usageskill-'));
const { getModelPrices, putModelPrices } = await import('./model-prices.mjs');

const PRICING_JSON = join(process.env.USAGE_REPORT_STATE, 'pricing.json');
const longKey = new Array(66).join('x'); // 65 chars

test('get before any pricing.json exists returns empty-defaults doc', () => {
  assert.deepEqual(getModelPrices(), { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });
});

test('valid put roundtrips and writes pricing.json', () => {
  const doc = {
    base: { opus: [15, 75, 1.5, 18.75], 'glm-5.2': [0.6, 2.2, 0.1, 0.1] },
    above_200k: { opus: [20, 100, 2, 25] },
    long_context_threshold: 100000,
    default_key: 'opus',
  };
  const r = putModelPrices(doc);
  assert.deepEqual(r, doc);
  assert.deepEqual(getModelPrices(), doc);

  const written = JSON.parse(readFileSync(PRICING_JSON, 'utf8'));
  assert.deepEqual(written, doc);
});

test('base key order is preserved (match order)', () => {
  const doc = {
    base: { sonnet: [3, 15, 0.3, 3.75], opus: [15, 75, 1.5, 18.75] },
    above_200k: {},
    long_context_threshold: 200000,
    default_key: '',
  };
  putModelPrices(doc);
  assert.deepEqual(Object.keys(getModelPrices().base), ['sonnet', 'opus']);
});

test('put rejects malformed documents without touching pricing.json', () => {
  putModelPrices({ base: { opus: [1, 1, 1, 1] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });
  const before = readFileSync(PRICING_JSON, 'utf8');
  const bad = (doc) => assert.throws(() => putModelPrices(doc));

  bad({ base: 'nope', above_200k: {}, long_context_threshold: 200000, default_key: '' });
  bad({ base: { '': [1, 2, 3, 4] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });
  bad({ base: { [longKey]: [1, 2, 3, 4] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });
  bad({ base: { opus: [1, 2, 3] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });       // wrong length
  bad({ base: { opus: [1, 2, 3, -1] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });    // negative
  bad({ base: { opus: [1, 2, 3, Infinity] }, above_200k: {}, long_context_threshold: 200000, default_key: '' }); // not finite
  bad({ base: { opus: ['1', 2, 3, 4] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });   // non-number
  bad({ base: { opus: [1, 2, 3, 4] }, above_200k: {}, long_context_threshold: 0, default_key: '' });          // bad threshold
  bad({ base: { opus: [1, 2, 3, 4] }, above_200k: {}, long_context_threshold: 200000.5, default_key: '' });   // non-integer threshold
  bad({ base: { opus: [1, 2, 3, 4] }, above_200k: {}, long_context_threshold: 200000, default_key: 'sonnet' }); // default_key not in base

  assert.equal(readFileSync(PRICING_JSON, 'utf8'), before);
});

test('bare (pre-layered) pricing.json: get reads it as base with normalized defaults', () => {
  writeFileSync(PRICING_JSON, JSON.stringify({ opus: [99, 99, 99, 99] }, null, 2));
  assert.deepEqual(getModelPrices(), { base: { opus: [99, 99, 99, 99] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });
});

test('unreadable/invalid pricing.json degrades to empty-defaults doc on get', () => {
  writeFileSync(PRICING_JSON, '{not json');
  assert.deepEqual(getModelPrices(), { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });

  const doc = { base: { sonnet: [3, 15, 0.3, 3.75] }, above_200k: {}, long_context_threshold: 200000, default_key: '' };
  const r = putModelPrices(doc);
  assert.deepEqual(r, doc);
  assert.deepEqual(JSON.parse(readFileSync(PRICING_JSON, 'utf8')), doc);
});
