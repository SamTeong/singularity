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
  jsonl(join(STATE, 'cost-history.jsonl'), [row(T[0] + 60_000, 1.0003), row(T[1] + 60_000, 1.0004)]);
  const doc = getUsageHistory('claude', NOW);
  // Transcript re-pricing for both would give 5/5.
  assert.deepEqual(doc.points[1].sessions, { 'sess-a': 7.5, 'sess-b': 2.5, _unattributed: 10 });
  assert.deepEqual(doc.points[2].sessions, { 'sess-a': 17.5, 'sess-b': 2.5, _unattributed: 10 });
  assert.equal(doc.sessions[0].label, 'repo · sess-a');
  rmSync(join(STATE, 'cost-history.jsonl.1'));
  rmSync(join(STATE, 'cost-history.jsonl'));
});

test('statusline: appends a row only when cost or 5h % moves; rotates to .1 above 8 MB', () => {
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
  writeFileSync(hist, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  render(3, 12);
  assert.equal(statSync(hist + '.1').size, 8 * 1024 * 1024 + 1);
  assert.deepEqual(rows().map((r) => r.cost_usd), [3]);
});

test('no running window (newest reading has no reset) and unknown provider', () => {
  jsonl(join(STATE, 'ollama-usage.jsonl'), [{ fetched_at: local(T[2]), session: { utilization: 0, resets_at: null } }]);
  assert.deepEqual(getUsageHistory('ollama', NOW).points, []);
  assert.equal(getUsageHistory('nope', NOW), null);
});
