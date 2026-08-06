// Unit tests for the History backend: day bucketing + cost proration,
// ensureHistory's backfill/idempotency, the last-wins reader, the trivial-day
// gate, the anthropic->ollama->deterministic fallback chain, the digest cap,
// and "today is never persisted". LLM calls are injected stubs — no network.
//
// history.mjs imports agents.mjs/app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point SINGULARITY_HOME, CODEX_HOME (nonexistent — no real
// codex data), and USAGE_REPORT_STATE (cost-state fixtures) at scratch temp
// dirs before a dynamic import (static imports hoist above the env
// assignment). Session fixtures live under an isolated SESSIONS_ROOT (passed
// as the `root` param scanDays/ensureHistory/regenerateDay/liveToday thread
// through to listSessions/readSession) rather than the real ~/.claude/projects
// — this daemon and this very Claude Code session write there live, so an
// unscoped scan would sweep in real, unrelated activity and make day-turn
// assertions (e.g. the trivial-day gate) flaky. OLLAMA_BIN points at an
// existing (but unused) path so the ollama rung is attempted in the
// fallback-chain test — agents.mjs only checks existsSync() at module load;
// the real binary is never invoked (callOllama is stubbed).
// Run: npm test  (node --test server/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'sing-history-test-'));
process.env.SINGULARITY_HOME = join(scratch, 'singularity');
process.env.CODEX_HOME = join(scratch, 'codex-nonexistent');
process.env.USAGE_REPORT_STATE = join(scratch, 'usage-skill-state');
process.env.OLLAMA_BIN = scratch; // existsSync-true, never actually executed (callOllama is stubbed)
after(() => rmSync(scratch, { recursive: true, force: true }));

const { encodeCwd } = await import('./agents.mjs');
const { USAGE_SKILL_STATE } = await import('./app-dir.mjs');
const { readHistory, ensureHistory, regenerateDay, liveToday, scanDays, buildDigest, summarizeDay, localDay } = await import('./history.mjs');

const SESSIONS_ROOT = join(scratch, 'claude-projects');

function writeClaudeSession(cwd, id, events) {
  const dir = join(SESSIONS_ROOT, encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}
function writeCostFixture(id, totalCostUsd) {
  const dir = join(USAGE_SKILL_STATE, 'cost-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ cost: { total_cost_usd: totalCostUsd } }));
}
function textMsg(cwd, role, text, ts) {
  return role === 'user'
    ? { cwd, type: 'user', message: { content: text }, timestamp: ts }
    : { cwd, type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: ts };
}

test('scanDays: a midnight-spanning session buckets into both days, cost prorated by assistant-turn share', async () => {
  const now = new Date();
  const day1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 23, 0, 0);
  const day2 = new Date(day1.getTime() + 2 * 3600 * 1000); // +2h crosses local midnight
  const cwd = 'C:\\fake\\history-midnight-test';
  const id = 'history-midnight-fixture';
  writeClaudeSession(cwd, id, [
    textMsg(cwd, 'user', 'start work', day1.toISOString()),
    textMsg(cwd, 'assistant', 'a1', new Date(day1.getTime() + 60_000).toISOString()),
    textMsg(cwd, 'assistant', 'a2', new Date(day1.getTime() + 120_000).toISOString()),
    textMsg(cwd, 'assistant', 'a3', new Date(day1.getTime() + 180_000).toISOString()),
    textMsg(cwd, 'assistant', 'a4', new Date(day1.getTime() + 240_000).toISOString()),
    textMsg(cwd, 'user', 'continue after midnight', day2.toISOString()),
    textMsg(cwd, 'assistant', 'b1', new Date(day2.getTime() + 60_000).toISOString()),
    textMsg(cwd, 'assistant', 'b2', new Date(day2.getTime() + 120_000).toISOString()),
  ]);
  writeCostFixture(id, 6); // 4 turns : 2 turns -> 4 : 2 split
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5).getTime();
  const days = await scanDays(windowStart, SESSIONS_ROOT);
  const dateA = localDay(day1.toISOString());
  const dateB = localDay(day2.toISOString());
  assert.notEqual(dateA, dateB, 'fixture must actually straddle a day boundary');
  const aggA = days.get(dateA);
  const aggB = days.get(dateB);
  assert.ok(aggA && aggB, 'both days present');
  assert.equal(aggA.metrics.turns, 4);
  assert.equal(aggB.metrics.turns, 2);
  assert.ok(Math.abs(aggA.metrics.costUsd - 4) < 0.01, `day A cost ${aggA.metrics.costUsd}`);
  assert.ok(Math.abs(aggB.metrics.costUsd - 2) < 0.01, `day B cost ${aggB.metrics.costUsd}`);
  assert.ok(aggA.sessions.some((s) => s.id === id), 'session appears in day A');
  assert.ok(aggB.sessions.some((s) => s.id === id), 'session appears in day B');
});

