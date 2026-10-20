import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-procs-'));
const { classifyClaude, killClaudePid, setProcsBackend } = await import('./procs.mjs'); // dynamic: app-dir.mjs needs the env var above

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

// --- guarded kill through the Rust backend (scan, re-query and kill recorded) ---
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const scanRows = (rows) => JSON.stringify({ rows, alive: [1] });

function mockBackend(stdouts) {
  const kills = [];
  const queue = [...stdouts];
  return {
    kills,
    async oneShot() { return { stdout: queue.shift() }; },
    async procsKill(pid) { kills.push(pid); return { ok: true }; },
  };
}

test('kill guard: unknown pid never reaches the backend kill', async () => {
  const backend = mockBackend([scanRows([])]);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(999), { ok: false, error: 'not a tracked process' });
    assert.equal(backend.kills.length, 0);
  } finally { setProcsBackend(null); }
});

test('kill guard: daemon-kind rows are refused', async () => {
  const daemonRow = { pid: 4322, ppid: 1, name: 'node.exe', started: null, cmd: join(REPO_ROOT, 'server') };
  const backend = mockBackend([scanRows([daemonRow])]);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(4322), { ok: false, error: 'daemon process — cannot stop from here' });
    assert.equal(backend.kills.length, 0);
  } finally { setProcsBackend(null); }
});

test('kill guard: win32 TOCTOU re-query gates the backend kill', { skip: process.platform === 'darwin' }, async () => {
  const target = row(4321, `claude.exe --session-id ${SID}`);
  const backend = mockBackend([scanRows([target]), 'True']);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(4321), { ok: true });
    assert.deepEqual(backend.kills, [4321]);
    // re-query answers False => the pid changed under us, no kill
    const changed = mockBackend([scanRows([target]), 'False']);
    setProcsBackend(changed);
    assert.deepEqual(await killClaudePid(4321), { ok: false, error: 'process changed before kill' });
    assert.equal(changed.kills.length, 0);
  } finally { setProcsBackend(null); }
});