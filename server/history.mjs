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
import { parseSession, readCostFile, readStatsCsvCosts } from './stats.mjs';
import { callMessages } from './chat.mjs';
import { getSummariserModel } from './model-store.mjs';

const execFileP = promisify(execFile);

const HISTORY_FILE = join(STATE_DIR, 'history.jsonl');
const BACKFILL_DAYS = 7;
const TRIVIAL_TURNS = 3;            // day total below this: skip the LLM, deterministic one-liner
const USER_TRUNC = 400;
const ASSISTANT_TRUNC = 800;
const BULLET_TRUNC = 120;           // one card line — longer just wraps into a wall of text
const DIGEST_CAP = 48_000;          // assembled per-day digest hard cap (chars)
const OLLAMA_TIMEOUT_MS = 120_000;
const OLLAMA_MAX_BUFFER = 8 * 1024 * 1024;

// Bullets are read at a glance by someone who is not in the code — so the
// prompt bans the jargon and comma-stacked clauses an agent transcript is full
// of, and caps each bullet well under BULLET_TRUNC so nothing ships truncated.
const SUMMARY_SYSTEM = 'Summarize one day of coding-agent transcripts into strict JSON {"projects":[{"path":string,"bullets":string[]}],"topics":string[]}. One projects entry per distinct "## <path>" header in the input, path copied verbatim (several blocks may share a path — merge them). Order each project\'s bullets by how much work went into them: the input blocks arrive highest-effort first (each header carries its turn and token count), so keep that order. topics: 2-5 short lowercase kebab-case tags for the whole day. Output JSON only — no prose, no markdown fence.\n'
  + 'bullets: 1-3 per project, written for a clever reader who has never seen this codebase. Every bullet follows all of these:\n'
  + '1. Under 12 words. One idea. A second idea becomes its own bullet or gets dropped.\n'
  + '2. Plain past tense, active voice, no trailing period.\n'
  + '3. Say what changed and what it now does for the person using it. Leave out how it was built: no file names, class or function names, flags, library names, test counts, error codes.\n'
  + '4. Use the everyday word: "page" over "view component", "saves as you type" over "implemented autosave handler", "loads faster" over "reduced latency".\n'
  + '5. No comma-stacked lists, no semicolons, no "and also".\n'
  + '6. No hype: drop "leveraged", "robust", "comprehensive", "seamless", "streamlined", "significantly". No sentence built on a contrast with what it is not.\n'
  + '7. Nothing about the session, the agent, the transcript, or this summary.\n'
  + 'Good: "history page now opens without a wait". Bad: "implemented concurrent ensureHistory deduplication via shared in-flight promise".';

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
// One-line stand-in when a session has no ai-title: its first prompt, flattened.
const blurbOf = (texts) => { const t = (texts || []).find((x) => x && x.trim()); return t ? t.replace(/\s+/g, ' ').trim().slice(0, 140) : null; };

// A bullet is one line on a card: flattened and capped, so a session whose
// "title" is an entire injected prompt can't blow the card open.
const bullet = (s) => trunc(String(s).replace(/\s+/g, ' ').trim(), BULLET_TRUNC);

// Effort proxy for ordering: tokens burned on the day's share of the session,
// turns as the tiebreak when no token log exists.
const effortOf = (s) => (s.dayTokens || 0) * 1000 + (s.dayTurns ?? s.turns ?? 0);

// Rows whose opening message is machinery, not work: a spawned subagent's own
// system prompt, or a harness-injected caveat block. Dropped from the digest,
// the bullets and the session list — metrics still count them, since their
// turns and spend were real.
const NOISE_PREFIXES = [
  /^you are an adversarial code reviewer/i,
  /^<local-command-caveat>/i,
  /^the following is the codex agent history/i, // codex approval-gate judge runs
];
const isNoiseSession = (s) => {
  const text = (s.title || blurbOf(s.userTexts) || '').trim();
  return NOISE_PREFIXES.some((re) => re.test(text));
};

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
// readSession does a full JSONL parse; scanDays calls it once per session in
// the window on every /api/history request, re-parsing transcripts that
// haven't changed since the last call. Cached by (mtime,size) like sessions.mjs's
// own textCache/metaCache — transcripts are append-only, so an unchanged
// (mtime,size) means the old parse is still correct. listSessions already
// stat'd each row (row.mtime/row.size), so this reuses that instead of a
// second statSync; keyed by (source,id) since that pair is one file.
const sessionCache = new Map(); // "root:source:id" -> { mtimeMs, size, result }
async function readSessionCached(row, root) {
  const key = `${root}:${row.source || 'claude'}:${row.id}`;
  const hit = sessionCache.get(key);
  if (hit && hit.mtimeMs === row.mtime && hit.size === row.size) {
    sessionCache.delete(key);
    sessionCache.set(key, hit); // LRU: move hit to end
    return hit.result;
  }
  const result = await readSession(row.project, row.id, root, row.source, row.file);
  sessionCache.set(key, { mtimeMs: row.mtime, size: row.size, result });
  if (sessionCache.size > 200) sessionCache.delete(sessionCache.keys().next().value); // evict oldest
  return result;
}

