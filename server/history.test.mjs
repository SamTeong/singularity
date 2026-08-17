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
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
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
    callAnthropic: async () => ({ ok: true, text: JSON.stringify({ projects: [{ path: 'C:\\fake\\x', bullets: ['did X'] }], topics: ['x'] }), model: 'claude-haiku-4-5' }),
  });
  assert.equal(r1.llm.ok, true);
  assert.equal(r1.llm.provider, 'anthropic-oauth');
  assert.deepEqual(r1.projects, [{ path: 'C:\\fake\\x', bullets: ['did X'] }]);

  const r2 = await summarizeDay('digest', sessions, {
    callAnthropic: async () => ({ ok: false, status: 429, error: 'rate-limited' }),
    callOllama: async () => JSON.stringify({ projects: [{ path: 'C:\\fake\\x', bullets: ['did Y', 'and Z', 'and W', 'over cap'] }], topics: ['y'] }),
  });
  assert.equal(r2.llm.ok, true);
  assert.equal(r2.llm.provider, 'ollama');
  assert.deepEqual(r2.projects[0].bullets, ['did Y', 'and Z', 'and W'], 'capped at 3 bullets per project');

  const r3 = await summarizeDay('digest', sessions, {
    callAnthropic: async () => ({ ok: false, status: 429 }),
    callOllama: async () => { throw new Error('ollama down'); },
  });
  assert.equal(r3.llm.ok, false);
  assert.deepEqual(r3.projects, [{ path: 'C:\\fake\\x', bullets: ['fix flaky test'] }], 'deterministic rung still produces per-project bullets');
});

test('noise rows (subagent system prompts, caveat blocks) stay out of the digest and the session list, but still count in metrics', async () => {
  const cwd = 'C:\\fake\\history-noise-test';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 11, 9, 0, 0);
  const at = (ms) => new Date(d1.getTime() + ms).toISOString();
  writeClaudeSession(cwd, 'history-noise-real', [
    textMsg(cwd, 'user', 'add the retry cap', at(0)),
    textMsg(cwd, 'assistant', 'a1', at(1000)),
    textMsg(cwd, 'assistant', 'a2', at(2000)),
    textMsg(cwd, 'assistant', 'a3', at(3000)),
  ]);
  writeClaudeSession(cwd, 'history-noise-reviewer', [
    textMsg(cwd, 'user', 'You are an adversarial code reviewer. Review ONLY the unified diff below.', at(4000)),
    textMsg(cwd, 'assistant', 'r1', at(5000)),
  ]);
  writeClaudeSession(cwd, 'history-noise-caveat', [
    textMsg(cwd, 'user', '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.', at(6000)),
    textMsg(cwd, 'assistant', 'c1', at(7000)),
  ]);

  // regenerateDay, not ensureHistory: it builds this one date only, so the
  // wide backfill window a -11 fixture would need can't write empty entries
  // for dates other tests own.
  let digest = '';
  const entry = await regenerateDay(localDay(d1.toISOString()), {
    root: SESSIONS_ROOT,
    callAnthropic: async (text) => {
      digest = text;
      return { ok: true, text: JSON.stringify({ projects: [{ path: cwd, bullets: ['added the retry cap'] }], topics: ['t'] }) };
    },
  });

  assert.ok(!digest.includes('adversarial code reviewer'), 'reviewer prompt kept out of the digest');
  assert.ok(!digest.includes('local-command-caveat'), 'caveat block kept out of the digest');
  assert.deepEqual(entry.sessions.map((s) => s.id), ['history-noise-real'], 'only the real session is listed');
  assert.equal(entry.metrics.sessions, 3, 'metrics still count the noise sessions — their spend was real');
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

test('buildDigest: a session that would drop is compressed (recap + last assistant) instead when it has a recap', () => {
  const big = 'x'.repeat(400);
  // 12 big userTexts per session makes the full block much larger than the
  // compressed form (recap + last assistant), so compressed tail sessions fit
  // where their full form would not — the reduction this test asserts on.
  const make = (recap) => Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`, title: `session ${i}`, cwd: `C:\\fake\\recap-${i}`, source: 'claude', project: 'p',
    dayTurns: 40 - i,
    userTexts: Array.from({ length: 12 }, () => big),
    lastAssistantText: big,
    ...(recap && { recapText: 'recap of earlier work' }),
  }));
  const without = buildDigest(make(false));
  const withRecap = buildDigest(make(true));
  assert.ok(without.dropped.length > 0, 'baseline drops some sessions');
  assert.ok(withRecap.dropped.length < without.dropped.length, `recap compression should reduce drops (got ${withRecap.dropped.length} vs ${without.dropped.length})`);
  assert.ok(withRecap.text.length <= 48_000, 'compressed digest still respects the cap');
  assert.ok(withRecap.text.includes('[recap]'), 'the recap line is emitted for compressed sessions');
});

test('buildDigest: a giant recap session whose full block alone exceeds the cap is compressed in place, not kept full', () => {
  const big = 'x'.repeat(400);
  // One giant (highest-turn) recap session whose full block dwarfs the cap,
  // plus many small sessions that should fit once the giant is compressed.
  const giant = {
    id: 'giant', title: 'giant recap session', cwd: 'C:\\fake\\giant', source: 'claude', project: 'p',
    dayTurns: 100,
    userTexts: Array.from({ length: 200 }, () => big), // ~80k of user text — far over the 48k cap
    lastAssistantText: big,
    recapText: 'recap of the giant session',
  };
  const small = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`, title: `small ${i}`, cwd: `C:\\fake\\small-${i}`, source: 'claude', project: 'p',
    dayTurns: 90 - i,
    userTexts: [big], lastAssistantText: big,
  }));
  const { text, dropped } = buildDigest([giant, ...small]);
  assert.ok(text.length <= 48_000, `digest length ${text.length} exceeds the cap`);
  assert.ok(text.includes('[recap]'), 'the giant is compressed (recap emitted), not kept full');
  assert.ok(!text.includes('[user] '.repeat(2)), 'no full user-prompt dump from the giant survives');
  assert.ok(dropped.length < small.length, `most small sessions fit once the giant is compressed (dropped ${dropped.length} of ${small.length})`);
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

