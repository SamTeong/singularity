// Daily work timeline: scans the claude + codex transcripts already known to
// sessions.mjs, buckets their messages into machine-local calendar days, and
// produces one LLM-summarized entry per day, persisted to
// STATE_DIR/history.jsonl (append-only, last line per date wins on read — see
// readHistory). Today is always computed live (never persisted) — a session
// still in progress has no "closing" message to summarize yet.
//
// Harness transcripts only — no git log, no project folders (see plan.md).
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { STATE_DIR, bus, writeAtomic, OLLAMA_BIN } from './agents.mjs';
import { listSessions, readSession } from './sessions.mjs';
import { parseSession, readCostFile } from './stats.mjs';
import { callMessages } from './chat.mjs';
import { OLLAMA_PRESETS } from './models.mjs';

const execFileP = promisify(execFile);

const HISTORY_FILE = join(STATE_DIR, 'history.jsonl');
const BACKFILL_DAYS = 7;
const TRIVIAL_TURNS = 3;            // day total below this: skip the LLM, deterministic one-liner
const USER_TRUNC = 400;
const ASSISTANT_TRUNC = 800;
const DIGEST_CAP = 48_000;          // assembled per-day digest hard cap (chars)
const OLLAMA_MODEL = OLLAMA_PRESETS[0]; // 'glm-5.2:cloud'
const OLLAMA_TIMEOUT_MS = 120_000;
const OLLAMA_MAX_BUFFER = 8 * 1024 * 1024;

const SUMMARY_SYSTEM = 'Summarize one day of coding-agent transcripts into strict JSON {"summary":string,"topics":string[]}. summary: 1-2 sentences, past tense, concrete (what shipped/fixed), no meta-commentary. topics: 2-5 short lowercase kebab-case tags. Output JSON only — no prose, no markdown fence.';

// Machine-local YYYY-MM-DD — no manual TZ math (per plan). Defaults to now.
export function localDay(ts) {
  return (ts ? new Date(ts) : new Date()).toLocaleDateString('en-CA');
}
function startOfLocalDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function trunc(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }
function repoName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || null;
}

// ---- Reader / writer -------------------------------------------------------

// Parse every line; the last line wins per date — so an appended regenerate
// still reads correctly, and a file half-written at crash time degrades to
// "the older summary for that date wins" rather than corruption.
export function readHistory() {
  let text;
  try { text = readFileSync(HISTORY_FILE, 'utf8'); } catch { return []; }
  const byDate = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.date) byDate.set(e.date, e);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function appendEntry(entry) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
}

// Serializes every write (backfill append + regenerate's atomic rewrite)
// through one promise chain so boot backfill and a manual regenerate can never
// interleave and corrupt each other's write.
let writeChain = Promise.resolve();
function enqueueWrite(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {}); // keep the chain alive even if this write rejected
  return next;
}

// ---- Day scan ---------------------------------------------------------------

// One pass over every session touched since windowStart: bucket its messages
// by local day, per session per day. Returns Map<date, {sessions, metrics}>.
// A session crossing midnight lands in both days' buckets. `root` overrides
// the sessions root (sessions.mjs's client-selectable root, default
// ~/.claude/projects) — used by tests to scan an isolated fixture tree instead
// of the real one; production callers never pass it.
export async function scanDays(windowStart, root) {
  const rows = (await listSessions({ cap: 5000, root })).filter((r) => r.mtime >= windowStart);
  const days = new Map();

  for (const row of rows) {
    const s = await readSession(row.project, row.id, root, row.source, row.file);
    if (!s.ok) continue;

    // "Assistant turn" = one role:'assistant' kind:'text' message — the
    // user-visible output of a turn. Thinking/toolUse blocks aren't turns.
    // One consistent definition feeds the trivial-day gate, the cost/token
    // proration share below, and the digest's per-day turn count.
    const byDay = new Map(); // date -> { userTexts, lastAssistantText, turns }
    let sessionTurns = 0;
    for (const m of s.messages) {
      const date = localDay(m.ts ?? row.mtime);
      let b = byDay.get(date);
      if (!b) byDay.set(date, (b = { userTexts: [], lastAssistantText: null, turns: 0 }));
      if (m.role === 'user' && m.kind === 'text') b.userTexts.push(m.text);
      else if (m.role === 'assistant' && m.kind === 'text') { b.lastAssistantText = m.text; b.turns++; sessionTurns++; }
    }
    if (byDay.size === 0) continue; // no user/assistant text at all

    const cost = readCostFile(row.id).costUsd;
    const parsed = await parseSession(row.cwd, row.id, row.source === 'codex' ? 'codex' : undefined);
    const tokens = parsed.exists ? parsed.tokens : 0;

    for (const [date, b] of byDay) {
      let day = days.get(date);
      if (!day) days.set(date, (day = { sessions: [], metrics: { sessions: 0, turns: 0, tokens: 0, costUsd: 0, byHarness: {} } }));
      // ponytail: readCostFile/parseSession are whole-session — cost and
      // tokens can't be split per message, so prorate by this day's share of
      // the session's assistant turns (0 share when the session has none).
      const share = sessionTurns > 0 ? b.turns / sessionTurns : 0;
      day.sessions.push({
        id: row.id, project: row.project, cwd: row.cwd, source: row.source || 'claude',
        title: row.title, turns: sessionTurns, dayTurns: b.turns,
        userTexts: b.userTexts, lastAssistantText: b.lastAssistantText,
      });
      day.metrics.sessions++;
      day.metrics.turns += b.turns;
      day.metrics.tokens += Math.round(tokens * share);
      day.metrics.costUsd += (cost ?? 0) * share;
      const harness = row.source || 'claude';
      const hs = day.metrics.byHarness[harness] || (day.metrics.byHarness[harness] = { sessions: 0, turns: 0 });
      hs.sessions++; hs.turns += b.turns;
    }
  }
  return days;
}
function emptyDayAgg() { return { sessions: [], metrics: { sessions: 0, turns: 0, tokens: 0, costUsd: 0, byHarness: {} } }; }

