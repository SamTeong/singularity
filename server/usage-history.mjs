// 5h history for the Usage view's history panel: the current 5h window's
// account-level % readings per provider, plus an ESTIMATED per-session split.
// Providers report only the account total, so each interval's % rise is split
// by each session's share of the cost spent in that interval. Claude cost =
// Claude Code's own reported cost deltas from the statusline's
// cost-history.jsonl; sessions with no rows there, and Codex, fall back to
// tokens priced with the usage-report skill's pricing.json (Claude: transcript
// message usage; Codex: the harness Stop hook's per-turn token rows, else rollout
// token_count events). Ollama has no per-session
// data, so its series is the total line only.
// Read-only: USAGE_SKILL_STATE history files, ~/.claude/projects, ~/.codex/sessions.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { USAGE_SKILL_STATE } from './app-dir.mjs';
import { getModelPrices } from './model-prices.mjs';

export const HISTORY_PROVIDERS = ['claude', 'codex', 'ollama'];
// 7d = each provider's weekly account % only, no per-session split (TASK-10 option A).
const WINDOW_MS = { '5h': 5 * 3.6e6, '7d': 7 * 86_400_000 };
export const HISTORY_WINDOWS = Object.keys(WINDOW_MS);
// shortcut: reads only the last 2MB of each history log (~1-2KB a line, far more
// than one 5h window of samples); read further back if a window ever overflows it.
const TAIL_BYTES = 2 * 1024 * 1024;
// shortcut: 7d reads the last 8MB (Claude snapshots ~1.5KB/row every ~2 min = ~3.5MB a week); raise it if sampling gets denser.
const WEEK_TAIL_BYTES = 8 * 1024 * 1024;
// shortcut: 7d keeps the last reading per 15 min (<= 672 points); a spike inside one bucket is not drawn.
const WEEK_BUCKET_MS = 15 * 60 * 1000;
// The rest fold into one "Other sessions" series so the legend stays readable.
const MAX_SERIES = 8;
const UNATTRIBUTED = '_unattributed';
const OTHER = '_other';

const TOTALS = {
  claude: { file: 'usage-snapshots.jsonl', win: { '5h': (r) => r.raw?.five_hour ?? r.five_hour, '7d': (r) => r.raw?.seven_day ?? r.seven_day } },
  codex: { file: 'codex-usage.jsonl', win: { '5h': (r) => r.session, '7d': (r) => r.weekly } },
  ollama: { file: 'ollama-usage.jsonl', win: { '5h': (r) => r.session, '7d': (r) => r.weekly } },
};

function readAt(file, pos, len) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    return buf.subarray(0, readSync(fd, buf, 0, len, pos));
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

const parseRow = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };

// Parsed JSON rows of the last `bytes` of a log, the window start's partial line
// dropped (as a cold tail read does), each kept with its byte offset per
// (file, bytes). A grown file reads only the new bytes; a shrunk, replaced or
// rewritten file reads cold. `keep` (<= bytes) narrows the result to the last
// `keep` bytes with the same boundary rule. Equals a cold read (usage-history.test.mjs).
const tails = new Map();
export function tailRows(file, bytes = TAIL_BYTES, keep = bytes) {
  const key = `${file}\0${bytes}`;
  let st; try { st = statSync(file); } catch { tails.delete(key); return []; }
  const cold = () => { const pos = Math.max(0, st.size - bytes); return { ino: st.ino, birthtimeMs: st.birthtimeMs, size: 0, mtimeMs: 0, pos, lead: pos > 0, rows: [], frag: null, last: null }; };
  let e = tails.get(key);
  if (!e || st.ino !== e.ino || st.birthtimeMs !== e.birthtimeMs || st.size < e.size
    || (st.size === e.size && st.mtimeMs !== e.mtimeMs) || st.size - bytes > e.pos) e = cold();
  if (st.size !== e.size || st.mtimeMs !== e.mtimeMs) {
    // Re-read the last complete line too: changed bytes there = rewritten in place.
    let from = e.last?.off ?? e.pos;
    let buf = readAt(file, from, st.size - from);
    if (buf && e.last && !(buf[e.last.len] === 10 && buf.toString('utf8', 0, e.last.len) === e.last.text)) {
      e = cold();
      from = e.pos;
      buf = readAt(file, from, st.size - from);
    }
    if (!buf) return [];
    let at = e.pos - from;
    for (let nl; (nl = buf.indexOf(10, at)) !== -1; at = nl + 1) {
      if (e.lead) { e.lead = false; continue; } // mid-line window start
      const text = buf.toString('utf8', at, nl);
      e.last = { off: from + at, len: nl - at, text };
      if (text) e.rows.push({ off: from + at, value: parseRow(text) });
    }
    // An unterminated last line is served but re-read next time.
    e.pos = e.lead ? from + buf.length : from + at;
    e.frag = !e.lead && at < buf.length ? { off: e.pos, value: parseRow(buf.toString('utf8', at)) } : null;
    e.size = from + buf.length;
    e.mtimeMs = st.mtimeMs;
    const start = st.size - bytes;
    const i = start > 0 ? e.rows.findIndex((r) => r.off > start) : 0;
    if (i !== 0) e.rows = i === -1 ? [] : e.rows.slice(i);
    tails.set(key, e);
  }
  const from = st.size - keep;
  const out = [];
  for (const r of e.frag ? [...e.rows, e.frag] : e.rows) if (r.value && (from <= 0 || r.off > from)) out.push(r.value);
  return out;
}

