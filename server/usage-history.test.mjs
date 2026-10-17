// Unit tests for the Usage view's 5h history (usage-history.mjs): window
// selection from the account % logs and the cost-share split per session,
// plus the statusline's cost-history.jsonl append it reads.
// Every external root (usage-report state, ~/.claude, ~/.codex) points at a
// scratch dir, so nothing real is read. Run: pnpm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'singularity-usage-history-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'sing');
const STATE = join(scratch, 'usage-report-state');
process.env.USAGE_REPORT_STATE = STATE;
process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude');
process.env.CODEX_HOME = join(scratch, 'codex');
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const { getUsageHistory } = await import('./usage-history.mjs');

const pad = (n) => String(n).padStart(2, '0');
// The writers' fetched_at: local time, no zone.
const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const jsonl = (file, rows) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

const NOW = Date.now();
const RESET = NOW + 3.6e6; // window started 4h ago
const T = [NOW - 3 * 3.6e6, NOW - 2 * 3.6e6, NOW - 3.6e6]; // three readings in the window
mkdirSync(STATE, { recursive: true });
// $1/MTok on input only keeps the cost shares easy to read.
writeFileSync(join(STATE, 'pricing.json'), JSON.stringify({ base: { opus: [1, 0, 0, 0], 'gpt-6': [1, 0, 0, 0] }, default_key: 'opus' }));

test('claude: each interval rise splits by session cost share; first reading stays unattributed', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [
    // Previous window: outside the current one, never charted.
    { fetched_at: local(NOW - 6 * 3.6e6), raw: { five_hour: { utilization: 90, resets_at: new Date(NOW - 4.5 * 3.6e6).toISOString() } } },
    ...[10, 20, 30].map((u, i) => ({ fetched_at: local(T[i]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })),
  ]);
  const proj = join(scratch, 'claude', 'projects', 'C--repo');
  const msg = (id, ms, tokens) => ({ type: 'assistant', timestamp: new Date(ms).toISOString(), cwd: 'C:\\repo', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: tokens } } });
  // Interval 1: A (m1, streamed as a partial line then a complete one) and B
  // (via a subagent transcript) spend equally. Interval 2: only A spends.
  jsonl(join(proj, 'sess-a.jsonl'), [msg('m1', T[0] + 60_000, 50), msg('m1', T[0] + 61_000, 100), msg('m2', T[1] + 60_000, 100)]);
  jsonl(join(proj, 'sess-b', 'subagents', 'agent-1.jsonl'), [msg('m3', T[0] + 120_000, 100)]);

  const doc = getUsageHistory('claude', NOW);
  assert.equal(doc.estimated, true);
  assert.equal(doc.resetsAt, new Date(RESET).toISOString());
  assert.equal(doc.points.length, 3);
  assert.deepEqual(doc.points.map((p) => p.pct), [10, 20, 30]);
  // 50/50 only if m1 counts once, at its last line's usage:
  // no dedupe gives 6/4, first-line-wins 3.33/6.67.
  assert.deepEqual(doc.points[1].sessions, { 'sess-a': 5, 'sess-b': 5, _unattributed: 10 });
  assert.deepEqual(doc.points[2].sessions, { 'sess-a': 15, 'sess-b': 5, _unattributed: 10 });
  assert.equal(doc.sessions[0].label, 'repo · sess-a');
  assert.equal(doc.sessions.at(-1).id, '_unattributed');
});

test('claude: a % drop scales every share so the stack still sums to the account %', () => {
  // Reuses the transcripts above: interval 1 splits 20 points 10/10.
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [10, 30, 15].map((u, i) => ({ fetched_at: local(T[i]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })));
  const doc = getUsageHistory('claude', NOW);
  assert.deepEqual(doc.points[2].sessions, { 'sess-a': 5, 'sess-b': 5, _unattributed: 5 });
});

test('claude: a window whose reset has passed is not charted as current', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [{ fetched_at: local(T[0]), raw: { five_hour: { utilization: 40, resets_at: new Date(NOW - 60_000).toISOString() } } }]);
  const doc = getUsageHistory('claude', NOW);
  assert.deepEqual(doc.points, []);
  assert.equal(doc.resetsAt, null);
});

test('codex: rollout token_count spend is attributed; repeated totals are not new spend', () => {
  jsonl(join(STATE, 'codex-usage.jsonl'), [0, 1].map((i) => ({ fetched_at: local(T[i]), session: { utilization: [5, 15][i], resets_at: new Date(RESET).toISOString() } })));
  const d = new Date(T[0]);
  const dir = join(scratch, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  const tc = (ms, total) => ({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 150, cached_input_tokens: 50 } } } });
  jsonl(join(dir, 'rollout-x.jsonl'), [
    { timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id: 'thread-x', cwd: 'C:\\proj' } },
    { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    tc(T[0] + 60_000, 100), tc(T[0] + 61_000, 100),
  ]);
  jsonl(join(dir, 'rollout-y.jsonl'), [
    { timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id: 'thread-y', cwd: 'C:\\proj' } },
    { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    tc(T[0] + 90_000, 100),
  ]);
  const doc = getUsageHistory('codex', NOW);
  // 50/50 only if x's repeated total is skipped; counting it gives 6.67/3.33.
  assert.deepEqual(doc.points[1].sessions, { 'thread-x': 5, 'thread-y': 5, _unattributed: 5 });
  assert.equal(doc.sessions[0].label, 'proj · thread-x');
});