// ---- Digest: user prompts + assistant closing message, per session --------
// sessionText() (sessions.mjs) is NOT reusable here — it emits everything
// including tool traffic; the LLM only wants the human-readable narrative.
function sessionDigest(sess) {
  const lines = [`## ${sess.cwd || sess.project} (${sess.source}, ${sess.dayTurns} turns)`];
  for (const t of sess.userTexts) lines.push(`[user] ${trunc(t, USER_TRUNC)}`);
  if (sess.lastAssistantText) lines.push(`[assistant] ${trunc(sess.lastAssistantText, ASSISTANT_TRUNC)}`);
  return lines.join('\n');
}

// Assembles the full day's digest, hard-capped at DIGEST_CAP chars — drops the
// lowest-turn sessions first when over, recording what got dropped.
export function buildDigest(sessions) {
  const ordered = [...sessions].sort((a, b) => b.dayTurns - a.dayTurns);
  const kept = [];
  const dropped = [];
  let total = 0;
  for (const sess of ordered) {
    const block = sessionDigest(sess);
    if (total + block.length > DIGEST_CAP && kept.length > 0) { dropped.push(sess.title || sess.id); continue; }
    kept.push(block);
    total += block.length;
  }
  return { text: kept.join('\n\n'), dropped };
}

// ---- Summarizer + fallback chain: anthropic -> ollama -> deterministic ----

function parseJsonSummary(text) {
  const m = typeof text === 'string' && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return typeof o.summary === 'string'
      ? { summary: o.summary, topics: Array.isArray(o.topics) ? o.topics.slice(0, 5).map(String) : [] }
      : null;
  } catch { return null; }
}