// usage.mjs rotates usage-snapshots.jsonl into usage-snapshots-YYYY-MM.jsonl monthly.
export function newestSnapshotArchive() {
  const f = safeDir(USAGE_SKILL_STATE).filter((n) => /^usage-snapshots-\d{4}-\d{2}\.jsonl$/.test(n)).sort().at(-1);
  return f ? join(USAGE_SKILL_STATE, f) : null;
}

// [{t, pct, resetsAt}] oldest first. fetched_at is local time with no zone,
// parsed as local, which is what wrote it.
let lastArchive = null;
function readTotals(provider, windowKey) {
  const { file } = TOTALS[provider];
  const win = TOTALS[provider].win[windowKey];
  // 7d rows also carry the 5h %, the chart's second series; 5h rows stay as-is.
  const win5 = windowKey === '7d' ? TOTALS[provider].win['5h'] : null;
  const bytes = windowKey === '7d' ? WEEK_TAIL_BYTES : TAIL_BYTES;
  const path = join(USAGE_SKILL_STATE, file);
  let lines = tailRows(path, bytes);
  // Claude's archive + live file are one stream: a live file under the budget
  // continues into the newest archive's tail (budget < one month of rows).
  const live = fileStat(path)?.[1] ?? 0;
  if (provider === 'claude' && live < bytes) {
    const archive = newestSnapshotArchive();
    if (archive !== lastArchive) { for (const k of tails.keys()) if (lastArchive && k.startsWith(`${lastArchive}\0`)) tails.delete(k); lastArchive = archive; }
    if (archive) lines = [...tailRows(archive, bytes, bytes - live), ...lines];
  }
  const rows = [];
  for (const r of lines) {
    const w = win(r);
    const w5 = win5?.(r);
    const t = Date.parse(r.fetched_at);
    if (!Number.isFinite(w?.utilization) || Number.isNaN(t)) continue;
    // Old Codex rows carry resets_at as epoch seconds.
    const resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : w.resets_at ? Date.parse(w.resets_at) : NaN;
    rows.push({ t, pct: w.utilization, pct5h: Number.isFinite(w5?.utilization) ? w5.utilization : null, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt });
  }
  return rows.sort((a, b) => a.t - b.t);
}

function safeDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// [mtimeMs, size], or null when missing.
function fileStat(p) {
  try { const s = statSync(p); return [s.mtimeMs, s.size]; } catch { return null; }
}

// Parsed transcript/rollout events per path, reused while (mtime, size) hold.
// Events keep raw tokens, not $, so a pricing.json edit applies on the next read.
const cache = new Map();
function parseCached(path, parse) {
  let st; try { st = statSync(path); } catch { return null; }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let content; try { content = readFileSync(path, 'utf8'); } catch { return null; }
  const result = parse(content);
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parse, result });
  return result;
}

