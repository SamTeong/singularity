// Unit tests for per-agent stats: pricing-table cost estimate from a fake
// session .jsonl (parseSession) and the global statusline cost-state vs. estimate
// cost-source precedence (statsFor). Transcripts write under the real
// ~/.claude/projects (cleaned per-test in a finally); cost files route through
// USAGE_REPORT_STATE scratch so they never touch the user's real cost-state. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-stats-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-report-state');
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { encodeCwd } = await import('./agents.mjs');
const { parseSession, statsFor, sessionStats, COST_STATE_DIR } = await import('./stats.mjs');

function writeTranscript(cwd, id, lines) {
  const dir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

test('parseSession: turns/tokens/estCostUsd from a known-model usage block', async () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-known';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 },
      },
    },
  ]);
  try {
    const result = await parseSession(cwd, id);
    assert.equal(result.exists, true);
    assert.equal(result.turns, 1);
    assert.equal(result.tokens, 1800); // 1000+500+200+100
    // (1000*3 + 500*15)/1e6 + (200*3*0.1)/1e6 + (100*3*1.25)/1e6 = 0.010935
    assert.ok(Math.abs(result.estCostUsd - 0.010935) < 1e-9, result.estCostUsd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSession: unknown model → estCostUsd stays null (tokens/turns still counted)', async () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-unknown';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'gpt-4o', usage: { input_tokens: 10, output_tokens: 20 } } },
  ]);
  try {
    const result = await parseSession(cwd, id);
    assert.equal(result.turns, 1);
    assert.equal(result.tokens, 30);
    assert.equal(result.estCostUsd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionStats: per-bucket token breakdown + models, keyed by project dirname', async () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-breakdown';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } } },
    { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
  try {
    const s = await sessionStats(encodeCwd(cwd), id); // route passes the encoded-cwd project dirname
    assert.equal(s.inputTokens, 1010);
    assert.equal(s.outputTokens, 505);
    assert.equal(s.cacheReadTokens, 200);
    assert.equal(s.cacheWriteTokens, 100);
    assert.equal(s.tokens, 1815);
    assert.deepEqual([...s.models].sort(), ['claude-opus-4-8', 'claude-sonnet-4-5']);
    assert.equal(s.costSource, 'estimate');
    assert.ok(s.costUsd > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statsFor: global statusline cost-state file present → costSource "statusline" wins over the estimate', async () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-statusline';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 } } },
  ]);
  const costFile = join(COST_STATE_DIR, `${id}.json`);
  mkdirSync(COST_STATE_DIR, { recursive: true });
  writeFileSync(costFile, JSON.stringify({ session_id: id, cost: { total_cost_usd: 1.23, total_api_duration_ms: 111, total_duration_ms: 222 } }));
  try {
    const out = await statsFor([{ id, cwd }]);
    assert.equal(out[id].costSource, 'statusline');
    assert.equal(out[id].costUsd, 1.23);
    assert.equal(out[id].apiMs, 111);
    assert.equal(out[id].wallMs, 222);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(costFile, { force: true });
  }
});

test('statsFor: no cost-state file → costSource "estimate" (falls back to the pricing table)', async () => {
  const cwd = 'C:\\definitely\\not\\a\\real\\repo\\path\\stats-estimate';
  const id = randomUUID();
  const dir = writeTranscript(cwd, id, [
    { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 } } },
  ]);
  try {
    const out = await statsFor([{ id, cwd }]);
    assert.equal(out[id].costSource, 'estimate');
    assert.ok(out[id].costUsd > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
