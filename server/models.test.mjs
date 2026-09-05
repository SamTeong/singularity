// Unit tests for the model-routing helpers: isClaudeModel() decides claude bin
// vs. ollama wrapper, isCodexModel() the codex bin. The suggestion lists are
// runtime state now, so these read the store instead of module constants.
//
// models.mjs imports model-store.mjs -> app-dir.mjs (STATE_DIR), which throws
// without SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic
// import (static imports hoist above the env assignment).
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sing-models-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
after(() => rmSync(scratch, { recursive: true, force: true }));

const { isClaudeModel, isCodexModel, claudeIdToAlias, validateToolModel } = await import('./models.mjs');
const { getModels, setModels } = await import('./model-store.mjs');

const idsIn = (group) => getModels().models.filter((m) => m.group === group).map((m) => m.id);

test('isClaudeModel: no model / literal "claude" → true (default alias)', () => {
  assert.equal(isClaudeModel(undefined), true);
  assert.equal(isClaudeModel('claude'), true);
});

test('isClaudeModel: every stored claude entry routes to the claude bin', () => {
  for (const alias of idsIn('claude')) assert.equal(isClaudeModel(alias), true, alias);
});

test('isClaudeModel: full claude-* id routes to the claude bin (prefix match)', () => {
  assert.equal(isClaudeModel('claude-opus-4-8'), true);
});

test('isClaudeModel: every stored ollama entry routes to the ollama wrapper', () => {
  for (const preset of idsIn('ollama')) assert.equal(isClaudeModel(preset), false, preset);
});

test('isClaudeModel: unrecognized ollama-style ids → false', () => {
  assert.equal(isClaudeModel('glm-5.2:cloud'), false);
  assert.equal(isClaudeModel('deepseek-v4-flash:cloud'), false);
  assert.equal(isClaudeModel('kimi-k2.7-code:cloud'), false);
});

test('isCodexModel: every stored codex entry routes to the codex bin', () => {
  for (const preset of idsIn('codex')) assert.equal(isCodexModel(preset), true, preset);
});

test('isCodexModel: gpt-* prefix routes to the codex bin', () => {
  assert.equal(isCodexModel('gpt-5.6-luna'), true);
  assert.equal(isCodexModel('gpt-5.4'), true);
  assert.equal(isCodexModel('gpt-5.4-mini'), true);
  assert.equal(isCodexModel('gpt-5.3-codex-spark'), true); // free-text codex id
});

test('codex-group invariant: every stored codex entry is a gpt-* id (web/src/lib/models.js mirrors isCodexModel with a bare prefix check and relies on this)', () => {
  for (const preset of idsIn('codex')) assert.ok(preset.startsWith('gpt-'), preset);
});

test('isCodexModel: empty / claude / ollama ids → false', () => {
  assert.equal(isCodexModel(undefined), false);
  assert.equal(isCodexModel(''), false);
  assert.equal(isCodexModel('claude'), false);
  assert.equal(isCodexModel('opus'), false);
  assert.equal(isCodexModel('claude-opus-4-8'), false);
  assert.equal(isCodexModel('glm-5.2:cloud'), false);
});

test('claudeIdToAlias: resolved claude-* ids map back to the family alias', () => {
  assert.equal(claudeIdToAlias('claude-opus-5'), 'opus');
  assert.equal(claudeIdToAlias('claude-opus-4-8'), 'opus');
  assert.equal(claudeIdToAlias('claude-sonnet-5'), 'sonnet');
  assert.equal(claudeIdToAlias('claude-haiku-4-5'), 'haiku');
  // [1m] context flag preserved when the id carries it
  assert.equal(claudeIdToAlias('claude-opus-4-8[1m]'), 'opus[1m]');
  assert.equal(claudeIdToAlias('claude-sonnet-5[1m]'), 'sonnet[1m]');
});

test('claudeIdToAlias: stored claude entries and non-claude ids pass through unchanged', () => {
  for (const alias of idsIn('claude')) assert.equal(claudeIdToAlias(alias), alias, alias);
  assert.equal(claudeIdToAlias('glm-5.2:cloud'), 'glm-5.2:cloud');
  assert.equal(claudeIdToAlias('claude-opus-9-future'), 'opus');
});

// The whole point of Phase 2: routing is store-driven, so an edit takes effect
// without a daemon restart (no import-time ALIAS_SET snapshot).
test('routing follows a store edit with no restart, and free-text still falls back to the heuristics', () => {
  const before = getModels();
  const w = setModels({
    ...before,
    models: [
      ...before.models.filter((m) => m.id !== 'gpt-5.6-luna'),
      { id: 'zephyr-9', group: 'claude', label: 'Zephyr', enabled: true },
    ],
  });
  assert.equal(w.ok, true, w.error);

  // Added claude entry now routes to the claude bin despite no claude- prefix.
  assert.equal(isClaudeModel('zephyr-9'), true);
  assert.equal(isCodexModel('zephyr-9'), false);
  validateToolModel('claude', 'zephyr-9'); // must not throw
  assert.throws(() => validateToolModel('codex', 'zephyr-9'));

  // Deleted codex preset typed free-text still routes to the codex bin.
  assert.equal(isCodexModel('gpt-5.6-luna'), true);
  assert.equal(isClaudeModel('gpt-5.6-luna'), false);

  assert.equal(setModels(before).ok, true);
  assert.equal(isClaudeModel('zephyr-9'), false, 'reverting the store reverts routing');
});

// The floor set: deleting a shipped claude alias in Settings must not reroute
// it to the ollama wrapper — tasks.mjs hardcodes 'sonnet'/'opus' as the
// subagent-split defaults.
test('deleted shipped claude aliases keep routing to the claude bin', () => {
  const before = getModels();
  const w = setModels({ ...before, models: before.models.filter((m) => m.id !== 'sonnet' && m.id !== 'opus') });
  assert.equal(w.ok, true, w.error);
  assert.equal(isClaudeModel('sonnet'), true);
  assert.equal(isClaudeModel('opus'), true);
  assert.equal(isCodexModel('sonnet'), false);
  assert.equal(setModels(before).ok, true);
});