function deterministicSummary(sessions) {
  const repos = [...new Set(sessions.map((s) => repoName(s.cwd || s.project)).filter(Boolean))];
  const titled = [...sessions].sort((a, b) => b.turns - a.turns).slice(0, 3).map((s) => s.title || s.id).filter(Boolean);
  const summary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} across ${repos.join(', ') || 'unknown repos'}${titled.length ? `: ${titled.join('; ')}` : ''}`;
  return { summary, topics: [] };
}

async function defaultCallAnthropic(digestText) {
  return callMessages({ system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: digestText }], maxTokens: 400 });
}
async function defaultCallOllama(digestText) {
  const { stdout } = await execFileP(OLLAMA_BIN, ['run', OLLAMA_MODEL, `${SUMMARY_SYSTEM}\n\n${digestText}`], { maxBuffer: OLLAMA_MAX_BUFFER, timeout: OLLAMA_TIMEOUT_MS });
  return stdout;
}

// callAnthropic/callOllama are injectable — tests stub them so no network call
// ever happens. Each rung must produce a valid entry and never throw.
export async function summarizeDay(digestText, sessions, { callAnthropic = defaultCallAnthropic, callOllama = defaultCallOllama } = {}) {
  const a = await callAnthropic(digestText).catch((e) => ({ ok: false, error: e.message }));
  const parsedA = a?.ok ? parseJsonSummary(a.text) : null;
  if (parsedA) return { ...parsedA, llm: { ok: true, provider: 'anthropic-oauth', model: a.model || null, inputTokens: a.inputTokens ?? null, outputTokens: a.outputTokens ?? null } };

  if (OLLAMA_BIN) {
    let stdout = null;
    try { stdout = await callOllama(digestText); } catch { stdout = null; }
    const parsedO = parseJsonSummary(stdout);
    if (parsedO) return { ...parsedO, llm: { ok: true, provider: 'ollama', model: OLLAMA_MODEL, inputTokens: null, outputTokens: null } };
  }

  return { ...deterministicSummary(sessions), llm: { ok: false, provider: null, model: null, reason: 'unavailable' } };
}

// ---- Entry assembly ---------------------------------------------------------

async function buildDayEntry(date, dayAgg, deps) {
  const sessions = dayAgg.sessions;
  const metrics = { ...dayAgg.metrics, costUsd: Math.round(dayAgg.metrics.costUsd * 100) / 100 };
  const repos = [...new Set(sessions.map((s) => repoName(s.cwd || s.project)).filter(Boolean))];

  let result;
  if (sessions.length === 0) {
    // Gap day: no work at all. Still written as an entry so it stops showing as
    // pending forever and the page can render absence explicitly.
    result = { summary: '', topics: [], llm: { ok: false, provider: null, model: null, reason: 'empty' } };
  } else if (metrics.turns < TRIVIAL_TURNS) {
    result = { ...deterministicSummary(sessions), llm: { ok: false, provider: null, model: null, reason: 'trivial' } };
  } else {
    const { text: digestText, dropped } = buildDigest(sessions);
    result = await summarizeDay(digestText, sessions, deps);
    if (dropped.length) result = { ...result, llm: { ...result.llm, dropped } };
  }

  return {
    date,
    summary: result.summary,
    topics: result.topics || [],
    repos,
    sessions: sessions.map((s) => ({ id: s.id, project: s.project, cwd: s.cwd, source: s.source, title: s.title, turns: s.turns })),
    metrics,
    llm: result.llm,
    builtAt: new Date().toISOString(),
  };
}

// ---- Backfill ---------------------------------------------------------------

// Diffs wanted days (yesterday back `days`) against what's already on disk,
// summarizes the missing ones oldest -> newest, sequentially (one LLM call in
// flight), appending + emitting after each so the UI can fill in progressively.
// Today is never included — it's always computed live by liveToday()/GET
// /history. A day with zero sessions is written too, as an empty entry, so it
// resolves out of `pending` instead of shimmering forever; an empty entry stays
// re-checkable (rescanned, never re-appended while still empty) so a day that
// does turn out to have work gets upgraded on a later call.
export async function ensureHistory({ days = BACKFILL_DAYS, callAnthropic, callOllama, root } = {}) {
  const today = localDay();
  const wanted = [];
  for (let i = 1; i <= days; i++) wanted.push(localDay(Date.now() - i * 86_400_000));
  wanted.sort();

  const prior = new Map(readHistory().map((e) => [e.date, e]));
  const missing = wanted.filter((d) => d !== today && (!prior.has(d) || prior.get(d).llm?.reason === 'empty'));
  if (!missing.length) return { built: [] };

  const windowStart = startOfLocalDay(new Date(Date.now() - days * 86_400_000)).getTime();
  const scanned = await scanDays(windowStart, root);
  const built = [];
  let pending = missing.filter((d) => !prior.has(d)); // already-empty days aren't "pending" for the UI
  for (const date of missing) {
    const agg = scanned.get(date);
    if (!agg && prior.has(date)) continue; // still empty, and already on disk — no second empty line
    const entry = await buildDayEntry(date, agg || emptyDayAgg(), { callAnthropic, callOllama });
    await enqueueWrite(() => appendEntry(entry));
    built.push(entry);
    pending = pending.filter((d) => d !== date);
    bus.emit('history', { entries: readHistory(), pending });
  }
  return { built };
}

// ---- Regenerate: atomic rewrite of the whole file --------------------------
export async function regenerateDay(date, { callAnthropic, callOllama, root } = {}) {
  const windowStart = startOfLocalDay(new Date(`${date}T00:00:00`)).getTime();
  const scanned = await scanDays(windowStart, root);
  const entry = await buildDayEntry(date, scanned.get(date) || emptyDayAgg(), { callAnthropic, callOllama });
  return enqueueWrite(() => {
    const all = readHistory().filter((e) => e.date !== date);
    all.push(entry);
    all.sort((a, b) => a.date.localeCompare(b.date));
    writeAtomic(HISTORY_FILE, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);
    bus.emit('history', { entries: readHistory(), pending: [] });
    return entry;
  });
}

// ---- Today: computed live, never persisted ---------------------------------
export async function liveToday(root) {
  const date = localDay();
  const windowStart = startOfLocalDay(new Date()).getTime();
  const scanned = await scanDays(windowStart, root);
  const agg = scanned.get(date) || emptyDayAgg();
  const repos = [...new Set(agg.sessions.map((s) => repoName(s.cwd || s.project)).filter(Boolean))];
  return {
    date, live: true,
    repos,
    sessions: agg.sessions.map((s) => ({ id: s.id, project: s.project, cwd: s.cwd, source: s.source, title: s.title, turns: s.turns })),
    metrics: { ...agg.metrics, costUsd: Math.round(agg.metrics.costUsd * 100) / 100 },
  };
}
