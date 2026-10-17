// Unit tests for the Usage view's 5h history (usage-history.mjs): window
// selection from the account % logs and the cost-share split per session,
// plus the statusline's cost-history.jsonl append it reads.
// Every external root (usage-report state, ~/.claude, ~/.codex) points at a
// scratch dir, so nothing real is read. Run: pnpm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, statSync, appendFileSync } from 'node:fs';
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

const { getUsageHistory, tailRows } = await import('./usage-history.mjs');

const pad = (n) => String(n).padStart(2, '0');
// The writers' fetched_at: local time, no zone.
const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const jsonl = (file, rows) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

const NOW = Date.now();
const RESET = NOW + 3.6e6; // window started 4h ago
const T = [NOW - 3 * 3.6e6, NOW - 2 * 3.6e6, NOW - 3.6e6]; // three readings in the window
mkdirSync(STATE, { recursive: true });
// $1/MTok on input only keeps the cost shares easy to read.
writeFileSync(join(STATE, 'pricing.json'), JSON.stringify({ base: { opus: [1, 0, 0, 0], 'gpt-6-pro': [2, 0, 0, 0], 'gpt-6': [1, 0, 0, 0] }, default_key: 'opus' }));

test('claude: each interval rise splits by session cost share; first reading stays unattributed', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [
    // Previous window: outside the current one, never charted.
    { fetched_at: local(NOW - 6 * 3.6e6), raw: { five_hour: { utilization: 90, resets_at: new Date(NOW - 4.5 * 3.6e6).toISOString() } } },
    ...[10, 20, 30].map((u, i) => ({ fetched_at: local(T[i]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })),
  ]);
  const proj = join(scratch, 'claude', 'projects', 'C--repo');
  const msg = (id, ms, tokens) => ({ type: 'assistant', timestamp: new Date(ms).toISOString(), cwd: join(scratch, 'repo'), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: tokens } } });
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
  // UUIDv7-style ids started in the same second share their first 8 chars.
  const X = '01a14896-0000-7000-8000-0000thread-x';
  const Y = '01a14896-0000-7000-8000-0000thread-y';
  jsonl(join(dir, 'rollout-x.jsonl'), [
    { timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id: X, cwd: join(scratch, 'proj') } },
    { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    tc(T[0] + 60_000, 100), tc(T[0] + 61_000, 100),
  ]);
  jsonl(join(dir, 'rollout-y.jsonl'), [
    { timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id: Y, cwd: join(scratch, 'proj') } },
    { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    tc(T[0] + 90_000, 100),
  ]);
  const doc = getUsageHistory('codex', NOW);
  // 50/50 only if x's repeated total is skipped; counting it gives 6.67/3.33.
  assert.deepEqual(doc.points[1].sessions, { [X]: 5, [Y]: 5, _unattributed: 5 });
  // Labels end in the id's last 8 chars, so a shared prefix still tells them apart.
  assert.deepEqual(doc.sessions.filter((s) => s.id !== '_unattributed').map((s) => s.label).sort(), ['proj · thread-x', 'proj · thread-y']);
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
  const meta = (id) => [{ timestamp: new Date(T[0]).toISOString(), type: 'session_meta', payload: { id, cwd: join(scratch, 'proj') } }, { timestamp: new Date(T[0]).toISOString(), type: 'turn_context', payload: { model: 'gpt-6-luna' } }];
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

test('claude: sessions with statusline cost rows split by reported cost deltas; others fall back to transcripts', (t) => {
  // Clean up even when an assertion throws, so later tests never see these rows.
  t.after(() => { rmSync(join(STATE, 'cost-history.jsonl.1'), { force: true }); rmSync(join(STATE, 'cost-history.jsonl'), { force: true }); });
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
});

test('claude: statusline 5h % rows add in-window points; off-window rows ignored; equal readings collapse', () => {
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [10, 30].map((u, i) => ({ fetched_at: local(T[i * 2]), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } })));
  const row = (ms, pct, reset = RESET) => ({ ts: new Date(ms).toISOString(), session_id: 'sess-z', cost_usd: 1, tokens: null, five_hour_pct: pct, five_hour_resets_at: Math.floor(reset / 1000) });
  jsonl(join(STATE, 'cost-history.jsonl'), [
    row(T[1], 20), row(T[1] + 1000, 20), // new point, then a duplicate
    row(T[1] + 2000, 99, RESET - 6 * 3.6e6), // other window
  ]);
  const doc = getUsageHistory('claude', NOW);
  assert.deepEqual(doc.points.map((p) => p.pct), [10, 20, 30]);
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

