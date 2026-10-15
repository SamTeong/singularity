// Unit tests for the session-history backend: readSession over a fixture
// .jsonl (valid lines + garbage), sessionText head+tail truncation, the
// pathFor path-containment guard (project/id from the client), and the
// FS-persisted sessions root. Fixtures follow the agents.test.mjs pattern:
// write under the real ~/.claude/projects, clean up in a finally.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// sessions.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist above the env assignment).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.CODEX_HOME = join(tmpdir(), 'codex-nonexistent-' + Date.now());
const { readSession, sessionText, searchSessions, listSessions, getSessionsRoot, setSessionsRoot, resolveRoot } = await import('./sessions.mjs');

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

test('readSession: meta.model is the last assistant message.model (a /model switch shows the latest)', async () => {
  const project = 'sessions-test-model';
  const id = 'fixture-model';
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }], model: 'sonnet' }, timestamp: '2026-07-15T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }], model: 'opus' }, timestamp: '2026-07-15T00:00:01Z' }),
  ]);
  try {
    const s = await readSession(project, id);
    assert.equal(s.ok, true);
    assert.equal(s.meta.model, 'opus');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession: ollama model logged with :tag stripped is restored to the full preset', async () => {
  const project = 'sessions-test-ollama-tag';
  const id = 'fixture-ollama-tag';
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], model: 'glm-5.3' }, timestamp: '2026-07-15T00:00:00Z' }),
  ]);
  try {
    const s = await readSession(project, id);
    assert.equal(s.ok, true);
    assert.equal(s.meta.model, 'glm-5.3:cloud');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession: resolved claude-* id (from opus[1m]) maps back to the opus alias', async () => {
  const project = 'sessions-test-claude-alias';
  const id = 'fixture-claude-alias';
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], model: 'claude-opus-5' }, timestamp: '2026-07-15T00:00:00Z' }),
  ]);
  try {
    const s = await readSession(project, id);
    assert.equal(s.ok, true);
    assert.equal(s.meta.model, 'opus');
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

test('listSessions: subagent meta.json title is cached with the jsonl (mtime,size) and re-read only when the jsonl changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-subagent-meta-'));
  const parentId = 'parent-meta-cache';
  const subDir = join(root, 'proj', parentId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(root, 'proj', `${parentId}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  const jsonl = join(subDir, 'agent-x.jsonl');
  writeFileSync(jsonl, JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n');
  writeFileSync(join(subDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'reviewer', description: 'checks stuff' }));
  const subTitle = async () => (await listSessions({ root })).find((s) => s.id === parentId).subagents[0].title;
  try {
    assert.equal(await subTitle(), 'reviewer: checks stuff');
    writeFileSync(join(subDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'changed' }));
    assert.equal(await subTitle(), 'reviewer: checks stuff', 'unchanged jsonl serves the cached meta.json title');
    utimesSync(jsonl, new Date('2026-07-16T00:00:00Z'), new Date('2026-07-16T00:00:00Z'));
    assert.equal(await subTitle(), 'changed', 'a touched jsonl re-reads meta.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('listSessions: no ai-title falls back to a blurb built from the first real user message, whitespace-collapsed and capped at 140 chars', async () => {
  const project = 'sessions-test-blurb';
  const id = 'fixture-blurb';
  const longText = 'first   prompt\nwith   messy   whitespace ' + 'x'.repeat(200);
  const dir = writeSession(project, id, [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>ignore me</local-command-caveat>' } }),
    JSON.stringify({ type: 'user', message: { content: longText } }),
  ]);
  try {
    const sessions = await listSessions();
    const row = sessions.find((s) => s.project === project && s.id === id);
    assert.ok(row, 'row found');
    assert.equal(row.title, null);
    assert.equal(row.blurb.length, 140);
    assert.ok(!row.blurb.includes('\n'));
    assert.ok(row.blurb.startsWith('first prompt with messy whitespace'), row.blurb);
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

test('sessions root persists to FS: default, roundtrip, bad input', () => {
  assert.equal(getSessionsRoot(), '~/.claude/projects'); // default when file absent
  const scratchRoot = mkdtempSync(join(tmpdir(), 'sing-sessions-root-'));
  assert.deepEqual(setSessionsRoot(scratchRoot), { ok: true, root: scratchRoot });
  assert.equal(getSessionsRoot(), scratchRoot); // read back from disk
  assert.equal(setSessionsRoot('').ok, false); // rejects empty
  assert.equal(resolveRoot(scratchRoot), scratchRoot);
});

test('listSessions/readSession/searchSessions scope to an explicit root, ignoring the persisted default', async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'sing-sessions-scoped-'));
  const project = 'scoped-proj';
  const id = 'scoped-1';
  mkdirSync(join(scratchRoot, project), { recursive: true });
  writeFileSync(join(scratchRoot, project, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'FINDME_SCOPED' } }) + '\n');
  try {
    const sessions = await listSessions({ root: scratchRoot });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, id);

    const read = await readSession(project, id, scratchRoot);
    assert.equal(read.ok, true);
    assert.equal(read.messages[0].text, 'FINDME_SCOPED');

    const { results } = await searchSessions('FINDME_SCOPED', { root: scratchRoot });
    assert.equal(results.length, 1);
    assert.equal(results[0].project, project);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('listSessions: unchanged corpus stays cached beyond 200 entries and only changed files are reread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-cache-'));
  const project = 'cache-corpus';
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 201; i++) {
    const id = `fixture-${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { content: `prompt ${i}` } }) + '\n');
  }

  const probe = await open(join(dir, 'fixture-000.jsonl'), 'r');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = handlePrototype.read;
  let contentReads = 0;
  handlePrototype.read = function (...args) {
    contentReads++;
    return originalRead.apply(this, args);
  };
  try {
    const first = await listSessions({ root });
    assert.equal(first.length, 201);
    assert.equal(contentReads, 201);

    contentReads = 0;
    const second = await listSessions({ root });
    assert.deepEqual(second.map(({ id, blurb }) => [id, blurb]), first.map(({ id, blurb }) => [id, blurb]));
    assert.equal(contentReads, 0, 'unchanged files should be served from metadata cache');

    writeFileSync(join(dir, 'fixture-100.jsonl'), JSON.stringify({ type: 'user', message: { content: 'updated prompt' } }) + '\n');
    const changedTime = new Date(Date.now() + 2000);
    utimesSync(join(dir, 'fixture-100.jsonl'), changedTime, changedTime);
    contentReads = 0;
    const third = await listSessions({ root });
    assert.equal(third.find((row) => row.id === 'fixture-100').blurb, 'updated prompt');
    assert.equal(contentReads, 1, 'only the changed file should be reread');
  } finally {
    handlePrototype.read = originalRead;
    rmSync(root, { recursive: true, force: true });
  }
});