test('ensureHistory: appends only missing dates ascending, and is idempotent on a second run', async () => {
  const cwd = 'C:\\fake\\history-ensure-test';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0);
  const d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 10, 0, 0);
  writeClaudeSession(cwd, 'history-ensure-1', [
    textMsg(cwd, 'user', 'hi', d1.toISOString()),
    textMsg(cwd, 'assistant', 'hello', new Date(d1.getTime() + 1000).toISOString()),
  ]);
  writeClaudeSession(cwd, 'history-ensure-2', [
    textMsg(cwd, 'user', 'hi2', d2.toISOString()),
    textMsg(cwd, 'assistant', 'hello2', new Date(d2.getTime() + 1000).toISOString()),
  ]);
  await ensureHistory({ days: 3, root: SESSIONS_ROOT });
  const dates = readHistory().map((e) => e.date);
  const expected = [localDay(d2.toISOString()), localDay(d1.toISOString())].sort();
  assert.deepEqual(dates.filter((d) => expected.includes(d)), expected, 'both fixture dates present, ascending');

  const before = readHistory().length;
  await ensureHistory({ days: 3, root: SESSIONS_ROOT });
  assert.equal(readHistory().length, before, 'second run appends nothing new');
});

test('readHistory: last-wins when a duplicate date line exists', async () => {
  const { STATE_DIR } = await import('./app-dir.mjs');
  const file = join(STATE_DIR, 'history.jsonl');
  const date = '2020-01-01'; // fixed, well outside every other test's backfill window
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(file, `${JSON.stringify({ date, summary: 'first' })}\n${JSON.stringify({ date, summary: 'second' })}\n`);
  const entries = readHistory().filter((e) => e.date === date);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, 'second');
});

test('ensureHistory: a trivial day (<3 assistant turns) is deterministic, llm.ok:false reason:trivial, no LLM call', async () => {
  const cwd = 'C:\\fake\\history-trivial-test';
  const now = new Date();
  // -3 days: distinct from the -1/-2 day dates the ensureHistory ascending/
  // idempotent test above already persisted (ensureHistory only "misses" a
  // date once — reusing one would just find that test's leftover entry).
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 9, 0, 0);
  writeClaudeSession(cwd, 'history-trivial-fixture', [
    textMsg(cwd, 'user', 'quick question', d1.toISOString()),
    textMsg(cwd, 'assistant', 'quick answer', new Date(d1.getTime() + 1000).toISOString()),
  ]); // 1 assistant turn -> trivial
  let calledAnthropic = false, calledOllama = false;
  await ensureHistory({
    days: 4,
    root: SESSIONS_ROOT,
    callAnthropic: async () => { calledAnthropic = true; return { ok: true, text: '{}' }; },
    callOllama: async () => { calledOllama = true; return '{}'; },
  });
  const entry = readHistory().find((e) => e.date === localDay(d1.toISOString()));
  assert.ok(entry, 'entry written for the trivial day');
  assert.equal(entry.llm.ok, false);
  assert.equal(entry.llm.reason, 'trivial');
  assert.equal(calledAnthropic, false, 'anthropic must not be called for a trivial day');
  assert.equal(calledOllama, false, 'ollama must not be called for a trivial day');
});