test('codex: hook rows are priced at the rollout model active at their time, not its final model', () => {
  rmSync(join(scratch, 'codex'), { recursive: true, force: true });
  const hook = (ms, input) => ({ fetched_at: local(ms), session: null, weekly: null, session_id: 'thread-m', last_token_usage: null, total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input } });
  const gauge = (ms, u) => ({ fetched_at: local(ms), session: { utilization: u, resets_at: new Date(RESET).toISOString() } });
  jsonl(join(STATE, 'codex-usage.jsonl'), [gauge(T[0], 5), hook(T[0] + 61_000, 1000), gauge(T[1], 15), hook(T[0] + 100_000, 1300), gauge(T[2], 25)]);
  const d = new Date(T[0]);
  const dir = join(scratch, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  const iso = (ms) => new Date(ms).toISOString();
  const tc = (ms, total) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 100 } } } });
  const ctx = (ms, model) => ({ timestamp: iso(ms), type: 'turn_context', payload: { model } });
  // m: gpt-6-pro ($2/MTok) for its first turn, switches to gpt-6-luna ($1) after; the +300 hook delta is a pro-era turn.
  jsonl(join(dir, 'rollout-m.jsonl'), [
    { timestamp: iso(T[0]), type: 'session_meta', payload: { id: 'thread-m', cwd: join(scratch, 'proj') } },
    ctx(T[0], 'gpt-6-pro'), tc(T[0] + 65_000, 1), ctx(T[1] + 10_000, 'gpt-6-luna'), tc(T[1] + 60_000, 2),
  ]);
  jsonl(join(dir, 'rollout-n.jsonl'), [
    { timestamp: iso(T[0]), type: 'session_meta', payload: { id: 'thread-n', cwd: join(scratch, 'proj') } },
    ctx(T[0], 'gpt-6-luna'), tc(T[0] + 90_000, 1),
  ]);
  const doc = getUsageHistory('codex', NOW);
  // m 300 tok at $2 = 600 vs n 100 at $1: 8.57/1.43. Final-model pricing would give 7.5/2.5.
  assert.deepEqual(doc.points[1].sessions, { 'thread-m': 8.57, 'thread-n': 1.43, _unattributed: 5 });
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

test('7d: weekly % line per provider from resets_at - 7d, no session split, one reading per 15 min', () => {
  const DAY = 86_400_000;
  const B = 15 * 60 * 1000;
  const wReset = NOW + 2 * DAY; // weekly window started 5 days ago
  const tb = Math.floor((NOW - DAY) / B) * B + 60_000; // two readings inside one 15-min bucket
  const W = [NOW - 8 * DAY, NOW - 3 * DAY, tb, tb + 120_000];
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [40, 50, 60, 61].map((u, i) => ({ fetched_at: local(W[i]), raw: { five_hour: { utilization: 1, resets_at: new Date(RESET).toISOString() }, seven_day: { utilization: u, resets_at: new Date(wReset).toISOString() } } })));
  const claude = getUsageHistory('claude', NOW, '7d');
  assert.equal(claude.window, '7d');
  assert.equal(claude.estimated, false);
  assert.deepEqual(claude.sessions, []);
  assert.equal(claude.windowStart, new Date(wReset - 7 * DAY).toISOString());
  assert.deepEqual(claude.points.map((p) => p.pct), [50, 61]); // 8 days ago is outside; 60 folds into 61
  assert.deepEqual(claude.points[1].sessions, {});
  // 5h on the same rows still reads five_hour: its window, not the weekly one.
  assert.equal(getUsageHistory('claude', NOW).windowStart, new Date(RESET - 5 * 3.6e6).toISOString());

  // Codex weekly, with an old-style epoch-seconds resets_at.
  jsonl(join(STATE, 'codex-usage.jsonl'), [{ fetched_at: local(W[1]), session: { utilization: 5, resets_at: new Date(RESET).toISOString() }, weekly: { utilization: 70, resets_at: Math.floor(wReset / 1000) } }]);
  const codex = getUsageHistory('codex', NOW, '7d');
  assert.equal(codex.estimated, false);
  assert.deepEqual(codex.points.map((p) => p.pct), [70]);
  assert.equal(codex.resetsAt, new Date(Math.floor(wReset / 1000) * 1000).toISOString());

  jsonl(join(STATE, 'ollama-usage.jsonl'), [{ fetched_at: local(W[1]), weekly: { utilization: 96.4, resets_at: new Date(wReset).toISOString() } }]);
  assert.deepEqual(getUsageHistory('ollama', NOW, '7d').points.map((p) => p.pct), [96.4]);
});

