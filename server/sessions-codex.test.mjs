// Unit tests for Codex CLI transcript support in sessions.mjs: listSessions
// discovers rollout-*.jsonl under CODEX_HOME, readSession with source:'codex'
// parses events into messages, searchSessions includes codex transcripts.
// Fixtures write to a temp CODEX_HOME, clean up in a finally.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
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