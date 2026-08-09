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
const USAGE_REPORT_STATE = join(scratch, 'usage-report-state');
process.env.USAGE_REPORT_STATE = USAGE_REPORT_STATE;
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { encodeCwd } = await import('./agents.mjs');
const { parseSession, statsFor, sessionStats, COST_STATE_DIR, STATS_CSV, readStatsCsvCosts } = await import('./stats.mjs');

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

test('readStatsCsvCosts: max cumulative cost per session wins (rows are not file-ordered), skips header/blank/NaN', () => {
  mkdirSync(join(USAGE_REPORT_STATE, 'cost-state'), { recursive: true }); // ensure state dir exists
  const a = randomUUID(), b = randomUUID();
  // header + a-rows out of timestamp order in the file (later/higher cost row
  // appears FIRST), + a quoted facets_json column with commas, + a blank cost.
  const lines = [
    'timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json',
    `2026-08-06 00:17:12,${a},16.87,glm-5.2,200,20,0,0,glm-5.2:cloud,glm-5.2:cloud,2000,1000,2,0,,,25,200000,2,4,1786001000,"{""tools"":{""Bash"":1,""Edit"":1},""cwd"":""C:\\\\x""}"`,
    `2026-08-06 00:13:33,${a},11.05,glm-5.2,100,10,0,0,glm-5.2:cloud,glm-5.2:cloud,1000,500,1,0,,,25,200000,1,2,1786000000,"{""tools"":{""Bash"":2}}"`,
    `2026-08-07 01:30:00,${b},,glm-5.2,0,0,0,0,glm-5.2:cloud,glm-5.2:cloud,0,0,0,0,,,0,200000,0,0,0,"{}"`,
  ];
  writeFileSync(STATS_CSV, `${lines.join('\n')}\n`);
  try {
    const map = readStatsCsvCosts();
    assert.equal(map.get(a), 16.87, `max cumulative wins regardless of file order; got ${map.get(a)}`);
    assert.ok(!map.has(b), 'blank cost skipped');
    assert.ok(!map.has('session_id'), 'header skipped');
    const cached = readStatsCsvCosts(); // second call hits the mtime/size cache
    assert.equal(cached, map, 'cached map returned by reference');
  } finally {
    rmSync(STATS_CSV, { force: true });
  }
});

test('readStatsCsvCosts: empty total_cost_usd falls back to trailing est_cost_usd', () => {
  mkdirSync(join(USAGE_REPORT_STATE, 'cost-state'), { recursive: true });
  const third = randomUUID();
  // Real header, i.e. est_cost_usd last. A third-party session logs no
  // total_cost_usd, so the trailing estimate is the only usable figure.
  const lines = [
    'timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd',
    `2026-08-01 10:00:00,${third},,glm-5.2,100,10,0,0,glm-5.2:cloud,glm-5.2:cloud,1000,500,1,0,,,25,200000,1,2,1786000000,"{""tools"":{""Bash"":1,""Edit"":1}}",4.25`,
  ];
  writeFileSync(STATS_CSV, `${lines.join('\n')}\n`);
  try {
    const map = readStatsCsvCosts();
    assert.equal(map.get(third), 4.25, `est_cost_usd used when total is empty; got ${map.get(third)}`);
  } finally {
    rmSync(STATS_CSV, { force: true });
  }
});

test('readStatsCsvCosts: a row with both total_cost_usd and est_cost_usd resolves to the estimate, not the billed figure', () => {
  mkdirSync(join(USAGE_REPORT_STATE, 'cost-state'), { recursive: true });
  const id = randomUUID();
  // Anthropic-rate billed figure for a glm session (306.76) vs. the skill's
  // glm-priced estimate (128.72) — the estimate must win now that the skill
  // owns the pricing decision.
  const lines = [
    'timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd',
    `2026-08-01 12:00:00,${id},306.76,glm-5.2,100,10,0,0,glm-5.2:cloud,glm-5.2:cloud,1000,500,1,0,,,25,200000,1,2,1786000000,"{""tools"":{""Bash"":1,""Edit"":1}}",128.72`,
  ];
  writeFileSync(STATS_CSV, `${lines.join('\n')}\n`);
  try {
    const map = readStatsCsvCosts();
    assert.equal(map.get(id), 128.72, `est_cost_usd should win over the inflated billed figure; got ${map.get(id)}`);
  } finally {
    rmSync(STATS_CSV, { force: true });
  }
});

test('readStatsCsvCosts: est wins per session, not per row — a billed-only row appended after a rebuild cannot resurrect the inflated figure', () => {
  mkdirSync(join(USAGE_REPORT_STATE, 'cost-state'), { recursive: true });
  const id = randomUUID();
  // A still-running glm session: the rebuild collapsed it to one est row, then
  // the statusline appended another billed-only row for the same session.
  const lines = [
    'timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd',
    `2026-08-01 12:00:00,${id},306.76,glm-5.2,100,10,0,0,glm-5.2:cloud,glm-5.2:cloud,1000,500,1,0,,,25,200000,1,2,1786000000,"{""tools"":{""Bash"":1}}",128.72`,
    `2026-08-01 12:05:00,${id},311.40,glm-5.2,120,12,0,0,glm-5.2:cloud,glm-5.2:cloud,1200,600,1,0,,,26,200000,2,3,1786000300,"{""tools"":{""Bash"":2}}",`,
  ];
  writeFileSync(STATS_CSV, `${lines.join('\n')}\n`);
  try {
    const map = readStatsCsvCosts();
    assert.equal(map.get(id), 128.72, `billed-only row must not outrank the estimate; got ${map.get(id)}`);
  } finally {
    rmSync(STATS_CSV, { force: true });
  }
});

test('readStatsCsvCosts: an est-only row is the no-statusline fallback, not a third-party override — a later billed row still wins', () => {
  mkdirSync(join(USAGE_REPORT_STATE, 'cost-state'), { recursive: true });
  const id = randomUUID();
  // Anthropic session backfilled before its statusline captured anything (est
  // written on a row with NO billed cost), then the statusline logged the real
  // cumulative total. Neither row carries both columns, so nothing was
  // overridden and the larger billed figure is the truth.
  const lines = [
    'timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms,api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct,context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd',
    `2026-08-01 09:00:00,${id},,claude-opus-5,100,10,0,0,claude-opus-5,Opus,1000,500,1,0,,,25,200000,1,2,1786000000,"{""tools"":{""Bash"":1}}",3.50`,
    `2026-08-01 09:30:00,${id},12.00,claude-opus-5,900,90,0,0,claude-opus-5,Opus,9000,4500,4,1,,,40,200000,6,9,1786001800,"{""tools"":{""Bash"":4}}",`,
  ];
  writeFileSync(STATS_CSV, `${lines.join('\n')}\n`);
  try {
    const map = readStatsCsvCosts();
    assert.equal(map.get(id), 12.00, `billed total must win over a stale est-only fallback; got ${map.get(id)}`);
  } finally {
    rmSync(STATS_CSV, { force: true });
  }
});
