import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.CODEX_HOME = join(tmpdir(), 'configured-codex-home');
const { findCodexThread, codexThreadExists, setCodexIdentityBackend, normPath } = await import('./codex-thread.mjs');

test('identity adapter passes explicit CODEX_HOME and preserves results', async () => {
  const calls = [];
  setCodexIdentityBackend({
    codexThreadFind: async (...args) => { calls.push(['find', ...args]); return 'thread-1'; },
    codexThreadExists: async (...args) => { calls.push(['exists', ...args]); return true; },
  });
  assert.equal(await findCodexThread('/repo', 1234), 'thread-1');
  assert.equal(await codexThreadExists('thread-1', '/repo'), true);
  assert.deepEqual(calls, [
    ['find', process.env.CODEX_HOME, '/repo', 1234],
    ['exists', process.env.CODEX_HOME, '/repo', 'thread-1'],
  ]);
});

test('identity adapter maps bridge failures and malformed responses to old null/false outcomes', async () => {
  setCodexIdentityBackend({
    codexThreadFind: async () => { throw new Error('bridge unavailable'); },
    codexThreadExists: async () => { throw new Error('bridge unavailable'); },
  });
  assert.equal(await findCodexThread('/repo', 1234), null);
  assert.equal(await codexThreadExists('thread-1', '/repo'), false);
  setCodexIdentityBackend({ codexThreadFind: async () => 42, codexThreadExists: async () => 1 });
  assert.equal(await findCodexThread('/repo', 1234), null);
  assert.equal(await codexThreadExists('thread-1', '/repo'), false);
});

test('registry path normalization retains Windows separator and case behavior', () => {
  if (process.platform === 'win32') {
    assert.equal(normPath('C:\\Repo\\src\\..\\project'), 'c:/repo/project');
  } else {
    assert.equal(normPath('/repo/src/../project'), '/repo/project');
  }
});

test('identity adapter test home is isolated', () => {
  rmSync(process.env.SINGULARITY_HOME, { recursive: true, force: true });
});
