// Per-agent stats from the session .jsonl (turns + tokens) plus cost, both from
// a pricing-table estimate (per-model token buckets) and, when present, the
// exact statusline value written by the global statusline (harness-usage-report
// skill) to cost-state/<id>.json — the single source of truth for all sessions,
// foreground and task/background. Prices drift with Anthropic's rate card — treat
// estCostUsd as a fallback/cross-check; the statusline value (costSource:
// 'statusline') is authoritative when present.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encodeCwd, getActiveMs } from './agents.mjs';
import { pathFor } from './sessions.mjs';
import { USAGE_SKILL_STATE } from './app-dir.mjs';

// Mirror of statusline.mjs's state root so the two never drift. Full payload
// (cost.total_cost_usd / total_api_duration_ms / total_duration_ms) per session.
export const COST_STATE_DIR = join(USAGE_SKILL_STATE, 'cost-state');

// $ per million tokens: [input, output]. Matched by longest prefix on the
// transcript message model id. cache read = 0.1x input; cache write = 1.25x
// input (5m TTL) or 2x input (1h TTL) — applied per-TTL below when the usage
// object has a cache_creation breakdown, else 1.25x on the whole bucket.
const PRICES = [
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos', { input: 10, output: 50 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-1', { input: 15, output: 75 }],
  ['claude-opus-4-0', { input: 15, output: 75 }],
  ['claude-3-opus', { input: 15, output: 75 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-3-5-sonnet', { input: 3, output: 15 }],
  ['claude-sonnet', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 1, output: 5 }],
].sort((a, b) => b[0].length - a[0].length); // longest prefix first

function priceFor(model) {
  if (!model) return null;
  for (const [prefix, p] of PRICES) if (model.startsWith(prefix)) return p;
  return null;
}

// Session logs grow to many MB and are polled every few seconds — cache the
// parse result keyed on (mtime, size) so unchanged files are never re-read
// (each full read is async now, but still real I/O worth skipping).
const cache = new Map(); // path -> { mtimeMs, size, result }
const CACHE_MAX = 1000; // simple size cap — evict the oldest-inserted entry past this (not true LRU, just bounds memory)

