// Unit tests for the spawn/encoding logic: encodeCwd + buildSpawn.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encodeCwd, buildSpawn } from './agents.mjs';

test('encodeCwd replaces every non-alphanumeric (incl. dots) with "-"', () => {
  assert.equal(encodeCwd('C:\\git\\singularity'), 'C--git-singularity');
  assert.equal(encodeCwd('C:\\Users\\x\\.claude'), 'C--Users-x--claude');
  assert.equal(encodeCwd('/home/u/proj'), '-home-u-proj');
});

// A random id has no session log on disk → fresh --session-id branch.
const freshId = '00000000-1111-2222-3333-444444444444';
const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\xyz';

test('buildSpawn: fresh claude session uses --session-id, --name, no --model', () => {
  const { bin, args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: [] });
  assert.equal(typeof bin, 'string');
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], freshId);
  assert.ok(args.includes('--name'));
  assert.equal(args[args.indexOf('--name') + 1], 'demo');
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--model'));
});

test('buildSpawn: non-existent skill-scope is not added as --add-dir', () => {
  const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: ['__no_such_scope__'] });
  assert.ok(!args.includes('--add-dir'));
});

test('buildSpawn: existing session log switches to --resume', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'claude', scopes: [] });
    assert.ok(args.includes('--resume'));
    assert.ok(!args.includes('--session-id'));
  } finally {
    rmSync(log, { force: true });
  }
});

test('buildSpawn: ollama model on resume injects --model to override stripped transcript model', () => {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  const log = join(dir, `${freshId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '{}\n');
  try {
    const { args } = buildSpawn({ id: freshId, name: 'demo', cwd, model: 'glm-5.2:cloud', scopes: [] });
    // ollama-wrapped: launch claude --model <m> -- ... --resume ... --model <m>
    assert.deepEqual(args.slice(0, 4), ['launch', 'claude', '--model', 'glm-5.2:cloud']);
    assert.ok(args.includes('--resume'));
    // --model appears twice: once for the ollama wrapper, once forwarded to claude.
    assert.equal(args.filter((a) => a === '--model').length, 2);
  } catch (e) {
    // Environments without ollama on PATH throw before wrapping — logic untestable there.
    assert.match(e.message, /ollama not found/);
  } finally {
    rmSync(log, { force: true });
  }
});