// Drop this parser's entries for files that left the window or were deleted.
// shortcut: a changed file is still re-read whole; parse only the appended tail if large transcripts make polls slow.
function pruneCache(parse, keep) {
  for (const [path, hit] of cache) if (hit.parse === parse && !keep.has(path)) cache.delete(path);
}

// tok = [input, output, cacheRead, cacheWrite], the pricing.json rate order.
// One API response spans several transcript lines repeating the same usage, so
// dedupe on message.id. The last line wins: a rare early line carries partial
// usage (output_tokens 0) that a later line completes.
function parseClaudeTranscript(content) {
  const events = [];
  const seen = new Map(); // message.id -> index in events
  let cwd = null;
  for (const line of content.split('\n')) {
    if (!line) continue;
    if (!cwd && line.includes('"cwd"')) { try { cwd = JSON.parse(line).cwd ?? null; } catch { /* partial line */ } }
    if (!line.includes('"type":"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    const u = m?.usage;
    if (!u) continue;
    const e = {
      t: Date.parse(o.timestamp), model: m.model ?? '',
      tok: [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0],
    };
    if (m.id && seen.has(m.id)) { events[seen.get(m.id)] = { ...e, t: events[seen.get(m.id)].t }; continue; }
    if (m.id) seen.set(m.id, events.length);
    events.push(e);
  }
  return { cwd, events };
}

// Codex input_tokens INCLUDES cached_input_tokens (stats.mjs parseCodexRollout),
// so the cache-read count is stripped from input. A token_count event whose
// running total did not move is a repeat, not new spend.
function parseCodexRollout(content) {
  const events = [];
  const models = [];
  let id = null, cwd = null, model = '', lastTotal = null;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta') { id = o.payload?.id ?? id; cwd = o.payload?.cwd ?? cwd; }
    if (o.type === 'turn_context' && o.payload?.model) {
      model = o.payload.model;
      models.push({ t: Date.parse(o.timestamp), model });
    }
    if (o.type !== 'event_msg' || o.payload?.type !== 'token_count') continue;
    const total = o.payload.info?.total_token_usage?.total_tokens;
    const last = o.payload.info?.last_token_usage;
    if (!last || total === lastTotal) continue;
    lastTotal = total;
    const cached = last.cached_input_tokens ?? 0;
    events.push({
      t: Date.parse(o.timestamp), model,
      tok: [Math.max(0, (last.input_tokens ?? 0) - cached), last.output_tokens ?? 0, cached, last.cache_write_input_tokens ?? 0],
    });
  }
  return { id, cwd, events, models };
}

// [[path, sessionId, mtimeMs, size]] for transcripts touched since `since`. Subagent
// transcripts (<proj>/<id>/subagents/*.jsonl) count toward their parent.
// shortcut: stats every transcript on each call; index by project dir mtime if this ever shows up in profiles.
function claudeFiles(since) {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const out = [];
  const subs = []; // after the parents, so a session's label takes the parent's cwd
  for (const proj of safeDir(root)) {
    const dir = join(root, proj);
    for (const f of safeDir(dir)) {
      if (f.endsWith('.jsonl')) { out.push([join(dir, f), f.slice(0, -6)]); continue; }
      const sub = join(dir, f, 'subagents');
      for (const s of safeDir(sub)) if (s.endsWith('.jsonl')) subs.push([join(sub, s), f]);
    }
  }
  return [...out, ...subs].map(([p, id]) => [p, id, ...(fileStat(p) ?? [0, 0])]).filter(([, , m]) => m >= since);
}

// Rollouts live under sessions/YYYY/MM/DD by local start date; the day before
// the window catches a session that started yesterday and is still running.
// shortcut: a session started 2+ days before the window is missed; scan more day dirs if that matters.
function codexFiles(since, now) {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const dirs = new Set();
  for (let t = since - 86_400_000; t <= now + 86_400_000; t += 86_400_000) {
    const d = new Date(Math.min(t, now));
    dirs.add(join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  const out = [];
  for (const dir of dirs) for (const f of safeDir(dir)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(join(dir, f));
  return out.map((p) => [p, ...(fileStat(p) ?? [0, 0])]).filter(([, m]) => m >= since); // [[path, mtimeMs, size]]
}

// Map sessionId -> [{t, usd}]: rises of each session's cumulative cost.total_cost_usd
// between its statusline rows (statusline.mjs appendHistory); .1 is the older half.
// A session's first row read is only its baseline: its cost so far may span rows
// that rotated out, so crediting it would lump hours of spend into one interval.
// The cost is a session's first API call when it starts in the window (cents).
// Both files rotate at TAIL_BYTES (statusline HISTORY_CAP), so the read is contiguous
// bar at most each file's oldest row.
// Rows with a 5h % also push {t, pct, resetsAt} onto `pts` (the extra history points).
const COST_HISTORY = join(USAGE_SKILL_STATE, 'cost-history.jsonl');
function claudeCostEvents(pts) {
  const last = new Map();
  const out = new Map();
  for (const r of [...tailRows(COST_HISTORY + '.1'), ...tailRows(COST_HISTORY)]) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    if (Number.isFinite(r.five_hour_pct) && Number.isFinite(r.five_hour_resets_at)) pts.push({ t, pct: r.five_hour_pct, resetsAt: r.five_hour_resets_at * 1000 });
    if (!r.session_id || !Number.isFinite(r.cost_usd)) continue;
    const base = last.get(r.session_id);
    const usd = base === undefined ? 0 : Math.max(0, r.cost_usd - base);
    last.set(r.session_id, r.cost_usd);
    if (!out.has(r.session_id)) out.set(r.session_id, []);
    out.get(r.session_id).push({ t, usd });
  }
  return out;
}

// Map sessionId -> {first, last, events: [{t, tok}]} from the Codex Stop hook's rows
// in codex-usage.jsonl: rises of a session's running total_token_usage between its
// rows. The first row read is only a baseline, as in claudeCostEvents. Rows without
// session_id (the daemon's, codex.mjs's, older hook rows) only feed the totals.
const CODEX_USAGE = join(USAGE_SKILL_STATE, 'codex-usage.jsonl');
function codexTurnEvents() {
  const out = new Map();
  for (const r of tailRows(CODEX_USAGE)) {
    const u = r.total_token_usage;
    const t = Date.parse(r.fetched_at);
    if (!r.session_id || !Number.isFinite(u?.total_tokens) || Number.isNaN(t)) continue;
    const s = out.get(r.session_id);
    if (!s) { out.set(r.session_id, { first: t, last: t, base: u, events: [], mixed: false }); continue; }
    // A falling total means rows from several threads share this id (early hook rows
    // keyed sub-agents by the root id) or a reset: the session falls back to its rollout.
    if (u.total_tokens < s.base.total_tokens) s.mixed = true;
    const d = (k) => Math.max(0, (u[k] ?? 0) - (s.base[k] ?? 0));
    const cached = d('cached_input_tokens'); // input includes cached, as in parseCodexRollout
    s.events.push({ t, tok: [Math.max(0, d('input_tokens') - cached), d('output_tokens'), cached, d('cache_write_input_tokens')] });
    s.base = u;
    s.last = t;
  }
  return out;
}

// Map sessionId -> {label, events}.
// `files` = claudeFiles / codexFiles for this window.
function sessionEvents(provider, since, now, costPoints, files) {
  const out = new Map();
  const add = (id, cwd, events) => {
    // Last 8 chars: UUIDv7 (Codex) ids share their time prefix within a second.
    const s = out.get(id) ?? { label: cwd ? `${basename(cwd)} · ${id.slice(-8)}` : id.slice(-8), events: [] };
    s.events.push(...events.filter((e) => e.t >= since && e.t <= now));
    out.set(id, s);
  };
  if (provider === 'claude') {
    for (const [path, id] of files) {
      const r = parseCached(path, parseClaudeTranscript);
      if (r) add(id, r.cwd, r.events);
    }
    pruneCache(parseClaudeTranscript, new Set(files.map(([path]) => path)));
    // A session with statusline rows takes its reported cost from its first (baseline)
    // row on; transcript events before that row are the only record of earlier spend.
    for (const [id, events] of claudeCostEvents(costPoints)) {
      const s = out.get(id);
      if (s) s.events = s.events.filter((e) => e.t < events[0].t);
      add(id, null, events);
    }
  } else if (provider === 'codex') {
    const turns = codexTurnEvents();
    // A session's hook rows cover its spend from its first row to its last; rollout
    // events before the first (baseline) or after the last (no Stop row yet) are the
    // per-turn fallback. +1s: fetched_at has whole-second resolution.
    for (const [path] of files) {
      const r = parseCached(path, parseCodexRollout);
      if (!r) continue;
      const id = r.id ?? basename(path, '.jsonl');
      const s = turns.get(id);
      if (!s || s.mixed) { add(id, r.cwd, r.events); continue; }
      add(id, r.cwd, r.events.filter((e) => e.t < s.first + 1000 || e.t >= s.last + 1000));
      // Rows carry no model: price each at the rollout model active at its time.
      const modelAt = (t) => (r.models.findLast((x) => x.t < (Math.floor(t / 1000) + 1) * 1000) ?? r.models[0] ?? r.events[0])?.model ?? '';
      add(id, null, s.events.map((e) => ({ ...e, model: modelAt(e.t) })));
    }
    pruneCache(parseCodexRollout, new Set(files.map(([path]) => path)));
    // shortcut: rows whose id joins no rollout in codexFiles' day range are dropped (a
    // wrongly keyed root-id row would double-count); widen the scan if old sessions matter.
    // shortcut: a root-id row set whose totals only rise looks like one thread; it is
    // not detected. Such rows exist only from harness 4f4826f to e4c4479.
  }
  return out;
}

// pricing.json: first `base` key that is a substring of the model id wins,
// else default_key. Rates are $/MTok.
// shortcut: ignores the above_200k long-context tier; only the split ratio matters here.
function pricer() {
  const { base, default_key: def } = getModelPrices();
  const keys = Object.keys(base);
  return (model, tok) => {
    const rate = base[keys.find((k) => model.includes(k)) ?? def];
    return rate ? tok.reduce((sum, n, i) => sum + n * rate[i], 0) / 1e6 : 0;
  };
}

const round = (n) => Math.round(n * 100) / 100;

// Split each interval's % rise across the sessions that spent in it, by cost
// share. The first reading, and any rise with no recorded spend, stay
// unattributed, so every point's stack sums to its account %.
function attribute(points, sessions, cost) {
  const cum = new Map();
  let unattributed = points[0]?.pct ?? 0;
  const rows = points.map((p, i) => {
    if (i > 0) {
      const prev = points[i - 1];
      const rise = p.pct - prev.pct;
      if (rise < 0) {
        // A drop (provider rounding or correction): shrink every share in
        // proportion, since the stack equalled prev.pct.
        const f = prev.pct > 0 ? p.pct / prev.pct : 0;
        for (const [id, v] of cum) cum.set(id, v * f);
        unattributed *= f;
        return { ts: p.t, pct: p.pct, shares: new Map(cum), unattributed };
      }
      const spend = new Map();
      let total = 0;
      for (const [id, s] of sessions) {
        for (const e of s.events) {
          if (e.t <= prev.t || e.t > p.t) continue;
          const c = e.usd ?? cost(e.model, e.tok);
          spend.set(id, (spend.get(id) ?? 0) + c);
          total += c;
        }
      }
      if (total > 0) for (const [id, c] of spend) cum.set(id, (cum.get(id) ?? 0) + rise * c / total);
      else unattributed += rise;
    }
    return { ts: p.t, pct: p.pct, shares: new Map(cum), unattributed };
  });
  const final = rows.at(-1)?.shares ?? new Map();
  const ranked = [...final.keys()].filter((id) => final.get(id) > 0).sort((a, b) => final.get(b) - final.get(a));
  const shown = ranked.slice(0, MAX_SERIES);
  const folded = ranked.slice(MAX_SERIES);
  const series = [
    ...shown.map((id) => ({ id, label: sessions.get(id)?.label ?? id })),
    ...(folded.length ? [{ id: OTHER, label: `Other sessions (${folded.length})` }] : []),
    { id: UNATTRIBUTED, label: 'Unattributed' },
  ];
  return {
    sessions: series,
    points: rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      pct: r.pct,
      sessions: {
        ...Object.fromEntries(shown.map((id) => [id, round(r.shares.get(id) ?? 0)])),
        ...(folded.length ? { [OTHER]: round(folded.reduce((sum, id) => sum + (r.shares.get(id) ?? 0), 0)) } : {}),
        [UNATTRIBUTED]: round(r.unattributed),
      },
    })),
  };
}

