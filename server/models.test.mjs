// Unit tests for the model-routing helpers: isClaudeModel() decides claude bin
// vs. ollama wrapper, isCodexModel() the codex bin. The suggestion lists are
// runtime state now, so these read the store instead of module constants.
//
// models.mjs imports model-store.mjs -> app-dir.mjs (STATE_DIR), which throws
// without SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic
// import (static imports hoist above the env assignment).
// Run: npm test  (node --test server/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sing-models-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
const { createRustBackend } = await import('./rust-backend.mjs');
const backend = createRustBackend();
const store = await import('./model-store.mjs');
before(async () => { await backend.start(); store.setModelsBackend(backend); });
after(async () => { await backend.stop(); rmSync(scratch, { recursive: true, force: true }); });

const { isClaudeModel, isCodexModel, claudeIdToAlias, validateToolModel } = await import('./models.mjs');
const { getModels, setModels } = store;

const idsIn = async (group) => (await getModels()).models.filter((m) => m.group === group).map((m) => m.id);

test('isClaudeModel: no model / literal "claude" → true (default alias)', async () => {
  assert.equal(await isClaudeModel(undefined), true);
  assert.equal(await isClaudeModel('claude'), true);
});

test('isClaudeModel: every stored claude entry routes to the claude bin', async () => {
  for (const alias of await idsIn('claude')) assert.equal(await isClaudeModel(alias), true, alias);
});

test('isClaudeModel: full claude-* id routes to the claude bin (prefix match)', async () => {
  assert.equal(await isClaudeModel('claude-opus-4-8'), true);
});

test('isClaudeModel: every stored ollama entry routes to the ollama wrapper', async () => {
  for (const preset of await idsIn('ollama')) assert.equal(await isClaudeModel(preset), false, preset);
});

test('isClaudeModel: unrecognized ollama-style ids → false', async () => {
  assert.equal(await isClaudeModel('glm-5.2:cloud'), false);
  assert.equal(await isClaudeModel('deepseek-v4-flash:cloud'), false);
  assert.equal(await isClaudeModel('kimi-k2.7-code:cloud'), false);
});

test('isCodexModel: every stored codex entry routes to the codex bin', async () => {
  for (const preset of await idsIn('codex')) assert.equal(await isCodexModel(preset), true, preset);
});

test('isCodexModel: gpt-* prefix routes to the codex bin', async () => {
  assert.equal(await isCodexModel('gpt-6-luna'), true);
  assert.equal(await isCodexModel('gpt-5.4'), true);
  assert.equal(await isCodexModel('gpt-5.4-mini'), true);
  assert.equal(await isCodexModel('gpt-5.3-codex-spark'), true); // free-text codex id
});

test('codex-group invariant: every stored codex entry is a gpt-* id (web/src/lib/models.js mirrors isCodexModel with a bare prefix check and relies on this)', async () => {
  for (const preset of await idsIn('codex')) assert.ok(preset.startsWith('gpt-'), preset);
});

test('isCodexModel: empty / claude / ollama ids → false', async () => {
  assert.equal(await isCodexModel(undefined), false);
  assert.equal(await isCodexModel(''), false);
  assert.equal(await isCodexModel('claude'), false);
  assert.equal(await isCodexModel('opus'), false);
  assert.equal(await isCodexModel('claude-opus-4-8'), false);
  assert.equal(await isCodexModel('glm-5.2:cloud'), false);
});

test('claudeIdToAlias: resolved claude-* ids map back to the family alias', async () => {
  assert.equal(await claudeIdToAlias('claude-opus-5'), 'opus');
  assert.equal(await claudeIdToAlias('claude-opus-4-8'), 'opus');
  assert.equal(await claudeIdToAlias('claude-sonnet-5'), 'sonnet');
  assert.equal(await claudeIdToAlias('claude-haiku-4-5'), 'haiku');
  // [1m] context flag preserved when the id carries it
  assert.equal(await claudeIdToAlias('claude-opus-4-8[1m]'), 'opus[1m]');
  assert.equal(await claudeIdToAlias('claude-sonnet-5[1m]'), 'sonnet[1m]');
});

test('claudeIdToAlias: stored claude entries and non-claude ids pass through unchanged', async () => {
  for (const alias of await idsIn('claude')) assert.equal(await claudeIdToAlias(alias), alias, alias);
  assert.equal(await claudeIdToAlias('glm-5.2:cloud'), 'glm-5.2:cloud');
  assert.equal(await claudeIdToAlias('claude-opus-9-future'), 'opus');
});

// The whole point of Phase 2: routing is store-driven, so an edit takes effect
// without a daemon restart (no import-time ALIAS_SET snapshot).
test('routing follows a store edit with no restart, and free-text still falls back to the heuristics', async () => {
  const before = await getModels();
  const w = await setModels({
    ...before,
    models: [
      ...before.models.filter((m) => m.id !== 'gpt-6-luna'),
      { id: 'zephyr-9', group: 'claude', label: 'Zephyr', enabled: true },
    ],
  });
  assert.equal(w.ok, true, w.error);

  // Added claude entry now routes to the claude bin despite no claude- prefix.
  assert.equal(await isClaudeModel('zephyr-9'), true);
  assert.equal(await isCodexModel('zephyr-9'), false);
  await validateToolModel('claude', 'zephyr-9'); // must not throw
  await assert.rejects(validateToolModel('codex', 'zephyr-9'));

  // Deleted codex preset typed free-text still routes to the codex bin.
  assert.equal(await isCodexModel('gpt-6-luna'), true);
  assert.equal(await isClaudeModel('gpt-6-luna'), false);

  assert.equal((await setModels(before)).ok, true);
  assert.equal(await isClaudeModel('zephyr-9'), false, 'reverting the store reverts routing');
});

// The floor set: deleting a shipped claude alias in Settings must not reroute
// it to the ollama wrapper — tasks.mjs hardcodes 'sonnet'/'opus' as the
// subagent-split defaults.
test('deleted shipped claude aliases keep routing to the claude bin', async () => {
  const before = await getModels();
  const w = await setModels({ ...before, models: before.models.filter((m) => m.id !== 'sonnet' && m.id !== 'opus') });
  assert.equal(w.ok, true, w.error);
  assert.equal(await isClaudeModel('sonnet'), true);
  assert.equal(await isClaudeModel('opus'), true);
  assert.equal(await isCodexModel('sonnet'), false);
  assert.equal((await setModels(before)).ok, true);
});