test('codex: Stop-hook rows split by total_token_usage deltas; rollout events outside them are the fallback; old rows still chart', () => {
  // Old-shape rows (no session_id / token keys, one daemon row with plan) give the totals.
  // The hook rows here carry no 5h gauge so they add no points; real ones do.
  const hook = (ms, input) => ({ fetched_at: local(ms), session: null, weekly: null, session_id: 'thread-x', last_token_usage: null, total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input } });
  jsonl(join(STATE, 'codex-usage.jsonl'), [
    { fetched_at: local(T[0]), session: { utilization: 5, resets_at: new Date(RESET).toISOString() } },
    hook(T[0] + 61_000, 1000), // baseline: 1000 tokens of earlier spend, not credited
    { fetched_at: local(T[1]), session: { utilization: 15, resets_at: new Date(RESET).toISOString() }, weekly: null, plan: 'pro' },
    hook(T[1] + 61_000, 1300), // +300 in interval 2; the rollout shows only 100 of it
    { fetched_at: local(T[2]), session: { utilization: 25, resets_at: new Date(RESET).toISOString() } },
  ]);
  const d = new Date(T[0]);
  const dir = join(scratch, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  const tc = (ms, total) => ({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 100 } } } });
  const meta = (id) => [{ timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id, cwd: 'C:\\proj' } }, { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } }];
  // x: one turn before its first row (fallback), one covered by its rows, one after its last row (fallback).
  jsonl(join(dir, 'rollout-x.jsonl'), [...meta('thread-x'), tc(T[0] + 60_000, 1), tc(T[1] + 60_000, 2), tc(T[1] + 120_000, 3)]);
  jsonl(join(dir, 'rollout-y.jsonl'), [...meta('thread-y'), tc(T[0] + 90_000, 1), tc(T[1] + 90_000, 2)]);
  const doc = getUsageHistory('codex', NOW);
  assert.deepEqual(doc.points.map((p) => p.pct), [5, 15, 25]);
  assert.deepEqual(doc.points[1].sessions, { 'thread-x': 5, 'thread-y': 5, _unattributed: 5 });
  // x = 300 (row delta) + 100 (after its last row) vs y 100. Rollout only: 6.67/3.33; no fallback: 7.5/2.5.
  assert.deepEqual(doc.points[2].sessions, { 'thread-x': 13, 'thread-y': 7, _unattributed: 5 });
});

test('codex: hook rows that join no rollout, or whose totals fall (mixed threads), fall back to rollout data', () => {
  // Reuses rollout-x / rollout-y above. thread-x rows as before; a root-id row pair (an
  // early hook keyed sub-agents by the root) joins no rollout; thread-y's totals fall.
  const hook = (ms, id, input) => ({ fetched_at: local(ms), session: null, weekly: null, session_id: id, last_token_usage: null, total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input } });
  const gauge = (ms, u) => ({ fetched_at: local(ms), session: { utilization: u, resets_at: new Date(RESET).toISOString() } });
  jsonl(join(STATE, 'codex-usage.jsonl'), [
    gauge(T[0], 5), hook(T[0] + 61_000, 'thread-x', 1000), hook(T[0] + 70_000, 'root-id', 0), hook(T[0] + 91_000, 'thread-y', 1000),
    gauge(T[1], 15), hook(T[1] + 61_000, 'thread-x', 1300), hook(T[1] + 80_000, 'root-id', 5000), hook(T[1] + 91_000, 'thread-y', 500),
    gauge(T[2], 25),
  ]);
  const doc = getUsageHistory('codex', NOW);
  // Same as the test above: no 'root-id' series, and y priced from its rollout (100 + 100).
  assert.deepEqual(doc.points[2].sessions, { 'thread-x': 13, 'thread-y': 7, _unattributed: 5 });
});

test('ollama: total line only, flagged not estimated', () => {
  jsonl(join(STATE, 'ollama-usage.jsonl'), [{ fetched_at: local(T[2]), session: { utilization: 12.5, resets_at: new Date(RESET).toISOString() } }]);
  const doc = getUsageHistory('ollama', NOW);
  assert.equal(doc.estimated, false);
  assert.deepEqual(doc.sessions, []);
  assert.deepEqual(doc.points.map((p) => p.pct), [12.5]);
});

