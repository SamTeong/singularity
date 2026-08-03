// Unit tests for findCodexThread (codex-thread.mjs): recovers the codex
// thread uuid for a spawned agent by matching cwd + start time against
// session_meta lines in CODEX_HOME/sessions/**/rollout-*.jsonl. Fixtures
// write real rollout files into a temp dir tree, cleaned up per test.
// Run: node --test-force-exit server/codex-thread.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// codex-thread.mjs imports usage.mjs -> app-dir.mjs, which throws without
// SINGULARITY_HOME. Set it before a dynamic import (static imports hoist
// above the env assignment).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { findCodexThread, codexThreadExists } = await import('./codex-thread.mjs');

const CWD = 'C:\\git\\test-project';
const SPAWNED_AT = Date.parse('2026-08-03T14:00:00.000Z');

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'sing-codex-thread-'));
}

// Writes a rollout file whose first line is `firstLine` (raw string — either
// a JSON.stringify'd session_meta object or a deliberately malformed string).
function writeRollout(home, filename, firstLine) {
  const dir = join(home, 'sessions', '2026', '08', '03');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), firstLine + '\n');
}

function meta({ sessionId, id, cwd, threadSource, timestamp }) {
  return JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: { session_id: sessionId, id: id ?? sessionId, cwd, thread_source: threadSource, timestamp },
  });
}

test('missing sessions dir under home -> null', () => {
  const home = makeHome();
  try {
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('single matching thread_source:user rollout -> returns its session_id', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T14-00-05-uuid-user-1.jsonl', meta({
      sessionId: 'uuid-user-1', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 1000).toISOString(),
    }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), 'uuid-user-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('newer thread_source:subagent rollout in same cwd is excluded, user rollout still wins', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T14-00-05-uuid-user-1.jsonl', meta({
      sessionId: 'uuid-user-1', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 1000).toISOString(),
    }));
    // Written after -> newer mtime than the user rollout, the real-world trap.
    writeRollout(home, 'rollout-2026-08-03T14-00-10-uuid-subagent-1.jsonl', meta({
      sessionId: 'uuid-user-1', id: 'uuid-subagent-1', cwd: CWD, threadSource: 'subagent',
      timestamp: new Date(SPAWNED_AT + 2000).toISOString(),
    }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), 'uuid-user-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rollout with a different cwd -> null', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T14-00-05-uuid-other-cwd.jsonl', meta({
      sessionId: 'uuid-other-cwd', cwd: 'C:\\git\\other-project', threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 1000).toISOString(),
    }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rollout whose payload.timestamp predates spawnedAt -> null', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T13-00-00-uuid-old.jsonl', meta({
      sessionId: 'uuid-old', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT - 60000).toISOString(),
    }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('two matching user rollouts -> the later payload.timestamp wins', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T14-00-05-uuid-earlier.jsonl', meta({
      sessionId: 'uuid-earlier', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 1000).toISOString(),
    }));
    writeRollout(home, 'rollout-2026-08-03T14-00-10-uuid-later.jsonl', meta({
      sessionId: 'uuid-later', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 5000).toISOString(),
    }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), 'uuid-later');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('malformed first line is skipped without throwing, other matches still found', () => {
  const home = makeHome();
  try {
    writeRollout(home, 'rollout-2026-08-03T14-00-01-uuid-bad.jsonl', 'not valid json{{{');
    writeRollout(home, 'rollout-2026-08-03T14-00-05-uuid-good.jsonl', meta({
      sessionId: 'uuid-good', cwd: CWD, threadSource: 'user',
      timestamp: new Date(SPAWNED_AT + 1000).toISOString(),
    }));
    assert.doesNotThrow(() => findCodexThread(CWD, SPAWNED_AT, { home }));
    assert.equal(findCodexThread(CWD, SPAWNED_AT, { home }), 'uuid-good');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- codexThreadExists ----
// Confirms a caller-supplied uuid (Transcripts-resume / New-session dialog)
// is a real codex user thread for cwd, with no spawnedAt to discover it by.
const THREAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SUBAGENT_ID = 'ffffffff-1111-2222-3333-999999999999';

test('codexThreadExists: known user-thread uuid + its own cwd -> true', () => {
  const home = makeHome();
  try {
    writeRollout(home, `rollout-2026-08-03T14-00-05-${THREAD_ID}.jsonl`, meta({
      sessionId: THREAD_ID, cwd: CWD, threadSource: 'user', timestamp: new Date(SPAWNED_AT).toISOString(),
    }));
    assert.equal(codexThreadExists(THREAD_ID, CWD, { home }), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codexThreadExists: same uuid but a different cwd -> false', () => {
  const home = makeHome();
  try {
    writeRollout(home, `rollout-2026-08-03T14-00-05-${THREAD_ID}.jsonl`, meta({
      sessionId: THREAD_ID, cwd: CWD, threadSource: 'user', timestamp: new Date(SPAWNED_AT).toISOString(),
    }));
    assert.equal(codexThreadExists(THREAD_ID, 'C:\\git\\other-project', { home }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codexThreadExists: unknown uuid -> false', () => {
  const home = makeHome();
  try {
    writeRollout(home, `rollout-2026-08-03T14-00-05-${THREAD_ID}.jsonl`, meta({
      sessionId: THREAD_ID, cwd: CWD, threadSource: 'user', timestamp: new Date(SPAWNED_AT).toISOString(),
    }));
    assert.equal(codexThreadExists('00000000-0000-0000-0000-000000000000', CWD, { home }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codexThreadExists: thread_source:"subagent" rollout\'s uuid -> false', () => {
  const home = makeHome();
  try {
    writeRollout(home, `rollout-2026-08-03T14-00-10-${SUBAGENT_ID}.jsonl`, meta({
      sessionId: THREAD_ID, id: SUBAGENT_ID, cwd: CWD, threadSource: 'subagent', timestamp: new Date(SPAWNED_AT).toISOString(),
    }));
    assert.equal(codexThreadExists(SUBAGENT_ID, CWD, { home }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codexThreadExists: missing home -> false, no throw', () => {
  const home = makeHome();
  try {
    const missing = join(home, 'does-not-exist');
    assert.doesNotThrow(() => codexThreadExists(THREAD_ID, CWD, { home: missing }));
    assert.equal(codexThreadExists(THREAD_ID, CWD, { home: missing }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
