import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-procs-'));
const { classifyClaude } = await import('./procs.mjs'); // dynamic: app-dir.mjs needs the env var above

const row = (pid, cmd) => ({ pid, ppid: 1, name: 'claude.exe', started: null, cmd });
const SID = 'b7025c66-c765-479d-865c-e507a677db55';

test('claude row classification', () => {
  const wrapped = row(30932, `claude.exe --model glm-5.2:cloud --session-id ${SID} --name b7025c66`);
  // pid not in livePids (pty child is ollama.exe) but the session is a live agent
  assert.equal(classifyClaude(wrapped, new Set(), (id) => id === SID).kind, 'tracked');
  assert.equal(classifyClaude(wrapped, new Set([30932]), () => false).kind, 'tracked');
  assert.equal(classifyClaude(wrapped, new Set(), () => false).kind, 'stale');
  assert.equal(classifyClaude(row(1, 'claude.exe'), new Set(), () => false).kind, 'external');
});
