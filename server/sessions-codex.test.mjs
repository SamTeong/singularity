// Unit tests for Codex CLI transcript support in sessions.mjs: listSessions
// discovers rollout-*.jsonl under CODEX_HOME, readSession with source:'codex'
// parses events into messages, searchSessions includes codex transcripts.
// Fixtures write to a temp CODEX_HOME, clean up in a finally.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// sessions.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point both SINGULARITY_HOME and CODEX_HOME at scratch
// temp dirs before a dynamic import (static imports hoist above the env
// assignment).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const CODEX_HOME = mkdtempSync(join(tmpdir(), 'sing-codex-'));
process.env.CODEX_HOME = CODEX_HOME;
const { listSessions, readSession, searchSessions } = await import('./sessions.mjs');

const THREAD_ID = '019f9718-405c-7fd3-9b8a-f3af71880fe2';
const SESSION_ID = '019f9718-405c-7fd3-9b8a-f3af71880fe2';
const ROLLOUT = `rollout-2026-07-25T10-26-16-${THREAD_ID}.jsonl`;
const ROLLOUT_DIR = join(CODEX_HOME, 'sessions', '2026', '07', '25');

function writeRollout(lines) {
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  writeFileSync(join(ROLLOUT_DIR, ROLLOUT), lines.join('\n') + '\n');
}