test('scanDays: readSession is cached by (mtime,size) — an unchanged file is not re-parsed, a touched/grown one is', async () => {
  const cwd = 'C:\\fake\\history-cache-test';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13, 9, 0, 0);
  const at = (ms) => new Date(d1.getTime() + ms).toISOString();
  const id = 'history-cache-fixture';
  const dir = join(SESSIONS_ROOT, encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);

  const original = [
    textMsg(cwd, 'user', 'q', at(0)),
    textMsg(cwd, 'assistant', 'a1', at(1000)),
    textMsg(cwd, 'assistant', 'a2', at(2000)),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(file, original);
  // Pin the mtime to a whole second before the first read. The cache compares
  // mtimeMs floats exactly, and a fractional Unix-second round-trip through
  // utimesSync doesn't land back on the same float — a whole second does, so
  // the restore below is exact and the staleness assertion isn't luck.
  const mtimeSec = Math.floor(Date.now() / 1000);
  utimesSync(file, mtimeSec, mtimeSec);
  const st1 = statSync(file);

  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20).getTime();
  const dateStr = localDay(d1.toISOString());
  const before = await scanDays(windowStart, SESSIONS_ROOT);
  assert.equal(before.get(dateStr).sessions.find((s) => s.id === id).lastAssistantText, 'a2');

  // Same byte length ('a2' -> 'zz'), mtime forced back to the original — a
  // real cache must key on (mtime,size) and serve the old parse rather than
  // re-reading, so this proves the second call did NOT re-parse.
  const tampered = original.replace('"a2"', '"zz"');
  assert.equal(tampered.length, original.length, 'tamper must be size-preserving to test the cache key');
  writeFileSync(file, tampered);
  utimesSync(file, mtimeSec, mtimeSec);
  assert.equal(statSync(file).mtimeMs, st1.mtimeMs, 'mtime restore must be exact for this to test the cache');

  const stale = await scanDays(windowStart, SESSIONS_ROOT);
  assert.equal(stale.get(dateStr).sessions.find((s) => s.id === id).lastAssistantText, 'a2', 'unchanged (mtime,size) served the cached parse, not the tampered content');

  // Actually touch it (append -> size grows, mtime advances): must invalidate.
  appendFileSync(file, `${JSON.stringify(textMsg(cwd, 'assistant', 'a3', at(3000)))}\n`);
  const fresh = await scanDays(windowStart, SESSIONS_ROOT);
  assert.equal(fresh.get(dateStr).sessions.find((s) => s.id === id).lastAssistantText, 'a3', 'a grown/touched file re-parses');
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
    callAnthropic: async () => { calls++; return { ok: true, text: JSON.stringify({ projects: [{ path: cwd, bullets: ['concurrent day'] }], topics: ['t'] }) }; },
  };
  await Promise.all([ensureHistory(opts), ensureHistory(opts)]);

  assert.equal(calls, 1, 'the non-trivial day is summarized exactly once, not once per caller');
  // Line count, not readHistory().length — the reader is last-wins, so a
  // duplicated append would pass a readHistory-only assertion either way.
  assert.equal(rawDateLines(date).length, 1, 'exactly one line appended for the date');
  assert.deepEqual(readHistory().find((e) => e.date === date).projects[0].bullets, ['concurrent day']);
});

test('scanDays: cache key includes root — same session id under different roots must not serve each other', async () => {
  const cwd = 'C:\\fake\\history-root-isolation-test';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 11, 9, 0, 0);
  const id = 'history-root-isolation-fixture';
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20).getTime();
  const dateStr = localDay(d1.toISOString());

  // Write the same session id to two different roots with different content
  const root1 = join(scratch, 'root1-projects');
  const root2 = join(scratch, 'root2-projects');

  writeClaudeSession(cwd, id, [
    textMsg(cwd, 'user', 'from root1', d1.toISOString()),
    textMsg(cwd, 'assistant', 'response1', new Date(d1.getTime() + 1000).toISOString()),
  ]);
  const sessions1Dir = join(root1, encodeCwd(cwd));
  mkdirSync(sessions1Dir, { recursive: true });
  const sessions1File = join(sessions1Dir, `${id}.jsonl`);
  writeFileSync(sessions1File, [
    textMsg(cwd, 'user', 'from root1', d1.toISOString()),
    textMsg(cwd, 'assistant', 'response1', new Date(d1.getTime() + 1000).toISOString()),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const sessions2Dir = join(root2, encodeCwd(cwd));
  mkdirSync(sessions2Dir, { recursive: true });
  const sessions2File = join(sessions2Dir, `${id}.jsonl`);
  writeFileSync(sessions2File, [
    textMsg(cwd, 'user', 'from root2', d1.toISOString()),
    textMsg(cwd, 'assistant', 'response2', new Date(d1.getTime() + 1000).toISOString()),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const days1 = await scanDays(windowStart, root1);
  const session1 = days1.get(dateStr)?.sessions.find((s) => s.id === id);
  assert.equal(session1?.lastAssistantText, 'response1', 'root1 returns response1');

  const days2 = await scanDays(windowStart, root2);
  const session2 = days2.get(dateStr)?.sessions.find((s) => s.id === id);
  assert.equal(session2?.lastAssistantText, 'response2', 'root2 returns response2, not the cached response1');
});
