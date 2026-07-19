// Unit tests for the session-history backend: readSession over a fixture
// .jsonl (valid lines + garbage), sessionText head+tail truncation, and the
// pathFor path-containment guard (project/id from the client). Fixtures
// follow the agents.test.mjs pattern: write under the real
// ~/.claude/projects, clean up in a finally.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSession, sessionText, searchSessions, listSessions } from './sessions.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');

function writeSession(project, id, lines) {
  const dir = join(PROJECTS, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  return dir;
}

test('readSession: valid lines parse, a garbage/truncated line is skipped, no throw', async () => {
  const project = 'sessions-test-parse';
  const id = 'fixture-1';
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2026-07-15T00:00:00Z' }),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"trunc', // garbage/truncated
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] }, timestamp: '2026-07-15T00:00:01Z' }),
  ]);
  try {
    const s = await readSession(project, id);
    assert.equal(s.ok, true);
    assert.equal(s.meta.turns, 1);
    assert.deepEqual(s.messages, [
      { ts: '2026-07-15T00:00:00Z', role: 'user', kind: 'text', text: 'hello' },
      { ts: '2026-07-15T00:00:01Z', role: 'assistant', kind: 'text', text: 'hi there' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionText: head+tail truncation keeps the opening and latest text plus the marker', async () => {
  const project = 'sessions-test-trunc';
  const id = 'fixture-2';
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'user', message: { content: 'HEAD_MARKER this is the opening problem statement with plenty of detail to pad out length nicely' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'middle turn one output filler filler filler filler filler filler' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'middle turn two filler filler filler filler filler filler filler' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TAIL_MARKER' }] } }),
  ]);
  try {
    const text = await sessionText(project, id, 50); // small custom cap forces truncation
    assert.ok(text.includes('HEAD_MARKER'), text);
    assert.ok(text.includes('TAIL_MARKER'), text);
    assert.ok(text.includes('[…truncated…]'), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchSessions: a target that stats fine but fails to read (e.g. a directory in its place) is skipped, no throw', async () => {
  const project = 'sessions-test-vanish';
  const id = 'ghost';
  const dir = join(PROJECTS, project);
  // A directory named like the session file: stat() succeeds (matching the
  // real deleted-between-stat-and-read race), but readFile() throws (EISDIR).
  mkdirSync(join(dir, `${id}.jsonl`), { recursive: true });
  try {
    const result = await searchSessions('anything', { project, id });
    assert.deepEqual(result, { results: [], capped: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession: pathFor rejects project/id containing ".." or separators', async () => {
  assert.deepEqual(await readSession('..', 'foo'), { ok: false, error: 'not found' });
  assert.deepEqual(await readSession('proj/evil', 'foo'), { ok: false, error: 'not found' });
  assert.deepEqual(await readSession('proj', '../escape'), { ok: false, error: 'not found' });
  assert.deepEqual(await readSession('proj', 'a\\b'), { ok: false, error: 'not found' });
  assert.deepEqual(await readSession('', 'foo'), { ok: false, error: 'not found' });
});

test('listSessions: discovers subagent transcripts and attaches them to the parent row', async () => {
  const project = 'sessions-test-subagents';
  const parentId = 'parent-1';
  const dir = writeSession(project, parentId, [
    JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-07-15T00:00:00Z' }),
  ]);
  const subDir = join(dir, parentId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-x.jsonl'), JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n');
  writeFileSync(join(subDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'reviewer', description: 'checks stuff' }));
  try {
    const sessions = await listSessions();
    const parent = sessions.find((s) => s.project === project && s.id === parentId);
    assert.ok(parent, 'parent row found');
    assert.equal(parent.subagents.length, 1);
    assert.equal(parent.subagents[0].id, `${parentId}/subagents/agent-x`);
    assert.equal(parent.subagents[0].agentId, 'agent-x');
    assert.equal(parent.subagents[0].title, 'reviewer: checks stuff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession: nested subagent id opens via the pathFor relaxation; escapes and plain slashes stay rejected', async () => {
  const project = 'sessions-test-nested-path';
  const parentId = 'parent-2';
  const dir = writeSession(project, parentId, [
    JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-07-15T00:00:00Z' }),
  ]);
  const subDir = join(dir, parentId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-x.jsonl'), JSON.stringify({ type: 'user', message: { content: 'sub reply' }, timestamp: '2026-07-15T00:00:01Z' }) + '\n');
  try {
    const nested = await readSession(project, `${parentId}/subagents/agent-x`);
    assert.equal(nested.ok, true);
    assert.equal(nested.messages[0].text, 'sub reply');

    assert.deepEqual(await readSession(project, '../evil/subagents/agent-x'), { ok: false, error: 'not found' });
    assert.deepEqual(await readSession(project, 'a/b'), { ok: false, error: 'not found' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessions: running merges isLive with the mtime recency heuristic', async () => {
  const project = 'sessions-test-running';
  const liveId = 'parent-live';
  const staleId = 'parent-stale';
  const dir = writeSession(project, liveId, [JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  writeSession(project, staleId, [JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  const old = new Date(Date.now() - 60000);
  utimesSync(join(dir, `${staleId}.jsonl`), old, old);
  try {
    const sessions = await listSessions({ isLive: (id) => id === liveId });
    const live = sessions.find((s) => s.project === project && s.id === liveId);
    const stale = sessions.find((s) => s.project === project && s.id === staleId);
    assert.equal(live.running, true);
    assert.equal(stale.running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