test('claude: sessions with statusline cost rows split by reported cost deltas; others fall back to transcripts', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [10, 20, 30].map((u, i) => ({ fetched_at: local(T[i]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })));
  // sess-a reports $0.0003 in interval 1 (its transcript prices it $0.0001, like
  // sess-b's), then $0.0001 in interval 2. sess-b has no rows: transcript $0.0001.
  const row = (ms, cost) => ({ ts: new Date(ms).toISOString(), session_id: 'sess-a', cost_usd: cost, tokens: null, five_hour_pct: null, five_hour_resets_at: null });
  jsonl(join(STATE, 'cost-history.jsonl.1'), [row(T[0] - 60_000, 1)]);
  // sess-c's first row carries $40 of earlier, unread spend: only a baseline.
  // Then it spends $0.0001 in interval 2, like sess-a.
  const c = (ms, cost) => ({ ...row(ms, cost), session_id: 'sess-c' });
  jsonl(join(STATE, 'cost-history.jsonl'), [row(T[0] + 60_000, 1.0003), c(T[0] + 90_000, 40), row(T[1] + 60_000, 1.0004), c(T[1] + 90_000, 40.0001)]);
  const doc = getUsageHistory('claude', NOW);
  // Transcript re-pricing for both would give 5/5; crediting sess-c's $40 would give it ~10.
  assert.deepEqual(doc.points[1].sessions, { 'sess-a': 7.5, 'sess-b': 2.5, 'sess-c': 0, _unattributed: 10 });
  assert.deepEqual(doc.points[2].sessions, { 'sess-a': 12.5, 'sess-b': 2.5, 'sess-c': 5, _unattributed: 10 });
  assert.equal(doc.sessions[0].label, 'repo · sess-a');
  rmSync(join(STATE, 'cost-history.jsonl.1'));
  rmSync(join(STATE, 'cost-history.jsonl'));
});

test('claude: transcript spend before a session\'s first cost row is kept; cost deltas replace it after', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [10, 20, 30].map((u, i) => ({ fetched_at: local(T[i]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })));
  // sess-a's statusline rows start mid-window (baseline in interval 2), so its
  // interval-1 transcript m1 ($0.0001) still counts; its m2 is replaced by +$0.0003.
  const row = (ms, cost) => ({ ts: new Date(ms).toISOString(), session_id: 'sess-a', cost_usd: cost, tokens: null, five_hour_pct: null, five_hour_resets_at: null });
  jsonl(join(STATE, 'cost-history.jsonl'), [row(T[1] + 30_000, 1), row(T[1] + 90_000, 1.0003)]);
  const doc = getUsageHistory('claude', NOW);
  // Dropping a's transcript would give sess-b all of interval 1 (a 0, b 10).
  assert.deepEqual(doc.points[1].sessions, { 'sess-a': 5, 'sess-b': 5, _unattributed: 10 });
  assert.deepEqual(doc.points[2].sessions, { 'sess-a': 15, 'sess-b': 5, _unattributed: 10 });
  rmSync(join(STATE, 'cost-history.jsonl'));
});

test('statusline: appends a row only when cost or 5h % moves; rotates to .1 above 2 MB', () => {
  const sl = join(scratch, 'statusline-state');
  const hist = join(sl, 'cost-history.jsonl');
  const script = join(import.meta.dirname, '..', '.claude', 'skills', 'harness-usage-report', 'scripts', 'statusline.mjs');
  const render = (cost, pct) => execFileSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 'abc-1', cost: { total_cost_usd: cost }, rate_limits: { five_hour: { used_percentage: pct, resets_at: 1700000000 } }, context_window: { total_input_tokens: 5, total_output_tokens: 6 } }),
    env: { ...process.env, USAGE_REPORT_STATE: sl },
  });
  const rows = () => readFileSync(hist, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  render(1, 10); render(1, 10); render(2, 10); render(2, 12); render(2, 12);
  assert.deepEqual(rows().map((r) => [r.cost_usd, r.five_hour_pct]), [[1, 10], [2, 10], [2, 12]]);
  const { ts, ...rest } = rows()[0];
  assert.ok(!Number.isNaN(Date.parse(ts)));
  assert.deepEqual(rest, { session_id: 'abc-1', cost_usd: 1, tokens: { input: 5, output: 6 }, five_hour_pct: 10, five_hour_resets_at: 1700000000 });
  writeFileSync(hist, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  render(3, 12);
  assert.equal(statSync(hist + '.1').size, 2 * 1024 * 1024 + 1);
  assert.deepEqual(rows().map((r) => r.cost_usd), [3]);
});

test('no running window (newest reading has no reset) and unknown provider', () => {
  jsonl(join(STATE, 'ollama-usage.jsonl'), [{ fetched_at: local(T[2]), session: { utilization: 0, resets_at: null } }]);
  assert.deepEqual(getUsageHistory('ollama', NOW).points, []);
  assert.equal(getUsageHistory('nope', NOW), null);
});