test('summarizeDay: 429 falls to the ollama stub, an ollama failure falls to deterministic — each rung valid, never throws', async () => {
  const sessions = [{ id: 's1', title: 'fix flaky test', turns: 5, cwd: 'C:\\fake\\x', project: 'p', source: 'claude' }];

  const r1 = await summarizeDay('digest', sessions, {
    callAnthropic: async () => ({ ok: true, text: JSON.stringify({ summary: 'did X', topics: ['x'] }), model: 'claude-haiku-4-5' }),
  });
  assert.equal(r1.llm.ok, true);
  assert.equal(r1.llm.provider, 'anthropic-oauth');
  assert.equal(r1.summary, 'did X');

  const r2 = await summarizeDay('digest', sessions, {
    callAnthropic: async () => ({ ok: false, status: 429, error: 'rate-limited' }),
    callOllama: async () => JSON.stringify({ summary: 'did Y', topics: ['y'] }),
  });
  assert.equal(r2.llm.ok, true);
  assert.equal(r2.llm.provider, 'ollama');
  assert.equal(r2.summary, 'did Y');

  const r3 = await summarizeDay('digest', sessions, {
    callAnthropic: async () => ({ ok: false, status: 429 }),
    callOllama: async () => { throw new Error('ollama down'); },
  });
  assert.equal(r3.llm.ok, false);
  assert.ok(r3.summary.length > 0, 'deterministic rung still produces a usable summary');
});

