// SINGULARITY_SHADOW=1: read-only follower — nothing may write, spawn or rotate tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sing-shadow-'));
process.env.SINGULARITY_HOME = home;
process.env.SINGULARITY_SHADOW = '1';

const reg = await import('./agents.mjs');
const { shadowAllows } = await import('./app-dir.mjs');
const { getModels } = await import('./model-store.mjs');
const { refreshClaudeAuth } = await import('./usage.mjs');

test('shadow: import creates no dirs under SINGULARITY_HOME', () => {
  assert.deepEqual(readdirSync(home), []);
});

test('shadow: writeAtomic and persist (via beginDrain) write nothing', () => {
  const f = join(home, 'x.json');
  reg.writeAtomic(f, '{}');
  reg.beginDrain();
  assert.equal(existsSync(f), false);
  assert.deepEqual(readdirSync(home), []);
});

test('shadow: create/reattach/fork throw', () => {
  assert.throws(() => reg.create({ cwd: home }), /shadow mode: read-only/);
  assert.throws(() => reg.reattach('nope'), /shadow mode: read-only/);
  assert.throws(() => reg.fork('nope'), /shadow mode: read-only/);
});

test('shadow: getModels serves the seed without creating models.json', () => {
  assert.ok(getModels().models.length > 0);
  assert.deepEqual(readdirSync(home), []);
});

test('shadow: refreshClaudeAuth makes no network call', async () => {
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('no network'); };
  try { assert.equal(await refreshClaudeAuth(), false); } finally { globalThis.fetch = real; }
  assert.equal(called, 0);
});

test('shadow: /api guard allows reads and read-only POSTs only', () => {
  assert.equal(shadowAllows('GET', '/usage'), true);
  assert.equal(shadowAllows('POST', '/config/search'), true);
  assert.equal(shadowAllows('POST', '/transcripts/stats'), true);
  assert.equal(shadowAllows('POST', '/usage/ollama/connect'), false);
  assert.equal(shadowAllows('PUT', '/models'), false);
  assert.equal(shadowAllows('DELETE', '/tasks/1'), false);
});
