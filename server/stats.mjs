// Per-agent stats from the session .jsonl (turns + tokens) plus cost, both from
// a pricing-table estimate (per-model token buckets) and, when present, the
// exact statusline value written by the global statusline (claude-code-usage-report
// skill) to cost-state/<id>.json — the single source of truth for all sessions,
// foreground and task/background. Prices drift with Anthropic's rate card — treat
// estCostUsd as a fallback/cross-check; the statusline value (costSource:
// 'statusline') is authoritative when present.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encodeCwd, getActiveMs } from './agents.mjs';
import { pathFor } from './sessions.mjs';

// Mirror of statusline.mjs's state root so the two never drift. Full payload
// (cost.total_cost_usd / total_api_duration_ms / total_duration_ms) per session.
const stateRoot = process.env.USAGE_REPORT_STATE || join(homedir(), '.agents', '.claude-code-usage-report', 'state');
export const COST_STATE_DIR = join(stateRoot, 'cost-state');

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
// (each full read is sync and stalls the pty relay).
const cache = new Map(); // path -> { mtimeMs, size, result }

export function parseSession(cwd, id) {
  return parseByPath(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`));
}

// Full parse of one transcript path into turns + per-bucket token totals + est
// cost + models seen. Cached by (mtime,size). Shared by agent stats (via cwd)
// and session stats (via project dirname).
function parseByPath(p) {
  let st;
  try { st = statSync(p); } catch { return { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null }; }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let turns = 0, tokens = 0, estCostUsd = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  const models = new Set();
  try {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
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
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// Session-history stats keyed by the encoded-cwd project dirname (as the
// session list already has it), merging the exact statusline cost when present.
const EMPTY_SESSION = { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [], exists: false, estCostUsd: null };

export function sessionStats(project, id, root) {
  const p = pathFor(project, id, root);
  const session = p ? parseByPath(p) : EMPTY_SESSION;
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
export function statsFor(agents) {
  const out = {};
  for (const a of agents) {
    const session = parseSession(a.cwd, a.id);
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