test('buildDigest: an oversized day is truncated at the cap and records what was dropped', () => {
  const big = 'x'.repeat(400);
  // cwd is the one thing sessionDigest's header actually emits (per plan:
  // "header line: cwd, harness, turn count" — no title/id) — unique per
  // index so kept-vs-dropped is distinguishable in the assembled text.
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`, title: `session ${i}`, cwd: `C:\\fake\\digest-${i}`, source: 'claude', project: 'p',
    dayTurns: 40 - i, // descending priority — lowest-turn sessions drop first
    userTexts: [big, big, big],
    lastAssistantText: big,
  }));
  const { text, dropped } = buildDigest(sessions);
  assert.ok(text.length <= 48_000, `digest length ${text.length} exceeds the cap`);
  assert.ok(dropped.length > 0, 'some sessions were dropped');
  assert.ok(text.includes('digest-0'), 'the highest-turn session survives');
  assert.ok(!text.includes('digest-39'), 'the lowest-turn session was dropped');
});

test('ensureHistory + liveToday: today is never written to the file', async () => {
  const cwd = 'C:\\fake\\history-today-test';
  const now = new Date();
  writeClaudeSession(cwd, 'history-today-fixture', [
    textMsg(cwd, 'user', 'today work', now.toISOString()),
    textMsg(cwd, 'assistant', 'today done', new Date(now.getTime() + 1000).toISOString()),
    textMsg(cwd, 'assistant', 'today done 2', new Date(now.getTime() + 2000).toISOString()),
    textMsg(cwd, 'assistant', 'today done 3', new Date(now.getTime() + 3000).toISOString()),
  ]); // 3 assistant turns today — well above the trivial threshold
  await ensureHistory({ days: 2, root: SESSIONS_ROOT });
  const today = localDay();
  assert.equal(readHistory().some((e) => e.date === today), false, 'today must never be persisted');
  const live = await liveToday(SESSIONS_ROOT);
  assert.equal(live.date, today);
  assert.equal(live.live, true);
  assert.ok(live.metrics.turns >= 3, 'live today still reflects the same-day activity');
});

test('regenerateDay: atomic rewrite adds exactly one new entry, no duplicates', async () => {
  const cwd = 'C:\\fake\\history-regen-test';
  const now = new Date();
  // -5 days: distinct from every other test's date so this is a genuinely new
  // entry, not a rewrite of one an earlier test already wrote.
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 9, 0, 0);
  writeClaudeSession(cwd, 'history-regen-fixture', [
    textMsg(cwd, 'user', 'q', d1.toISOString()),
    textMsg(cwd, 'assistant', 'a', new Date(d1.getTime() + 1000).toISOString()),
  ]); // trivial — regenerateDay must not need LLM stubs to produce an entry
  const date = localDay(d1.toISOString());
  const before = readHistory().length;
  const entry = await regenerateDay(date, { root: SESSIONS_ROOT });
  assert.equal(entry.date, date);
  assert.equal(readHistory().length, before + 1, 'exactly one new entry, no duplicates');
  assert.equal(readHistory().filter((e) => e.date === date).length, 1);
});

test('ensureHistory: a gap day is written once as an empty entry, not re-appended, and upgrades when work appears', async () => {
  const { STATE_DIR } = await import('./app-dir.mjs');
  const rawDateLines = (d) => readFileSync(join(STATE_DIR, 'history.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).filter((l) => JSON.parse(l).date === d);
  const cwd = 'C:\\fake\\history-gap-test';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 9, 0, 0);
  const date = localDay(d1.toISOString());

  await ensureHistory({ days: 7, root: SESSIONS_ROOT });
  const gap = readHistory().find((e) => e.date === date);
  assert.ok(gap, 'a gap day still gets an entry, so it drains out of `pending`');
  assert.equal(gap.llm.reason, 'empty');
  assert.equal(gap.metrics.sessions, 0);

  await ensureHistory({ days: 7, root: SESSIONS_ROOT });
  assert.equal(rawDateLines(date).length, 1, 'still empty — no second empty line appended');

  writeClaudeSession(cwd, 'history-gap-fixture', [
    textMsg(cwd, 'user', 'late arrival', d1.toISOString()),
    textMsg(cwd, 'assistant', 'done', new Date(d1.getTime() + 1000).toISOString()),
  ]);
  await ensureHistory({ days: 7, root: SESSIONS_ROOT });
  assert.equal(readHistory().find((e) => e.date === date).llm.reason, 'trivial', 'empty entry upgrades once work exists');
});

test('ensureHistory: two concurrent calls share one pass — one LLM call and one line per date', async () => {
  const { STATE_DIR } = await import('./app-dir.mjs');
  const rawDateLines = (d) => readFileSync(join(STATE_DIR, 'history.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).filter((l) => JSON.parse(l).date === d);
  const cwd = 'C:\\fake\\history-concurrent-test';
  const now = new Date();
  // -9 days: every offset through -7 is already on disk (the gap-day test's
  // days:7 run wrote all of -1..-7), so a fresh date must sit outside that.
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 9, 9, 0, 0);
  const date = localDay(d1.toISOString());
  writeClaudeSession(cwd, 'history-concurrent-fixture', [
    textMsg(cwd, 'user', 'concurrent work', d1.toISOString()),
    textMsg(cwd, 'assistant', 'c1', new Date(d1.getTime() + 1000).toISOString()),
    textMsg(cwd, 'assistant', 'c2', new Date(d1.getTime() + 2000).toISOString()),
    textMsg(cwd, 'assistant', 'c3', new Date(d1.getTime() + 3000).toISOString()),
  ]); // 3 assistant turns — above the trivial gate, so it does reach the LLM

  let calls = 0;
  const opts = {
    days: 9,
    root: SESSIONS_ROOT,
    callAnthropic: async () => { calls++; return { ok: true, text: JSON.stringify({ summary: 'concurrent day', topics: ['t'] }) }; },
  };
  await Promise.all([ensureHistory(opts), ensureHistory(opts)]);

  assert.equal(calls, 1, 'the non-trivial day is summarized exactly once, not once per caller');
  // Line count, not readHistory().length — the reader is last-wins, so a
  // duplicated append would pass a readHistory-only assertion either way.
  assert.equal(rawDateLines(date).length, 1, 'exactly one line appended for the date');
  assert.equal(readHistory().find((e) => e.date === date).summary, 'concurrent day');
});