const statSig = (paths) => paths.map((p) => [p, fileStat(p)]);

// Last doc per provider:window, served while its inputs are unchanged. Inputs are
// statted before they are read, so a write in between forces a recompute, never a stale hit.
// shortcut: readings/events stamped after `now` (clock skew) are not re-checked on a hit.
const docs = new Map();

// GET /api/usage/history?provider=&window= — null for an unknown provider or
// window (route 400s).
export function getUsageHistory(provider, now = Date.now(), windowKey = '5h') {
  if (!HISTORY_PROVIDERS.includes(provider) || !HISTORY_WINDOWS.includes(windowKey)) return null;
  const live = join(USAGE_SKILL_STATE, TOTALS[provider].file);
  const totalsSig = statSig(provider === 'claude' ? [live, newestSnapshotArchive()].filter(Boolean) : [live]);
  const rows = readTotals(provider, windowKey);
  const resetsAt = rows.at(-1)?.resetsAt ?? null;
  const estimated = provider !== 'ollama' && windowKey === '5h';
  // No reset time on the newest reading = no window running (0% after a reset);
  // a reset already past = that window is over (usage.mjs hasActiveWindow).
  if (resetsAt == null || resetsAt <= now) return { provider, window: windowKey, windowStart: null, resetsAt: null, points: [], sessions: [], estimated };
  const start = resetsAt - WINDOW_MS[windowKey];
  const files = !estimated ? [] : provider === 'claude' ? claudeFiles(start) : codexFiles(start, now);
  const logs = !estimated ? [] : provider === 'claude' ? [`${COST_HISTORY}.1`, COST_HISTORY] : [CODEX_USAGE];
  const sig = JSON.stringify([resetsAt, totalsSig, statSig(logs), files, estimated && getModelPrices()]);
  const key = `${provider}:${windowKey}`;
  if (docs.get(key)?.sig === sig) return docs.get(key).doc;
  const doc = buildDoc(provider, windowKey, rows, resetsAt, start, estimated, now, files);
  docs.set(key, { sig, doc });
  return doc;
}