function cacheSet(path, st, result) {
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export async function parseSession(cwd, id, tool) {
  // Codex sessions live under ~/.codex/sessions/**/rollout-*.jsonl, keyed by
  // their own thread uuid — NOT the singularity agent id (codex has no
  // --session-id flag). So for a codex session, locate the rollout by cwd
  // (a background task's worktree is unique, so the newest rollout at that
  // cwd is the live run) and parse its token_count events. Claude/ollama
  // sessions write a claude .jsonl keyed by the agent id (ollama runs through
  // the claude wrapper), so they take the by-id path.
  if (tool === 'codex') {
    const p = findCodexRolloutForCwd(cwd);
    return p ? parseCodexRollout(p) : { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null };
  }
  return parseByPath(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`));
}

// Full parse of one transcript path into turns + per-bucket token totals + est
// cost + models seen. Cached by (mtime,size). Shared by agent stats (via cwd)
// and session stats (via project dirname). Async (fs/promises) so a batch of
// these (see /sessions/stats in index.mjs) can't stall the event loop / pty relay.
async function parseByPath(p) {
  let st;
  try { st = await stat(p); } catch { return { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null }; }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let turns = 0, tokens = 0, estCostUsd = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  const models = new Set();
  try {
    const content = await readFile(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') turns++;
      const u = o.message?.usage;
      if (!u) continue;
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const cacheCreate = u.cache_creation_input_tokens || 0;
      inputTokens += input; outputTokens += output;
      cacheReadTokens += cacheRead; cacheWriteTokens += cacheCreate;
      tokens += input + output + cacheRead + cacheCreate;
      if (o.message?.model && o.message.model !== '<synthetic>') models.add(o.message.model);
      const price = priceFor(o.message?.model);
      if (!price) continue; // unknown model prefix — skip, leaves estCostUsd null for pure-unknown sessions
      let cost = (input * price.input + output * price.output) / 1e6;
      cost += (cacheRead * price.input * 0.1) / 1e6;
      if (u.cache_creation?.ephemeral_5m_input_tokens != null || u.cache_creation?.ephemeral_1h_input_tokens != null) {
        cost += ((u.cache_creation.ephemeral_5m_input_tokens || 0) * price.input * 1.25) / 1e6;
        cost += ((u.cache_creation.ephemeral_1h_input_tokens || 0) * price.input * 2) / 1e6;
      } else {
        cost += (cacheCreate * price.input * 1.25) / 1e6;
      }
      estCostUsd = (estCostUsd || 0) + cost;
    }
  } catch { /* partial/locked file — return what we have */ }
  const result = { turns, tokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, models: [...models], exists: true, estCostUsd };
  cacheSet(p, st, result);
  return result;
}

// Session-history stats keyed by the encoded-cwd project dirname (as the
// session list already has it), merging the exact statusline cost when present.
const EMPTY_SESSION = { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null };

// ---- Codex CLI rollout parsing (~/.codex/sessions/**/rollout-*.jsonl) --------
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normCwd = (c) => (c || '').toLowerCase().replace(/\\/g, '/');

// Read just the first few KB of a rollout for its session_meta cwd — a codex
// rollout's first event is session_meta, so we never need the whole file to
// decide whether this rollout belongs to `cwd`.
function readHead(p, bytes = 4096) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
  finally { if (fd != null) try { closeSync(fd); } catch {} }
}

function codexRolloutCwd(p, want) {
  for (const line of readHead(p).split(/\r?\n/)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta' && o.payload?.cwd) return normCwd(o.payload.cwd) === want;
  }
  return false;
}

// Bounded: only the newest year/month/day dirs (a live run writes today), and
// the newest few rollouts by mtime within each. Returns the rollout path whose
// session_meta.cwd matches, or null.
function findCodexRolloutForCwd(cwd) {
  const want = normCwd(cwd);
  let years; try { years = readdirSync(CODEX_SESSIONS_DIR).sort(); } catch { return null; }
  for (const year of [...years].reverse().slice(0, 2)) {
    const months = listDirs(join(CODEX_SESSIONS_DIR, year)).slice(-2);
    for (const month of [...months].reverse()) {
      const days = listDirs(join(CODEX_SESSIONS_DIR, year, month)).slice(-3);
      for (const day of [...days].reverse()) {
        const dir = join(CODEX_SESSIONS_DIR, year, month, day);
        let files; try { files = readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')); } catch { continue; }
        const sorted = files
          .map((f) => { const fp = join(dir, f); return [fp, statSync(fp).mtimeMs]; })
          .sort((a, b) => b[1] - a[1]);
        for (const [fp] of sorted.slice(0, 10)) if (codexRolloutCwd(fp, want)) return fp;
      }
    }
  }
  return null;
}

function listDirs(p) { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } }

// Full parse of one codex rollout into the same shape as parseByPath. Codex
// emits a token_count event per turn carrying last_token_usage; input_tokens
// INCLUDES cached_input_tokens, so strip the cache-read count to avoid double
// counting (mirrors the harness-usage-report codex parser). estCostUsd stays
// null — the server PRICES table has no gpt-* entries, and codex cost is not
// tracked by the claude statusline. Cached by (mtime,size) like claude paths.
async function parseCodexRollout(p) {
  let st; try { st = await stat(p); } catch { return { ...EMPTY_SESSION }; }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let turns = 0, tokens = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  const models = new Set();
  try {
    const content = await readFile(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'turn_context' && o.payload?.model) models.add(o.payload.model);
      if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'assistant') turns++;
      if (o.type === 'event_msg' && o.payload?.type === 'token_count') {
        const last = o.payload.info?.last_token_usage || {};
        const cacheRead = num(last.cached_input_tokens);
        const cacheWrite = num(last.cache_write_input_tokens);
        const input = Math.max(0, num(last.input_tokens) - cacheRead);
        const output = num(last.output_tokens);
        inputTokens += input; outputTokens += output;
        cacheReadTokens += cacheRead; cacheWriteTokens += cacheWrite;
        tokens += input + output + cacheRead + cacheWrite;
      }
    }
  } catch { /* partial/locked file — return what we have */ }
  const result = { turns, tokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, models: [...models], exists: true, estCostUsd: null };
  cacheSet(p, st, result);
  return result;
}

export async function sessionStats(project, id, root) {
  const p = pathFor(project, id, root);
  const session = p ? await parseByPath(p) : EMPTY_SESSION;
  const cost = readCostFile(id);
  return {
    ...session,
    costUsd: cost.costUsd ?? session.estCostUsd ?? null,
    costSource: cost.costUsd != null ? 'statusline' : session.estCostUsd != null ? 'estimate' : null,
  };
}

// Global statusline cost-state file: exact cost + API vs. wall duration for one
// session (full payload), refreshed ~every 300ms while it runs.
export function readCostFile(id) {
  try {
    const d = JSON.parse(readFileSync(join(COST_STATE_DIR, `${id}.json`), 'utf8'));
    const c = d.cost || {};
    return {
      costUsd: typeof c.total_cost_usd === 'number' ? c.total_cost_usd : null,
      apiMs: typeof c.total_api_duration_ms === 'number' ? c.total_api_duration_ms : null,
      wallMs: typeof c.total_duration_ms === 'number' ? c.total_duration_ms : null,
    };
  } catch { return { costUsd: null, apiMs: null, wallMs: null }; }
}

// { id: {turns, tokens, exists, estCostUsd, costUsd, costSource, apiMs, wallMs, busyMs} }
// for a list of {id, cwd}. costUsd = the global statusline cost-state value when
// present, else the pricing-table estimate; costSource labels which ('statusline'|'estimate'|null).
export async function statsFor(agents) {
  const out = {};
  for (const a of agents) {
    const session = await parseSession(a.cwd, a.id, a.tool);
    const cost = readCostFile(a.id);
    const costUsd = cost.costUsd ?? session.estCostUsd ?? null;
    const costSource = cost.costUsd != null ? 'statusline' : session.estCostUsd != null ? 'estimate' : null;
    out[a.id] = {
      ...session,
      costUsd,
      costSource,
      apiMs: cost.apiMs,
      wallMs: cost.wallMs,
      busyMs: getActiveMs(a.id),
    };
  }
  return out;
}