test('unknown window is rejected (route 400s)', () => {
  assert.equal(getUsageHistory('claude', NOW, '1d'), null);
});

// The pre-cache cold read (whole tail re-read, first partial line dropped), parsed.
const coldRows = (file, bytes) => {
  const buf = readFileSync(file);
  const len = Math.min(buf.length, bytes);
  const lines = buf.subarray(buf.length - len).toString('utf8').split('\n');
  if (len < buf.length) lines.shift();
  return lines.filter(Boolean).flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
};

test('tailRows: incremental appends always equal a cold tail read', () => {
  const file = join(scratch, 'tail', 'log.jsonl');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let i = 0; i < 300; i++) {
    // Rows of varied length (multibyte too); some appends end mid-line, completed by the next.
    const row = JSON.stringify({ i, s: 'é'.repeat(rand(40)) + 'x'.repeat(rand(200)) }) + '\n';
    const cut = rand(4) === 0 ? rand(row.length) : row.length;
    appendFileSync(file, row.slice(0, cut));
    if (cut < row.length) {
      for (const b of [600, 5000, 1e6]) assert.deepEqual(tailRows(file, b), coldRows(file, b), `fragment, i=${i} bytes=${b}`);
      appendFileSync(file, row.slice(cut));
    }
    if (rand(3) === 0) appendFileSync(file, '\n'); // blank lines are skipped
    for (const b of [600, 5000, 1e6]) assert.deepEqual(tailRows(file, b), coldRows(file, b), `i=${i} bytes=${b}`);
    assert.deepEqual(tailRows(file, 5000, 700), coldRows(file, 700), `keep, i=${i}`);
  }
});

test('tailRows: a shrunk, replaced or in-place rewritten file reads cold', () => {
  const file = join(scratch, 'tail', 'rewrite.jsonl');
  jsonl(file, [1, 2, 3, 4].map((n) => ({ n })));
  assert.deepEqual(tailRows(file, 1e6).map((r) => r.n), [1, 2, 3, 4]);
  rmSync(file);
  jsonl(file, [5].map((n) => ({ n })));
  assert.deepEqual(tailRows(file, 1e6).map((r) => r.n), [5]);
  writeFileSync(file, [6, 7, 8].map((n) => JSON.stringify({ n })).join('\n') + '\n'); // larger, same inode
  assert.deepEqual(tailRows(file, 1e6).map((r) => r.n), [6, 7, 8]);
  rmSync(file);
  assert.deepEqual(tailRows(file, 1e6), []);
});

test('claude totals span the newest monthly archive and the live file; the doc is memoized', () => {
  const snap = (t, u) => ({ fetched_at: local(t), raw: { five_hour: { utilization: u, resets_at: new Date(RESET).toISOString() } } });
  const archive = join(STATE, 'usage-snapshots-2000-01.jsonl');
  jsonl(join(STATE, 'usage-snapshots-1999-12.jsonl'), [snap(T[0], 99)]); // older archive: never read
  jsonl(archive, [snap(T[0], 11), snap(T[1], 22)]);
  jsonl(join(STATE, 'usage-snapshots.jsonl'), [snap(T[2], 33)]);
  try {
    const doc = getUsageHistory('claude', NOW);
    assert.deepEqual(doc.points.map((p) => p.pct), [11, 22, 33]);
    assert.equal(getUsageHistory('claude', NOW), doc); // unchanged inputs: same doc
    appendFileSync(join(STATE, 'usage-snapshots.jsonl'), JSON.stringify(snap(T[2] + 60_000, 44)) + '\n');
    const next = getUsageHistory('claude', NOW);
    assert.notEqual(next, doc);
    assert.deepEqual(next.points.map((p) => p.pct), [11, 22, 33, 44]);
    // A just-rotated live file (missing): the archive alone is the stream.
    rmSync(join(STATE, 'usage-snapshots.jsonl'));
    assert.deepEqual(getUsageHistory('claude', NOW).points.map((p) => p.pct), [11, 22]);
  } finally {
    rmSync(archive, { force: true });
    rmSync(join(STATE, 'usage-snapshots-1999-12.jsonl'), { force: true });
  }
});