function buildDoc(provider, windowKey, rows, resetsAt, start, estimated, now, files) {
  let points = rows.filter((r) => r.t >= start && r.t <= resetsAt);
  if (windowKey === '7d') points = points.filter((p, i) => Math.floor(p.t / WEEK_BUCKET_MS) !== Math.floor((points[i + 1]?.t ?? Infinity) / WEEK_BUCKET_MS));
  const doc = { provider, window: windowKey, windowStart: new Date(start).toISOString(), resetsAt: new Date(resetsAt).toISOString(), estimated };
  if (!estimated) return { ...doc, points: points.map((p) => ({ ts: new Date(p.t).toISOString(), pct: p.pct, ...(windowKey === '7d' ? { pct5h: p.pct5h ?? null } : {}), sessions: {} })), sessions: [] };
  // Statusline rows (every turn) fill the sparse snapshots: keep this window's (resets_at
  // within 60s: snapshots carry fractions), then collapse consecutive equal readings.
  const costPoints = [];
  const sessions = sessionEvents(provider, start, now, costPoints, files);
  if (provider === 'claude') {
    points = [...points, ...costPoints.filter((p) => Math.abs(p.resetsAt - resetsAt) <= 60_000 && p.t >= start && p.t <= resetsAt)]
      .sort((a, b) => a.t - b.t)
      .filter((p, i, a) => p.pct !== a[i - 1]?.pct);
  }
  return { ...doc, ...attribute(points, sessions, pricer()) };
}
