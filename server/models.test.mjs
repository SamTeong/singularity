// Unit tests for the model-routing helper: isClaudeModel() decides claude bin
// vs. ollama wrapper. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeModel, isCodexModel, claudeIdToAlias, CLAUDE_ALIASES, OLLAMA_PRESETS, CODEX_PRESETS } from './models.mjs';

test('isClaudeModel: no model / literal "claude" → true (default alias)', () => {
  assert.equal(isClaudeModel(undefined), true);
  assert.equal(isClaudeModel('claude'), true);
});

test('isClaudeModel: every known alias routes to the claude bin', () => {
  for (const alias of CLAUDE_ALIASES) assert.equal(isClaudeModel(alias), true, alias);
});

test('isClaudeModel: full claude-* id routes to the claude bin (prefix match)', () => {
  assert.equal(isClaudeModel('claude-opus-4-8'), true);
});

test('isClaudeModel: every ollama preset routes to the ollama wrapper', () => {
  for (const preset of OLLAMA_PRESETS) assert.equal(isClaudeModel(preset), false, preset);
});

test('isClaudeModel: unrecognized ollama-style ids → false', () => {
  assert.equal(isClaudeModel('glm-5.2:cloud'), false);
  assert.equal(isClaudeModel('kimi-k3:cloud'), false);
});

test('isCodexModel: every codex preset routes to the codex bin', () => {
  for (const preset of CODEX_PRESETS) assert.equal(isCodexModel(preset), true, preset);
});

test('isCodexModel: gpt-* prefix routes to the codex bin', () => {
  assert.equal(isCodexModel('gpt-5.6-luna'), true);
  assert.equal(isCodexModel('gpt-5.4'), true);
  assert.equal(isCodexModel('gpt-5.4-mini'), true);
  assert.equal(isCodexModel('gpt-5.3-codex-spark'), true); // free-text codex id
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

test('claudeIdToAlias: aliases and non-claude ids pass through unchanged', () => {
  for (const alias of CLAUDE_ALIASES) assert.equal(claudeIdToAlias(alias), alias, alias);
  assert.equal(claudeIdToAlias('glm-5.2:cloud'), 'glm-5.2:cloud');
  assert.equal(claudeIdToAlias('claude-opus-9-future'), 'opus');
});