export async function scanDays(windowStart, root) {
  const rows = (await listSessions({ cap: 5000, root })).filter((r) => r.mtime >= windowStart);
  const statsCsvCosts = readStatsCsvCosts(); // one read per scan (cached on mtime/size)
  const days = new Map();

  for (const row of rows) {
    const s = await readSessionCached(row, root);
    if (!s.ok) continue;

    // "Assistant turn" = one role:'assistant' kind:'text' message — the
    // user-visible output of a turn. Thinking/toolUse blocks aren't turns.
    // One consistent definition feeds the trivial-day gate, the cost/token
    // proration share below, and the digest's per-day turn count.
    const byDay = new Map(); // date -> { userTexts, lastAssistantText, recapText, turns }
    let sessionTurns = 0;
    for (const m of s.messages) {
      const date = localDay(m.ts ?? row.mtime);
      let b = byDay.get(date);
      if (!b) byDay.set(date, (b = { userTexts: [], lastAssistantText: null, recapText: null, turns: 0 }));
      if (m.role === 'user' && m.kind === 'text') {
        // Recap (compaction summary) is kept separate from real prompts so the
        // digest can compress long sessions to [recap] + last assistant; a
        // session compacted multiple times keeps the latest recap (last wins).
        if (m.recap) b.recapText = m.text; else b.userTexts.push(m.text);
      }
      else if (m.role === 'assistant' && m.kind === 'text') { b.lastAssistantText = m.text; b.turns++; sessionTurns++; }
    }
    if (byDay.size === 0) continue; // no user/assistant text at all

    // Some transcript rows carry no cwd; parseSession would hand null to
    // encodeCwd (or findCodexRolloutForCwd) and throw, 500ing the whole route.
    // No cwd means no path to a token log — count the day, skip the tokens.
    const parsed = row.cwd
      ? await parseSession(row.cwd, row.id, row.source === 'codex' ? 'codex' : undefined)
      : { exists: false, tokens: 0 };
    const tokens = parsed.exists ? parsed.tokens : 0;
    // Cost resolution (most → least authoritative): the stats.csv append log
    // (complete, survives cost-state resets), the live cost-state file, then
    // the pricing-table estimate. Mirrors statsFor in stats.mjs.
    const cost = statsCsvCosts.get(row.id) ?? readCostFile(row.id).costUsd ?? parsed.estCostUsd ?? null;

    for (const [date, b] of byDay) {
      let day = days.get(date);
      if (!day) days.set(date, (day = { sessions: [], metrics: { sessions: 0, turns: 0, tokens: 0, costUsd: 0, byHarness: {} } }));
      // ponytail: readCostFile/parseSession are whole-session — cost and
      // tokens can't be split per message, so prorate by this day's share of
      // the session's assistant turns (0 share when the session has none).
      const share = sessionTurns > 0 ? b.turns / sessionTurns : 0;
      day.sessions.push({
        id: row.id, project: row.project, cwd: row.cwd, source: row.source || 'claude',
        title: row.title, turns: sessionTurns, dayTurns: b.turns, dayTokens: Math.round(tokens * share),
        userTexts: b.userTexts, lastAssistantText: b.lastAssistantText, recapText: b.recapText,
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
  const lines = [`## ${sess.cwd || sess.project} (${sess.source}, ${sess.dayTurns} turns, ${sess.dayTokens || 0} tokens)`];
  if (sess.recapText) lines.push(`[recap] ${trunc(sess.recapText, USER_TRUNC)}`);
  for (const t of sess.userTexts) lines.push(`[user] ${trunc(t, USER_TRUNC)}`);
  if (sess.lastAssistantText) lines.push(`[assistant] ${trunc(sess.lastAssistantText, ASSISTANT_TRUNC)}`);
  return lines.join('\n');
}

// Compressed form for long sessions that would otherwise be dropped: recap
// (covers everything before the last compaction) + last assistant only. The
// intermediate [user] prompts are the part the recap already summarizes, so
// dropping them loses the least information per char saved.
function compressedDigest(sess) {
  const lines = [`## ${sess.cwd || sess.project} (${sess.source}, ${sess.dayTurns} turns, ${sess.dayTokens || 0} tokens — compressed)`];
  lines.push(`[recap] ${trunc(sess.recapText, USER_TRUNC)}`);
  if (sess.lastAssistantText) lines.push(`[assistant] ${trunc(sess.lastAssistantText, ASSISTANT_TRUNC)}`);
  return lines.join('\n');
}

// Assembles the full day's digest, hard-capped at DIGEST_CAP chars.
//
// Two-pass: if the day's full digest fits the cap, keep every session in full
// detail (no compression, no drops). If it doesn't, sessions with a recap (i.e.
// long, compacted sessions — the recap already summarizes their early prompts)
// are emitted in compressed [recap] + last-assistant form to free cap for more
// of the other sessions; non-recap sessions stay full until the cap, and the
// lowest-turn tail drops. First session is always represented (never an empty
// digest). Records dropped titles.
export function buildDigest(sessions) {
  const ordered = [...sessions].sort((a, b) => effortOf(b) - effortOf(a));
  const fullBlocks = ordered.map(sessionDigest);
  const fullTotal = fullBlocks.reduce((s, b) => s + b.length, 0);
  if (fullTotal <= DIGEST_CAP) {
    return { text: fullBlocks.join('\n\n'), dropped: [] };
  }
  // Over cap: trade recap-session detail for breadth — compress the compacted
  // (long) sessions so more of the day's other sessions fit.
  const kept = [];
  const dropped = [];
  let total = 0;
  for (let i = 0; i < ordered.length; i++) {
    const sess = ordered[i];
    const block = sess.recapText ? compressedDigest(sess) : fullBlocks[i];
    if (total + block.length <= DIGEST_CAP || kept.length === 0) {
      kept.push(block);
      total += block.length;
      continue;
    }
    dropped.push(sess.title || sess.id);
  }
  return { text: kept.join('\n\n'), dropped };
}

// ---- Summarizer + fallback chain: anthropic -> ollama -> deterministic ----

function parseJsonSummary(text) {
  const m = typeof text === 'string' && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const projects = (Array.isArray(o.projects) ? o.projects : [])
      .filter((p) => p?.path && Array.isArray(p.bullets))
      .map((p) => ({ path: String(p.path), bullets: p.bullets.filter((b) => b && String(b).trim()).slice(0, 3).map((b) => bullet(String(b))) }))
      .filter((p) => p.bullets.length);
    if (!projects.length) return null;
    return { projects, topics: Array.isArray(o.topics) ? o.topics.slice(0, 5).map(String) : [] };
  } catch { return null; }
}

// Bottom rung: no LLM, so a project's bullets are its own session titles —
// same shape as the LLM path so the client never branches on provenance.
function deterministicSummary(sessions) {
  const byPath = new Map();
  for (const s of sessions) {
    const key = s.cwd || s.project || 'unknown';
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(s);
  }
  const projects = [...byPath].map(([path, list]) => ({
    path,
    bullets: [...list].sort((a, b) => effortOf(b) - effortOf(a)).slice(0, 3).map((s) => bullet(s.title || blurbOf(s.userTexts) || s.id)),
  }));
  return { projects, topics: [] };
}

async function defaultCallAnthropic(digestText) {
  // Per-project bullets need far more room than the old one-paragraph summary:
  // a day spanning 7 repos is ~7x3 bullets, and a truncated reply is invalid
  // JSON — which silently drops the whole day to the deterministic rung.
  return callMessages({ system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: digestText }], maxTokens: 1500 });
}
async function defaultCallOllama(digestText) {
  const { stdout } = await execFileP(OLLAMA_BIN, ['run', getSummariserModel(), `${SUMMARY_SYSTEM}\n\n${digestText}`], { maxBuffer: OLLAMA_MAX_BUFFER, timeout: OLLAMA_TIMEOUT_MS });
  return stdout;
}

// callAnthropic/callOllama are injectable — tests stub them so no network call
// ever happens. Each rung must produce a valid entry and never throw.
export async function summarizeDay(digestText, sessions, { callAnthropic = defaultCallAnthropic, callOllama = defaultCallOllama } = {}) {
  const a = await callAnthropic(digestText).catch((e) => ({ ok: false, error: e.message }));
  const parsedA = a?.ok ? parseJsonSummary(a.text) : null;
  if (parsedA) return { ...parsedA, llm: { ok: true, provider: 'anthropic-oauth', model: a.model || null, inputTokens: a.inputTokens ?? null, outputTokens: a.outputTokens ?? null } };
  // Surface the failure reason instead of swallowing it — both providers fall
  // through to `reason: 'unavailable'` below, but `error` now carries which one
  // failed and why, so the card isn't a bare "unavailable" with no clue.
  const anthropicErr = !a?.ok ? (a?.error || 'anthropic call failed') : null;

  let ollamaErr = null;
  // No summariser model configured in Settings -> skip the ollama rung entirely,
  // exactly as an absent OLLAMA_BIN does.
  const summariser = getSummariserModel();
  if (OLLAMA_BIN && summariser) {
    let stdout;
    try { stdout = await callOllama(digestText); } catch (e) { ollamaErr = e.message; stdout = null; }
    const parsedO = parseJsonSummary(stdout);
    if (parsedO) return { ...parsedO, llm: { ok: true, provider: 'ollama', model: summariser, inputTokens: null, outputTokens: null } };
  }

  return { ...deterministicSummary(sessions), llm: { ok: false, provider: null, model: null, reason: 'unavailable', error: anthropicErr || ollamaErr || null } };
}

// ---- Entry assembly ---------------------------------------------------------

async function buildDayEntry(date, dayAgg, deps) {
  const sessions = dayAgg.sessions.filter((s) => !isNoiseSession(s));
  const metrics = { ...dayAgg.metrics, costUsd: Math.round(dayAgg.metrics.costUsd * 100) / 100 };
  const repos = [...new Set(sessions.map((s) => repoName(s.cwd || s.project)).filter(Boolean))];

  let result;
  if (dayAgg.sessions.length === 0) {
    // Gap day: no work at all. Still written as an entry so it stops showing as
    // pending forever and the page can render absence explicitly.
    result = { projects: [], topics: [], llm: { ok: false, provider: null, model: null, reason: 'empty' } };
  } else if (metrics.turns < TRIVIAL_TURNS || sessions.length === 0) {
    // Nothing worth an LLM call: a tiny day, or a day of nothing but noise rows.
    result = { ...deterministicSummary(sessions), llm: { ok: false, provider: null, model: null, reason: 'trivial' } };
  } else {
    const { text: digestText, dropped } = buildDigest(sessions);
    result = await summarizeDay(digestText, sessions, deps);
    if (dropped.length) result = { ...result, llm: { ...result.llm, dropped } };
  }

  return {
    date,
    projects: result.projects || [],
    topics: result.topics || [],
    repos,
    sessions: sessions.map((s) => ({ id: s.id, project: s.project, cwd: s.cwd, source: s.source, title: s.title, turns: s.turns, dayTurns: s.dayTurns, blurb: blurbOf(s.userTexts) })),
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
async function _ensureHistory({ days = BACKFILL_DAYS, callAnthropic, callOllama, root } = {}) {
  const today = localDay();
  const wanted = [];
  for (let i = 1; i <= days; i++) wanted.push(localDay(Date.now() - i * 86_400_000));
  wanted.sort();

  const prior = new Map(readHistory().map((e) => [e.date, e]));
  // Entries predating the per-project bullets carry a prose `summary` and no
  // `projects` — treat them as missing so one boot pass re-summarizes them.
  const missing = wanted.filter((d) => d !== today && (!prior.has(d) || prior.get(d).llm?.reason === 'empty' || !Array.isArray(prior.get(d).projects)));
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

// Boot fires ensureHistory() fire-and-forget and the page's first GET /history
// fires it again; both read the file before either appends, derive the same
// `missing` set, and summarize every day twice. enqueueWrite only serializes
// the writes — the critical section is read-diff -> summarize -> append. So
// dedupe callers: a second concurrent call joins the running pass.
let inFlight = null;
export async function ensureHistory(opts = {}) {
  if (inFlight) return inFlight;              // ponytail: joins the running pass; a
  inFlight = _ensureHistory(opts)             // wider `days` arriving second is picked
    .finally(() => { inFlight = null; });     // up by the next call, which is fine —
  return inFlight;                            // the route re-checks gaps on every load.
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
  // Same noise filter as buildDayEntry: dropped from the session list + repos,
  // but metrics still count their turns/spend (buildDayEntry keeps dayAgg.metrics).
  const sessions = agg.sessions.filter((s) => !isNoiseSession(s));
  const repos = [...new Set(sessions.map((s) => repoName(s.cwd || s.project)).filter(Boolean))];
  return {
    date, live: true,
    repos,
    sessions: sessions.map((s) => ({ id: s.id, project: s.project, cwd: s.cwd, source: s.source, title: s.title, turns: s.turns, dayTurns: s.dayTurns, blurb: blurbOf(s.userTexts) })),
    metrics: { ...agg.metrics, costUsd: Math.round(agg.metrics.costUsd * 100) / 100 },
  };
}
