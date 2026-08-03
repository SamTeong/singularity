// Unit tests for codex-rollout token parsing in parseSession (tool='codex').
// Codex sessions live under CODEX_HOME/sessions/**/rollout-*.jsonl keyed by
// their own thread uuid, so parseSession locates the rollout by cwd (not the
// singularity agent id). Sets CODEX_HOME to a scratch dir BEFORE the dynamic
// import (stats.mjs captures CODEX_HOME at module load). Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-stats-codex-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
const CODEX_HOME = mkdtempSync(join(tmpdir(), 'sing-codex-stats-'));
process.env.CODEX_HOME = CODEX_HOME;
after(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(CODEX_HOME, { recursive: true, force: true }); });

const { parseSession } = await import('./stats.mjs');

const THREAD_ID = randomUUID();
const ROLLOUT = `rollout-2099-12-31T00-00-00-${THREAD_ID}.jsonl`;
const ROLLOUT_DIR = join(CODEX_HOME, 'sessions', '2099', '12', '31');
// Use a distinctive cwd; codex records it verbatim in session_meta.
const CWD = 'C:\\definitely\\not\\real\\codex-stats-test';

function writeRollout(lines) {
  mkdirSync(ROLLOUT_DIR, { recursive: true });
  writeFileSync(join(ROLLOUT_DIR, ROLLOUT), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const EVENTS = [
  { type: 'session_meta', payload: { session_id: THREAD_ID, cwd: CWD } },
  { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200, cache_write_input_tokens: 100 } } } },
];

test('parseSession: tool="codex" parses rollout tokens by cwd match', async () => {
  writeRollout(EVENTS);
  try {
    // id is irrelevant for codex (codex has no --session-id); lookup is by cwd.
    const r = await parseSession(CWD, randomUUID(), 'codex');
    assert.equal(r.exists, true);
    assert.equal(r.turns, 1);
    assert.equal(r.models[0], 'gpt-5.6-sol');
    // input_tokens (1000) includes cached (200) → strip: input 800, cacheRead 200.
    assert.equal(r.inputTokens, 800);
    assert.equal(r.outputTokens, 500);
    assert.equal(r.cacheReadTokens, 200);
    assert.equal(r.cacheWriteTokens, 100);
    assert.equal(r.tokens, 1600); // 800+500+200+100
    assert.equal(r.estCostUsd, null); // no gpt-* entries in the server PRICES table
  } finally {
    rmSync(ROLLOUT_DIR, { recursive: true, force: true });
  }
});

test('parseSession: tool="codex" accumulates across multiple token_count events', async () => {
  writeRollout([
    ...EVENTS.slice(0, 3),
    EVENTS[3],
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, output_tokens: 50 } } } },
  ]);
  try {
    const r = await parseSession(CWD, randomUUID(), 'codex');
    assert.equal(r.inputTokens, 1000); // 800 + 200
    assert.equal(r.outputTokens, 550); // 500 + 50
    assert.equal(r.tokens, 1850); // 1000+550+200+100
  } finally {
    rmSync(ROLLOUT_DIR, { recursive: true, force: true });
  }
});

test('parseSession: tool="codex" with no matching rollout → exists:false', async () => {
  const r = await parseSession('C:\\no\\such\\codex\\cwd', randomUUID(), 'codex');
  assert.equal(r.exists, false);
  assert.equal(r.tokens, 0);
});

test('parseSession: no tool (claude path) does NOT fall back to a codex rollout', async () => {
  // A codex rollout exists at CWD, but a claude agent (no tool) with no claude
  // log must not misattribute the codex rollout's tokens.
  writeRollout(EVENTS);
  try {
    const r = await parseSession(CWD, randomUUID());
    assert.equal(r.exists, false, 'claude path fails closed — no codex fallback without tool="codex"');
    assert.equal(r.tokens, 0);
  } finally {
    rmSync(ROLLOUT_DIR, { recursive: true, force: true });
  }
});