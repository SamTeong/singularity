// Unit tests for the session-history backend: readSession over a fixture
// .jsonl (valid lines + garbage), sessionText head+tail truncation, the
// pathFor path-containment guard (project/id from the client), and the
// FS-persisted sessions root. Fixtures follow the agents.test.mjs pattern:
// write under the real ~/.claude/projects, clean up in a finally.
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// sessions.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist above the env assignment).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.CODEX_HOME = join(tmpdir(), 'codex-nonexistent-' + Date.now());
const modelStore = await import('./model-store.mjs');
const modelBackend = (await import('./rust-backend.mjs')).createRustBackend();
await modelBackend.start();
modelStore.setModelsBackend(modelBackend);
after(async () => { await modelBackend.stop(); rmSync(process.env.SINGULARITY_HOME, { recursive: true, force: true }); });
const { readSession, sessionText, searchSessions, listSessions, subagentsFor, getSessionsRoot, setSessionsRoot, resolveRoot, setTranscriptBackend } = await import('./sessions.mjs');
setTranscriptBackend(modelBackend);

const PROJECTS = join(homedir(), '.claude', 'projects');

function writeSession(project, id, lines, root = PROJECTS) {
  const dir = join(root, project);
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

test('shared Claude parser fixtures retain legacy readSession output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-transcript-parity-'));
  const project = 'parity';
  mkdirSync(join(root, project), { recursive: true });
  const raw = await fsPromises.readFile(new URL('./fixtures/transcripts/claude.jsonl', import.meta.url), 'utf8');
  writeFileSync(join(root, project, 'fixture.jsonl'), raw.replace(/\n/g, '\r\n'));
  try {
    assert.deepEqual(await readSession(project, 'fixture', root), {
      ok: true,
      meta: { cwd: 'C:\\repo', title: 'Final title', turns: 1, firstTs: '2026-10-21T01:00:00Z', lastTs: '2026-10-21T01:00:02Z', model: 'opus' },
      messages: [
        { ts: '2026-10-21T01:00:00Z', role: 'user', kind: 'text', text: 'hello 🌍', recap: true },
        { ts: '2026-10-21T01:00:00Z', role: 'user', kind: 'toolResult', text: 'tool output' },
        { ts: '2026-10-21T01:00:01Z', role: 'assistant', kind: 'text', text: 'answer' },
        { ts: '2026-10-21T01:00:01Z', role: 'assistant', kind: 'thinking', text: 'reason' },
        { ts: '2026-10-21T01:00:01Z', role: 'assistant', kind: 'toolUse', name: 'Read', text: 'small args' },
        { ts: '2026-10-21T01:00:02Z', role: 'user', kind: 'text', text: `escaped ${String.fromCharCode(0xd83d)}` },
      ],
    });
    const tagged = await fsPromises.readFile(new URL('./fixtures/transcripts/claude-ollama.jsonl', import.meta.url), 'utf8');
    writeFileSync(join(root, project, 'ollama.jsonl'), tagged);
    assert.equal((await readSession(project, 'ollama', root)).meta.model, 'glm-5.2:cloud');
    const toolFixture = await fsPromises.readFile(new URL('./fixtures/transcripts/tool-truncation.jsonl', import.meta.url), 'utf8');
    writeFileSync(join(root, project, 'tool.jsonl'), toolFixture.replace('REPEAT301', 'x'.repeat(301)));
    assert.equal((await readSession(project, 'tool', root)).messages[0].text, `${'x'.repeat(300)}…`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy JS tool truncation exposes a lone high surrogate at the shared emoji boundary fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-transcript-boundary-'));
  const project = 'boundary';
  mkdirSync(join(root, project), { recursive: true });
  const seed = await fsPromises.readFile(new URL('./fixtures/transcripts/unicode-boundary.jsonl', import.meta.url), 'utf8');
  writeFileSync(join(root, project, 'fixture.jsonl'), seed.replace('REPEAT299', 'x'.repeat(299)));
  try {
    const parsed = await readSession(project, 'fixture', root);
    assert.equal(parsed.messages[0].text.length, 301);
    assert.equal(parsed.messages[0].text.charCodeAt(299), 0xd83d);
    assert.equal(parsed.messages[0].text.charAt(300), '…');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared Claude nested source fixture preserves escaped UTF-16 text leaves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-transcript-surrogates-'));
  const project = 'surrogates';
  mkdirSync(join(root, project), { recursive: true });
  const raw = await fsPromises.readFile(new URL('./fixtures/transcripts/claude-source-escaped.jsonl', import.meta.url), 'utf8');
  writeFileSync(join(root, project, 'fixture.jsonl'), raw);
  try {
    const parsed = await readSession(project, 'fixture', root);
    assert.deepEqual(parsed.messages.map(({ kind, text }) => [kind, text]), [
      ['text', `nested user ${String.fromCharCode(0xd83d)}`],
      ['toolResult', `tool result ${String.fromCharCode(0xde00)}`],
      ['text', `assistant text ${String.fromCharCode(0xd83d)}`],
      ['thinking', `assistant thinking ${String.fromCharCode(0xde00)}`],
      ['toolUse', JSON.stringify({ query: String.fromCharCode(0xd83d) })],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared Claude raw metadata fixture preserves cwd and ai-title UTF-16 units', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-transcript-raw-meta-'));
  const project = 'raw-meta';
  mkdirSync(join(root, project), { recursive: true });
  const raw = await fsPromises.readFile(new URL('./fixtures/transcripts/claude-metadata-escaped.jsonl', import.meta.url), 'utf8');
  writeFileSync(join(root, project, 'fixture.jsonl'), raw);
  const units = (value) => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  try {
    const parsed = await readSession(project, 'fixture', root);
    assert.deepEqual(units(parsed.meta.cwd), [...units('C:\\repo'), 0xd83d]);
    assert.deepEqual(units(parsed.meta.title), [...units('Claude title '), 0xde00]);
    assert.deepEqual(units(parsed.messages[0].text), [...units('Claude message '), 0xd83d]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared Ollama fixture leaves ambiguous tag aliases unresolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-transcript-ambiguous-'));
  const project = 'ambiguous';
  mkdirSync(join(root, project), { recursive: true });
  const original = await modelStore.getModels();
  const updated = {
    ...original,
    models: [
      ...original.models.filter((model) => !model.id.startsWith('glm-5.3:')),
      { id: 'glm-5.3:cloud', group: 'ollama', label: '', enabled: true },
      { id: 'glm-5.3:local', group: 'ollama', label: '', enabled: true },
    ],
  };
  try {
    assert.equal((await modelStore.setModels(updated)).ok, true);
    const fixture = await fsPromises.readFile(new URL('./fixtures/transcripts/claude-ollama.jsonl', import.meta.url), 'utf8');
    writeFileSync(join(root, project, 'fixture.jsonl'), fixture.replace('glm-5.2', 'glm-5.3'));
    assert.equal((await readSession(project, 'fixture', root)).meta.model, 'glm-5.3');
  } finally {
    await modelStore.setModels(original);
    rmSync(root, { recursive: true, force: true });
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

test('readSession: missing transcript maps to not found and backend read errors propagate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-missing-'));
  const codexRelative = join('sessions', 'missing-codex.jsonl');
  const originalTranscriptRead = modelBackend.transcriptRead;
  try {
    assert.deepEqual(await readSession('missing-project', 'missing-claude', root), { ok: false, error: 'not found' });
    assert.deepEqual(await readSession('', 'deleted-codex', undefined, 'codex', codexRelative), { ok: false, error: 'not found' });

    modelBackend.transcriptRead = async () => ({ error: 'read failed', code: 'EIO' });
    await assert.rejects(readSession('read-error-project', 'read-error', root), { code: 'EIO' });
  } finally {
    modelBackend.transcriptRead = originalTranscriptRead;
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessions: discovers subagent transcripts and attaches them to the parent row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-subagents-'));
  const project = 'sessions-test-subagents';
  const parentId = 'parent-1';
  const dir = writeSession(project, parentId, [
    JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-07-15T00:00:00Z' }),
  ], root);
  const subDir = join(dir, parentId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-x.jsonl'), JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n');
  writeFileSync(join(subDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'reviewer', description: 'checks stuff' }));
  try {
    const sessions = await listSessions({ root });
    const parent = sessions.find((s) => s.project === project && s.id === parentId);
    assert.ok(parent, 'parent row found');
    assert.equal(parent.subagents.length, 1);
    assert.equal(parent.subagents[0].id, `${parentId}/subagents/agent-x`);
    assert.equal(parent.subagents[0].agentId, 'agent-x');
    assert.equal(parent.subagents[0].title, 'reviewer: checks stuff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessions: subagent title cache refreshes when sidecar metadata changes', async (t) => {
  const fixture = (parentId, withMeta) => {
    const root = mkdtempSync(join(tmpdir(), 'sing-subagent-meta-'));
    const subDir = join(root, 'proj', parentId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(root, 'proj', `${parentId}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    const jsonl = join(subDir, 'agent-x.jsonl');
    writeFileSync(jsonl, [
      JSON.stringify({ type: 'ai-title', aiTitle: 'prompt title' }),
      JSON.stringify({ type: 'user', message: { content: 'sub' } }),
    ].join('\n') + '\n');
    const meta = join(subDir, 'agent-x.meta.json');
    if (withMeta) writeFileSync(meta, JSON.stringify({ agentType: 'reviewer', description: 'checks stuff' }));
    return { root, jsonl, meta, parentId };
  };
  const title = async ({ root, parentId }) => (await listSessions({ root })).find((s) => s.id === parentId).subagents[0].title;

  await t.test('late sidecar appearance refreshes the prompt title across warm listings', async () => {
    const f = fixture('parent-meta-appears', false);
    try {
      assert.equal(await title(f), 'prompt title');
      assert.equal(await title(f), 'prompt title');
      writeFileSync(f.meta, JSON.stringify({ agentType: 'reviewer', description: 'checks stuff' }));
      assert.equal(await title(f), 'reviewer: checks stuff', 'a newly appearing sidecar refreshes the title');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  await t.test('metadata-only edits refresh the title', async () => {
    const f = fixture('parent-meta-updates', true);
    try {
      assert.equal(await title(f), 'reviewer: checks stuff');
      writeFileSync(f.meta, JSON.stringify({ agentType: 'changed' }));
      utimesSync(f.meta, new Date('2026-07-17T00:00:00Z'), new Date('2026-07-17T00:00:00Z'));
      assert.equal(await title(f), 'changed');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  await t.test('sidecar removal returns to the transcript title', async () => {
    const f = fixture('parent-meta-removes', true);
    try {
      assert.equal(await title(f), 'reviewer: checks stuff');
      rmSync(f.meta);
      assert.equal(await title(f), 'prompt title');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
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
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-blurb-'));
  const project = 'sessions-test-blurb';
  const id = 'fixture-blurb';
  const longText = 'first   prompt\nwith   messy   whitespace ' + 'x'.repeat(200);
  writeSession(project, id, [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>ignore me</local-command-caveat>' } }),
    JSON.stringify({ type: 'user', message: { content: longText } }),
  ], root);
  try {
    const sessions = await listSessions({ root });
    const row = sessions.find((s) => s.project === project && s.id === id);
    assert.ok(row, 'row found');
    assert.equal(row.title, null);
    assert.equal(row.blurb.length, 140);
    assert.ok(!row.blurb.includes('\n'));
    assert.ok(row.blurb.startsWith('first prompt with messy whitespace'), row.blurb);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessions: running is the live process only; a recent mtime stays in activityRecent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-running-'));
  const project = 'sessions-test-running';
  const liveId = 'parent-live';
  const idleId = 'parent-idle';
  const dir = writeSession(project, liveId, [JSON.stringify({ type: 'user', message: { content: 'hi' } })], root);
  writeSession(project, idleId, [JSON.stringify({ type: 'user', message: { content: 'hi' } })], root);
  const old = new Date(Date.now() - 60000);
  utimesSync(join(dir, `${liveId}.jsonl`), old, old); // live but stale on disk
  const calls = [];
  try {
    const sessions = await listSessions({
      isLive: (id, context) => { calls.push([id, context]); return id === liveId; },
      root,
    });
    const live = sessions.find((s) => s.project === project && s.id === liveId);
    const idle = sessions.find((s) => s.project === project && s.id === idleId);
    // VERIFY: wave4-f3-2
    assert.equal(live.running, true); // the live process wins over a 60s-old mtime
    assert.equal(live.processLive, true);
    assert.equal(live.processState, 'live');
    assert.equal(live.activityRecent, false); // recency is reported separately
    assert.equal(idle.running, false); // a fresh mtime alone never makes a row running
    assert.equal(idle.processLive, false);
    assert.equal(idle.processState, 'unknown');
    assert.equal(idle.activityRecent, true);
    const context = calls.find(([id]) => id === liveId)[1];
    assert.equal(context.source, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessions: owned liveness and recent activity remain separate for root, Claude child, and Codex rows', async () => {
  const project = 'sessions-test-evidence';
  const ids = ['root-live-quiet', 'root-unowned-recent', 'root-unowned-old'];
  const dir = writeSession(project, ids[0], [JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  for (const id of ids.slice(1)) writeSession(project, id, [JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  const parent = ids[0];
  const childDir = join(dir, parent, 'subagents');
  mkdirSync(childDir, { recursive: true });
  const childIds = ['agent-live-quiet', 'agent-unowned-recent', 'agent-unowned-old'];
  for (const id of childIds) writeFileSync(join(childDir, `${id}.jsonl`), '{}\n');
  const old = new Date(Date.now() - 60000);
  for (const id of ['root-live-quiet', 'root-unowned-old']) utimesSync(join(dir, `${id}.jsonl`), old, old);
  for (const id of ['agent-live-quiet', 'agent-unowned-old']) utimesSync(join(childDir, `${id}.jsonl`), old, old);
  const threadId = 'dddddddd-eeee-ffff-0000-111111111111';
  const CODEX_HOME = process.env.CODEX_HOME;
  const codexDir = join(CODEX_HOME, 'sessions', '2026', '10', '27');
  mkdirSync(codexDir, { recursive: true });
  const codexFile = join(codexDir, `rollout-${threadId}.jsonl`);
  writeFileSync(codexFile, `${JSON.stringify({ type: 'session_meta', payload: { session_id: threadId, cwd: 'C:/codex/project', source: 'cli', thread_source: 'user' } })}\n`);
  const oldCodexId = 'eeeeeeee-ffff-0000-1111-222222222222';
  const oldCodexFile = join(codexDir, `rollout-${oldCodexId}.jsonl`);
  writeFileSync(oldCodexFile, `${JSON.stringify({ type: 'session_meta', payload: { session_id: oldCodexId, cwd: 'C:/codex/project', source: 'cli', thread_source: 'user' } })}\n`);
  utimesSync(oldCodexFile, old, old);
  const registryId = 'registry-agent-id-distinct-from-thread';
  const liveIds = new Set([ids[0], childIds[0], registryId]);
  const isLive = (id, context) => context?.source === 'codex'
    ? id === threadId && context.cwd === 'C:/codex/project' && liveIds.has(registryId)
    : liveIds.has(id);
  try {
    const sessions = await listSessions({ isLive });
    const root = (id) => sessions.find((s) => s.project === project && s.id === id);
    const liveRoot = root(ids[0]);
    const recentRoot = root(ids[1]);
    const oldRoot = root(ids[2]);
    assert.deepEqual([liveRoot.processLive, liveRoot.activityRecent, liveRoot.running], [true, false, true]);
    assert.deepEqual([recentRoot.processLive, recentRoot.activityRecent, recentRoot.running, recentRoot.processState], [false, true, false, 'unknown']);
    assert.deepEqual([oldRoot.processLive, oldRoot.activityRecent, oldRoot.running], [false, false, false]);
    const children = liveRoot.subagents;
    assert.deepEqual([children.find((s) => s.agentId === childIds[0]).processLive, children.find((s) => s.agentId === childIds[0]).activityRecent], [true, false]);
    assert.deepEqual([children.find((s) => s.agentId === childIds[1]).processLive, children.find((s) => s.agentId === childIds[1]).activityRecent, children.find((s) => s.agentId === childIds[1]).running], [false, true, false]);
    assert.deepEqual([children.find((s) => s.agentId === childIds[2]).processLive, children.find((s) => s.agentId === childIds[2]).activityRecent], [false, false]);
    const codex = sessions.find((s) => s.id === threadId);
    const oldCodex = sessions.find((s) => s.id === oldCodexId);
    assert.deepEqual([codex.processLive, codex.activityRecent, codex.running], [true, true, true]);
    assert.deepEqual([oldCodex.processLive, oldCodex.activityRecent, oldCodex.running], [false, false, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(CODEX_HOME, 'sessions'), { recursive: true, force: true });
  }
});

test('listSessions: a subagent runs on its own agentId with the claude-subagent liveness context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-subagent-running-'));
  const project = 'sessions-test-subagent-running';
  const parentId = 'parent-sub';
  const dir = writeSession(project, parentId, [JSON.stringify({ type: 'user', message: { content: 'hi' } })], root);
  const subDir = join(dir, parentId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const subFile = join(subDir, 'agent-live.jsonl');
  writeFileSync(subFile, JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n');
  const old = new Date(Date.now() - 60000);
  utimesSync(subFile, old, old); // live subagent, stale mtime
  const calls = [];
  try {
    // VERIFY: wave4-f3-3
    const sessions = await listSessions({
      isLive: (id, context) => { calls.push([id, context]); return id === 'agent-live'; },
      root,
    });
    const parent = sessions.find((s) => s.project === project && s.id === parentId);
    assert.equal(parent.running, false); // the parent itself has no live process
    assert.equal(parent.subagents[0].running, true);
    assert.equal(parent.subagents[0].processLive, true);
    assert.equal(parent.subagents[0].activityRecent, false);
    assert.equal(calls.find(([id]) => id === 'agent-live')[1].source, 'claude-subagent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions root persists to FS: default, roundtrip, bad input', async () => {
  assert.equal(await getSessionsRoot(), '~/.claude/projects'); // default when file absent
  const scratchRoot = mkdtempSync(join(tmpdir(), 'sing-sessions-root-'));
  assert.deepEqual(await setSessionsRoot(scratchRoot), { ok: true, root: scratchRoot });
  assert.equal(await getSessionsRoot(), scratchRoot); // read back from disk
  assert.equal((await setSessionsRoot('')).ok, false); // rejects empty
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

test('Rust transcript service preserves listing results across warm scans and refreshes changed files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-cache-'));
  const project = 'cache-corpus';
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 201; i++) {
    const id = `fixture-${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { content: `prompt ${i}` } }) + '\n');
  }

  try {
    const first = await listSessions({ root });
    assert.equal(first.length, 201);

    const second = await listSessions({ root });
    assert.deepEqual(second.map(({ id, blurb }) => [id, blurb]), first.map(({ id, blurb }) => [id, blurb]));

    writeFileSync(join(dir, 'fixture-100.jsonl'), JSON.stringify({ type: 'user', message: { content: 'updated prompt' } }) + '\n');
    const changedTime = new Date(Date.now() + 2000);
    utimesSync(join(dir, 'fixture-100.jsonl'), changedTime, changedTime);
    const third = await listSessions({ root });
    assert.equal(third.find((row) => row.id === 'fixture-100').blurb, 'updated prompt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Rust transcript bridge preserves lone UTF-16 units and applies live state after transcript scans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-sessions-utf16-'));
  const cwd = 'C:\\repo';
  const project = 'C--repo';
  const id = 'utf16-session';
  const directory = join(root, project);
  const subDir = join(directory, id, 'subagents');
  const unit = String.fromCharCode(0xd800);
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(directory, `${id}.jsonl`), [
    JSON.stringify({ type: 'ai-title', aiTitle: `title ${unit}` }),
    JSON.stringify({ type: 'user', cwd, message: { content: `query ${unit}` } }),
    JSON.stringify({ type: 'assistant', message: { model: 'gpt-6.1-sol', content: [{ type: 'text', text: `answer ${unit}` }] } }),
  ].join('\n') + '\n');
  writeFileSync(join(subDir, 'agent-child.jsonl'), JSON.stringify({ type: 'user', message: { content: 'child task' } }) + '\n');
  writeFileSync(join(subDir, 'agent-child.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'nested' }));
  try {
    const rows = await listSessions({ root, isLive: (agentId) => agentId === 'agent-child' });
    const row = rows.find((item) => item.id === id);
    assert.equal(row.title, `title ${unit}`);
    assert.equal(row.subagents[0].title, 'Explore: nested');
    assert.equal(row.subagents[0].running, true);

    const read = await readSession(project, id, root);
    assert.equal(read.messages[1].text, `answer ${unit}`);
    assert.equal((await searchSessions(unit, { root })).results[0].snippet.includes(unit), true);

    const subs = await subagentsFor(cwd, id, (agentId) => agentId === 'agent-child', Date.now(), root);
    assert.equal(subs[0].running, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