const EVENTS = [
  JSON.stringify({ timestamp: '2026-07-25T02:26:22.245Z', type: 'session_meta', payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: 'C:\\git\\test' } }),
  JSON.stringify({ timestamp: '2026-07-25T02:26:22.289Z', type: 'event_msg', payload: { type: 'user_message', message: 'how to start codex in sandbox?' } }),
  JSON.stringify({ timestamp: '2026-07-25T02:26:23.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
  JSON.stringify({ timestamp: '2026-07-25T02:26:24.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'You can start codex with --sandbox flag.' }] } }),
  JSON.stringify({ timestamp: '2026-07-25T02:26:25.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"codex --help"}' } }),
  JSON.stringify({ timestamp: '2026-07-25T02:26:26.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } } } }),
];

test('listSessions: codex rollout appears with source, cwd, sessionId', async () => {
  writeRollout(EVENTS);
  try {
    // claude root nonexistent → only codex rows returned
    const sessions = await listSessions({ root: join(CODEX_HOME, 'nonexistent') });
    const codex = sessions.find((s) => s.source === 'codex' && s.id === THREAD_ID);
    assert.ok(codex, 'codex row found');
    assert.equal(codex.project, '<codex>');
    assert.equal(codex.cwd, 'C:\\git\\test');
    assert.equal(codex.sessionId, SESSION_ID);
    assert.equal(codex.source, 'codex');
    assert.ok(codex.file?.includes(ROLLOUT), 'file relpath stored');
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('listSessions: Codex subagent rollouts nest under their root thread while orphans remain visible', async () => {
  const childId = '019fb617-e20b-7501-844d-01fe34169a73';
  const orphanId = '019fb617-a4b4-7853-add8-fdffb1260ff9';
  const writeThread = (id, sessionId, threadSource, title) => {
    writeFileSync(join(ROLLOUT_DIR, `rollout-2026-07-25T10-26-16-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, session_id: sessionId, cwd: 'C:\\git\\test', thread_source: threadSource } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } }),
    ].join('\n') + '\n');
  };
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  writeThread(THREAD_ID, THREAD_ID, 'user', 'Root task');
  writeThread(childId, THREAD_ID, 'subagent', 'assistant /root: Message Type: NEW_TASK');
  writeThread(orphanId, '019fb612-0000-0000-0000-000000000000', 'subagent', 'Orphan task');
  try {
    const sessions = await listSessions({ root: join(CODEX_HOME, 'nonexistent') });
    const parent = sessions.find((s) => s.id === THREAD_ID);
    assert.ok(parent);
    assert.equal(parent.subagents.length, 1);
    assert.equal(parent.subagents[0].id, childId);
    assert.equal(parent.subagents[0].source, 'codex');
    assert.ok(parent.subagents[0].file.endsWith(`${childId}.jsonl`));
    assert.equal(sessions.some((s) => s.id === childId), false);
    assert.ok(sessions.some((s) => s.id === orphanId));
    const child = await readSession('<codex>', childId, undefined, 'codex', parent.subagents[0].file);
    assert.equal(child.messages[0].text, 'assistant /root: Message Type: NEW_TASK');
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('readSession: source codex parses user + assistant + toolUse messages', async () => {
  writeRollout(EVENTS);
  try {
    const r = await readSession('<codex>', THREAD_ID, undefined, 'codex');
    assert.equal(r.ok, true);
    assert.equal(r.meta.source, 'codex');
    assert.equal(r.meta.sessionId, SESSION_ID);
    assert.equal(r.meta.cwd, 'C:\\git\\test');
    assert.equal(r.meta.model, 'gpt-5.6-sol');
    assert.equal(r.meta.turns, 1); // one assistant message
    // user message
    const user = r.messages.find((m) => m.role === 'user');
    assert.ok(user, 'user message present');
    assert.equal(user.text, 'how to start codex in sandbox?');
    // assistant text
    const asst = r.messages.find((m) => m.role === 'assistant' && m.kind === 'text');
    assert.ok(asst, 'assistant text present');
    assert.equal(asst.text, 'You can start codex with --sandbox flag.');
    // toolUse
    const tool = r.messages.find((m) => m.kind === 'toolUse');
    assert.ok(tool, 'toolUse present');
    assert.equal(tool.name, 'shell_command');
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('readSession: source codex returns not-found for unknown id', async () => {
  const r = await readSession('<codex>', 'nonexistent-uuid', undefined, 'codex');
  assert.equal(r.ok, false);
});

test('searchSessions: codex transcripts are searched and tagged with source', async () => {
  writeRollout(EVENTS);
  try {
    const { results } = await searchSessions('sandbox', { root: join(CODEX_HOME, 'nonexistent') });
    const codexHit = results.find((r) => r.source === 'codex');
    assert.ok(codexHit, 'codex search result found');
    assert.equal(codexHit.id, THREAD_ID);
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('readSession: response_item users and tool outputs render without duplicate user turns', async () => {
  writeRollout([
    EVENTS[0],
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<recommended_plugins>\nPlugin guidance\n</recommended_plugins>' },
      { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nRepo guidance\n</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\nShell details\n</environment_context>' },
    ] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First item-only prompt' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this rollout' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Inspect this rollout' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'command output' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'patch' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'patch result' }] } }),
  ]);
  try {
    const r = await readSession('<codex>', THREAD_ID, undefined, 'codex');
    assert.equal(r.meta.title, 'First item-only prompt');
    assert.deepEqual(r.messages.map(({ role, kind, text }) => ({ role, kind, text })), [
      { role: 'user', kind: 'text', text: 'First item-only prompt' },
      { role: 'user', kind: 'text', text: 'Inspect this rollout' },
      { role: 'assistant', kind: 'toolUse', text: '{}' },
      { role: 'user', kind: 'toolResult', text: 'command output' },
      { role: 'assistant', kind: 'toolUse', text: 'patch' },
      { role: 'user', kind: 'toolResult', text: 'patch result' },
    ]);
    const { results } = await searchSessions('patch result', { root: join(CODEX_HOME, 'nonexistent') });
    assert.equal(results.length, 1);
    assert.equal((await searchSessions('Repo guidance', { root: join(CODEX_HOME, 'nonexistent') })).results.length, 0);
    const sessions = await listSessions({ root: join(CODEX_HOME, 'nonexistent') });
    assert.equal(sessions[0].title, 'First item-only prompt');
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('listSessions: injected wrapper-tag context (<user_instructions>, <turn_aborted>) never becomes the title', async () => {
  const user = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeRollout([
    EVENTS[0],
    user('<user_instructions>\nBe terse\n</user_instructions>'),
    user('<turn_aborted>\nThe user interrupted\n</turn_aborted>'),
    user('Real prompt'),
  ]);
  try {
    const sessions = await listSessions({ root: join(CODEX_HOME, 'nonexistent') });
    assert.equal(sessions[0].title, 'Real prompt');
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('response_item XML task prompts remain searchable transcript and title text', async () => {
  const prompt = '<task>Build a widget that preserves XML prompt text</task>';
  writeRollout([
    EVENTS[0],
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  ]);
  try {
    const session = await readSession('<codex>', THREAD_ID, undefined, 'codex');
    assert.equal(session.meta.title, prompt);
    assert.equal(session.messages[0].text, prompt);
    const { results } = await searchSessions('preserves XML prompt text', { root: join(CODEX_HOME, 'nonexistent') });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, THREAD_ID);
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

test('hideReviews excludes Codex review prompts before the list cap and from search', async () => {
  const reviewId = '019f9718-405c-7fd3-9b8a-f3af71880fe3';
  const reviewFile = join(ROLLOUT_DIR, `rollout-2026-07-24T10-26-16-${reviewId}.jsonl`);
  const reviewPrompt = 'The following is the Codex agent history whose request action you are assessing. ' + 'x'.repeat(70000) + ' shared needle';
  writeRollout([EVENTS[0], JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shared needle ordinary work' }] } })]);
  writeFileSync(reviewFile, [EVENTS[0], JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: reviewPrompt }] } })].join('\n') + '\n');
  utimesSync(join(ROLLOUT_DIR, ROLLOUT), new Date('2026-07-24T00:00:00Z'), new Date('2026-07-24T00:00:00Z'));
  utimesSync(reviewFile, new Date('2026-07-25T00:00:00Z'), new Date('2026-07-25T00:00:00Z'));
  try {
    const root = join(CODEX_HOME, 'nonexistent');
    assert.equal((await listSessions({ cap: 1, root })).at(0).id, reviewId);
    assert.equal((await listSessions({ cap: 1, root, hideReviews: true })).at(0).id, THREAD_ID);
    const { results } = await searchSessions('shared needle', { root, hideReviews: true });
    assert.deepEqual([...new Set(results.map((r) => r.id))], [THREAD_ID]);
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

// The hideReviews fallback scans past the 64 KB head in 64 KB chunks and stops
// at the first user record; each fixture puts that record (or none) past the
// head, several of them on a chunk boundary, and must classify as a full read.
test('hideReviews: chunked review scan classifies like a full read across chunk boundaries', async () => {
  const CHUNK = 65536;
  const REVIEW = 'The following is the Codex agent history whose request action you are assessing.';
  const meta = (id) => JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: 'C:\\git\\scan' } });
  const userLine = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  // Non-deciding developer message padded to exactly `bytes` (ASCII) bytes.
  const filler = (bytes) => {
    const base = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '' }] } });
    return base.replace('"text":""', `"text":"${'x'.repeat(bytes - base.length)}"`);
  };
  const ids = {};
  const fixture = (key, n, build) => {
    const id = `019fb000-0000-7000-8000-00000000000${n}`;
    ids[key] = id;
    writeFileSync(join(ROLLOUT_DIR, `rollout-2026-07-20T00-00-00-${id}.jsonl`), build(meta(id)));
  };
  // (d) the review line's 'é' (2 bytes) starts at byte CHUNK-1, so it straddles the chunk boundary
  const eText = `${REVIEW} ${'y'.repeat(200)}é tail`;
  const eLine = userLine(eText);
  const eOffset = Buffer.byteLength(eLine.slice(0, eLine.indexOf('é')));
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  fixture('a', 1, (m) => [m, filler(70000), userLine(`${REVIEW} judge this`)].join('\n') + '\n');
  fixture('b', 2, (m) => [m, filler(70000), userLine('ordinary work')].join('\n') + '\n');
  fixture('c', 3, (m) => [m, filler(70000), userLine('<environment_context>\n  <cwd>C:\\git\\scan</cwd>\n</environment_context>'),
    JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author: 'root', content: [{ type: 'input_text', text: `${REVIEW} not a user record` }] } })].join('\n') + '\n');
  fixture('d', 4, (m) => [m, filler(CHUNK - 1 - eOffset - Buffer.byteLength(m) - 2), eLine].join('\n') + '\n');
  // (e) CRLF endings, the filler's '\r' is the chunk's last byte and its '\n' the next chunk's first
  fixture('e', 5, (m) => [m, filler(CHUNK - 1 - Buffer.byteLength(m) - 2), userLine(`${REVIEW} crlf`)].join('\r\n') + '\r\n');
  // (f) the review record is the last line, complete JSON, no trailing newline
  fixture('f', 6, (m) => [m, filler(70000), userLine(`${REVIEW} no newline`)].join('\n'));
  // (g) role spelled "\u0075ser": only the \u branch of the prefilter lets it through
  fixture('g', 7, (m) => [m, filler(70000), userLine(`${REVIEW} escaped`).replace('"role":"user"', '"role":"\\u0075ser"')].join('\n') + '\n');
  try {
    const root = join(CODEX_HOME, 'nonexistent');
    const all = new Set((await listSessions({ root })).map((s) => s.id));
    for (const id of Object.values(ids)) assert.ok(all.has(id), `${id} listed without hideReviews`);
    const kept = new Set((await listSessions({ root, hideReviews: true })).map((s) => s.id));
    const expected = { a: false, b: true, c: true, d: false, e: false, f: false, g: false };
    for (const [key, keep] of Object.entries(expected)) assert.equal(kept.has(ids[key]), keep, `fixture (${key}) ${keep ? 'kept' : 'excluded'}`);
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

// C4: session_meta.source gates the head-miss review scan. A review prompt past
// the 64 KB head is only detected when the scan runs, so a string / thread_spawn
// source (never a review) stays listed, guardian and unknown shapes are scanned.
test('hideReviews: head-miss scan skipped for string/thread_spawn source, kept for guardian and unknown source', async () => {
  const REVIEW = 'The following is the Codex agent history whose request action you are assessing.';
  const fixtures = [
    ['1', 'cli', true], ['2', { subagent: { thread_spawn: { depth: 1 } } }, true],
    ['3', { subagent: { other: 'guardian' } }, false], ['4', { mystery: 1 }, false],
    ['5', 'unknown', false], ['6', 'mcp', false], ['7', 'exec', true], ['8', 'vscode', true],
  ];
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  const pad = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x'.repeat(70000) }] } });
  const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${REVIEW} judge` }] } });
  const ids = fixtures.map(([n, source]) => {
    const id = `019fc000-0000-7000-8000-00000000000${n}`;
    const meta = JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: 'C:\\git\\src', source } });
    writeFileSync(join(ROLLOUT_DIR, `rollout-2026-07-21T00-00-00-${id}.jsonl`), [meta, pad, user].join('\n') + '\n');
    return id;
  });
  try {
    const kept = new Set((await listSessions({ root: join(CODEX_HOME, 'nonexistent'), hideReviews: true })).map((s) => s.id));
    fixtures.forEach(([, , keep], i) => assert.equal(kept.has(ids[i]), keep, `fixture ${i + 1} ${keep ? 'kept (scan skipped)' : 'excluded (scanned)'}`));
  } finally {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});

// F1: a rollout that vanishes between the head peek and the review scan drops
// only its own row; the list still resolves with the other rows.
test('hideReviews: rollout unreadable at review-scan time drops its row, list still resolves', async () => {
  const meta = (id) => JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: 'C:\\git\\van' } });
  const pad = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x'.repeat(70000) }] } });
  const vanId = '019fd000-0000-7000-8000-000000000001', okId = '019fd000-0000-7000-8000-000000000002';
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  const vanPath = join(ROLLOUT_DIR, `rollout-2026-07-22T00-00-00-${vanId}.jsonl`);
  writeFileSync(vanPath, [meta(vanId), pad].join('\n') + '\n');
  writeFileSync(join(ROLLOUT_DIR, `rollout-2026-07-22T00-00-00-${okId}.jsonl`),
    [meta(okId), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'ordinary work' } })].join('\n') + '\n');
  // First open of vanPath (the head peek) passes through; later opens (the scan) fail as if deleted.
  const realOpen = fsp.open;
  let opens = 0;
  fsp.open = async (p, ...a) => {
    if (p === vanPath && ++opens > 1) throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
    return realOpen(p, ...a);
  };
  syncBuiltinESMExports();
  try {
    const rows = await listSessions({ root: join(CODEX_HOME, 'nonexistent'), hideReviews: true });
    assert.ok(opens > 1, 'scan attempted an open after the peek');
    const ids = new Set(rows.map((s) => s.id));
    assert.ok(ids.has(okId), 'other row still listed');
    assert.ok(!ids.has(vanId), 'vanished row dropped');
  } finally {
    fsp.open = realOpen;
    syncBuiltinESMExports();
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
});
