import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-procs-'));
process.env.HOME = mkdtempSync(join(tmpdir(), 'sing-procs-home-'));
process.env.USERPROFILE = process.env.HOME;
const { killClaudePid, scanClaude, setProcsBackend } = await import('./procs.mjs'); // dynamic: app-dir.mjs needs the env var above
const { create, liveProcessSnapshot, remove, setPtyBackend } = await import('./agents.mjs');

const row = (pid, cmd) => ({ pid, ppid: 1, name: 'claude.exe', started: null, cmd });
const SID = 'b7025c66-c765-479d-865c-e507a677db55';
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

test('registry snapshot follows completed Rust scan and passes Node host pid', async () => {
  const events = [];
  let onExit;
  const proc = {
    pid: 30931,
    onData() {},
    activate() {},
    onExit(callback) { onExit = callback; },
    async write() {},
    async resize() {},
    async kill() { onExit?.({ exitCode: 0 }); },
  };
  setPtyBackend({ async spawn() { return proc; } });
  const backend = {
    async procsScanRaw() {
      events.push('scan-start');
      await create({ cwd: REPO_ROOT, title: 'snapshot-test', model: 'claude', sessionId: SID, modelRoute: { isClaudeModel: true } });
      events.push('scan-complete');
      return { platform: 'windows', alive: [], rows: [], rust_pid: process.pid + 1 };
    },
    async procsClassify(snapshot, pids, sessions, _root, hostPid) {
      events.push('classify');
      assert.deepEqual(pids, [proc.pid]);
      assert.deepEqual(sessions, [SID]);
      assert.equal(hostPid, process.pid);
      assert.notEqual(hostPid, snapshot.rust_pid);
      return [];
    },
    async oneShot() { return { stdout: '' }; },
    async procsKill() { return { ok: true }; },
  };
  setProcsBackend(backend);
  try {
    assert.deepEqual(await scanClaude(), []);
    assert.deepEqual(events, ['scan-start', 'scan-complete', 'classify']);
    assert.deepEqual(liveProcessSnapshot(), { pids: [proc.pid], sessions: [SID] });
  } finally {
    remove(SID);
    setProcsBackend(null);
    setPtyBackend(null);
  }
});

// --- guarded kill through the Rust backend (scan, re-query and kill recorded) ---
function mockBackend(classifications, stdouts = []) {
  const kills = [];
  const outputQueue = [...stdouts];
  const classificationQueue = [...classifications];
  return {
    kills,
    async procsScanRaw() { return { platform: 'windows', rows: [], alive: [] }; },
    async procsClassify() { return classificationQueue.shift(); },
    async oneShot() { return { stdout: outputQueue.shift() }; },
    async procsKill(pid) { kills.push(pid); return { ok: true }; },
  };
}

test('kill guard: unknown pid never reaches the backend kill', async () => {
  const backend = mockBackend([[]]);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(999), { ok: false, error: 'not a tracked process' });
    assert.equal(backend.kills.length, 0);
  } finally { setProcsBackend(null); }
});

test('kill guard: daemon-kind rows are refused', async () => {
  const daemonRow = { pid: 4322, ppid: 1, name: 'node.exe', started: null, cmd: join(REPO_ROOT, 'server'), kind: 'daemon' };
  const backend = mockBackend([[daemonRow]]);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(4322), { ok: false, error: 'daemon process — cannot stop from here' });
    assert.equal(backend.kills.length, 0);
  } finally { setProcsBackend(null); }
});

test('kill guard: win32 TOCTOU re-query gates the backend kill', { skip: process.platform === 'darwin' }, async () => {
  const target = row(4321, `claude.exe --session-id ${SID}`);
  const backend = mockBackend([[target]], ['True']);
  setProcsBackend(backend);
  try {
    assert.deepEqual(await killClaudePid(4321), { ok: true });
    assert.deepEqual(backend.kills, [4321]);
    // re-query answers False => the pid changed under us, no kill
    const changed = mockBackend([[target]], ['False']);
    setProcsBackend(changed);
    assert.deepEqual(await killClaudePid(4321), { ok: false, error: 'process changed before kill' });
    assert.equal(changed.kills.length, 0);
  } finally { setProcsBackend(null); }
});
