// Claude Code stats pipeline: record (SessionEnd hook), backfill, report (HTML).
// Node ESM, stdlib only. All data stays local. HTML rendering lives in render.mjs.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "./render.mjs";
import * as FC from "./forecast.mjs";
import { codexIngest, codexMtimes } from "./codex.mjs";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
// State root; USAGE_REPORT_STATE overrides it (must match statusline.mjs, which
// honors the same env var — otherwise capture writes and record/report reads split).
const SKILL_STATE_DIR = process.env.USAGE_REPORT_STATE || path.join(HOME, ".agents", ".harness-usage-report", "state");
const STATE_DIR = path.join(SKILL_STATE_DIR, "cost-state");
export const STATS_CSV = path.join(SKILL_STATE_DIR, "stats.csv");
const SESSIONS_JSONL = path.join(SKILL_STATE_DIR, "sessions.jsonl");
// Transcript-totals cache (Phase A): a parse accelerator so `backfill`/`report`
// don't re-parse every transcript on each run. Keyed by sid → {main_mtime, sub,
// res}; re-parse only when a transcript or any subagent-run file changed. Bump
// TOTALS_CACHE_VERSION when parse_transcript / session_totals result shape
// changes — a mismatch invalidates the whole cache.
const TOTALS_CACHE = path.join(SKILL_STATE_DIR, "totals-cache.json");
const TOTALS_CACHE_VERSION = 1;
// OAuth usage-API (Phase B). Off by default — the skill is local-only unless
// USAGE_REPORT_OAUTH=1 or --oauth is passed. Creds read from ~/.claude/.credentials.json
// (claudeAiOauth.accessToken); OS keychain not handled in v1 (documented fallback).
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, ".credentials.json");
const USAGE_SNAPSHOTS_JSONL = path.join(SKILL_STATE_DIR, "usage-snapshots.jsonl");
// Ollama Cloud account-quota history (Phase 1, written by the daemon's own
// scraper — no OAuth, no statusline). Same snapshot shape as usage-snapshots.jsonl
// except gauge keys are session/weekly (ollama's own quota windows) and each
// record carries per-model weekly request counts. Absent file → the ollama
// rate-limit cards are omitted entirely (see _build_ollama_forecast).
const OLLAMA_USAGE_JSONL = path.join(SKILL_STATE_DIR, "ollama-usage.jsonl");
const OLLAMA_SERIES_CAP = 400; // max points in the report's trend series (strided, see _stride)
// Codex CLI weekly-quota history (written by codexIngest, see codex.mjs). Same
// snapshot shape as ollama-usage.jsonl but ONE gauge only ("weekly") — Codex
// Plus exposes a single 7-day rate-limit window, no five_hour/session pairing.
const CODEX_USAGE_JSONL = path.join(SKILL_STATE_DIR, "codex-usage.jsonl");
const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_API_BETA = "oauth-2025-04-20";
const USAGE_API_TIMEOUT_MS = 10000;
// Rate-limit forecast (Phase D). Empirical-Bayes fit persisted here; refit when
// stale (>7d or a newer transcript landed). Pure math lives in forecast.mjs.
const FORECAST_JSON = path.join(SKILL_STATE_DIR, "forecast.json");
// Nominal window lengths, per claumon forecast.service.go durationFor. Used as
// DurationHours in the rate prior (rho = uFinal / durationHours, percent/hour).
// ollama Cloud runs the same two window lengths on its own account quota, keyed
// session/weekly in ollama-usage.jsonl (what its settings page calls them).
const GAUGE_DUR_HOURS = { five_hour: 5, seven_day: 7 * 24, session: 5, weekly: 7 * 24 };
// Reports sit beside the state dir, so USAGE_REPORT_STATE relocates them too.
const REPORTS_DIR = path.join(path.dirname(SKILL_STATE_DIR), "reports");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const SCRIPT = fileURLToPath(import.meta.url);

const HEADER = "timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens," +
  "cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms," +
  "api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct," +
  "context_window_size,turns,tool_calls,start_epoch,facets_json,est_cost_usd";
const COLS = HEADER.split(",");
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// Built-in Claude Code CLI slash commands (NOT skills). A user-typed slash
// command whose name is in this set is not counted as a skill invocation.
// Everything else in a <command-name>/NAME</command-name> tag is treated as a
// skill (including plugin-namespaced names like "caveman:caveman" and retired
// skills no longer installed). Extend this set if a new CLI built-in leaks in.
const BUILTIN_CLI_COMMANDS = new Set([
  "add-dir", "agents", "bug", "clear", "compact", "config", "context", "copy",
  "cost", "dev", "doctor", "effort", "exit", "export", "fast", "get-started",
  "help", "hooks", "init", "login", "mcp", "memory", "model", "models",
  "permissions", "plugin", "plugins", "PR", "resume", "shortcuts", "status",
  "statusline", "terminal-setup", "voice", "workflows",
]);

// ---- fs helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function getmtime(p) {
  return fs.statSync(p).mtimeMs / 1000;
}

// Forward-slash bases for fs.globSync: on Windows a backslash in a glob pattern
// is an escape, so normalize the absolute base once. fs.globSync does the walk.
const PROJECTS_GLOB = PROJECTS_DIR.replace(/\\/g, "/");
const STATE_GLOB = STATE_DIR.replace(/\\/g, "/");

// ---- CSV (RFC 4180) ----

function parseCsv(text) {
  // Returns array of arrays of fields. Handles quoted fields with embedded
  // commas, newlines, and "" escapes.
  const rows = [];
  let field = "";
  let row = [];
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  let started = false;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      started = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      started = true;
      i++;
    } else if (ch === "\r") {
      // handle CRLF or lone CR as line break
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      i++;
      if (text[i] === "\n") i++;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      i++;
    } else {
      field += ch;
      started = true;
      i++;
    }
  }
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function* dictReader(text) {
  // Mirror csv.DictReader: first row is header, yields {col: value} objects.
  // Strip a UTF-8 BOM if present (utf-8-sig in Python).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCsv(text);
  if (!rows.length) return;
  const header = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    // skip fully blank rows (csv.DictReader skips blank lines)
    if (vals.length === 1 && vals[0] === "") continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = c < vals.length ? vals[c] : null;
    }
    yield obj;
  }
}

function _csv_field(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Build a COLS-ordered value array from a row object, asserting the object
// sets exactly the COLS keyset — catches a forgotten or misspelled column that
// would otherwise silently write "" (the `c in rowd ? rowd[c] : ""` fallback
// can't distinguish "intentionally blank" from "omitted by mistake"). Mismatch
// is logged to stderr, never thrown, so the SessionEnd hook can't block on it.
// Centralized so both row builders (record + backfill) route through one path.
function _row_array(rowd) {
  const got = Object.keys(rowd).sort().join(",");
  const want = COLS.slice().sort().join(",");
  if (got !== want) {
    const missing = COLS.filter((c) => !(c in rowd));
    const extra = Object.keys(rowd).filter((k) => !COLS.includes(k));
    console.error(`stats.mjs: row schema mismatch (missing=[${missing.join(",")}] extra=[${extra.join(",")}])`);
  }
  return COLS.map((c) => (c in rowd ? rowd[c] : ""));
}

// ---- general helpers ----

function* iter_jsonl(p) {
  let text;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch {
    return;
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

function epoch_from_iso(s) {
  if (!s) return null;
  const t = new Date(s.replace("Z", "+00:00")).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

function _dig(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = cur[k];
    if (cur === undefined) cur = null;
  }
  return cur;
}

function _extract_state(d) {
  return {
    cost: _dig(d, "cost", "total_cost_usd"),
    model_id: _dig(d, "model", "id") || "",
    model_display_name: _dig(d, "model", "display_name") || "",
    duration_ms: _dig(d, "cost", "total_duration_ms") || 0,
    api_duration_ms: _dig(d, "cost", "total_api_duration_ms") || 0,
    lines_added: _dig(d, "cost", "total_lines_added") || 0,
    lines_removed: _dig(d, "cost", "total_lines_removed") || 0,
    rl_5h_pct: _dig(d, "rate_limits", "five_hour", "used_percentage"),
    rl_7d_pct: _dig(d, "rate_limits", "seven_day", "used_percentage"),
    context_pct: _dig(d, "context_window", "used_percentage"),
    context_window_size: _dig(d, "context_window", "context_window_size"),
    raw: d,
  };
}

function read_cost_state(sid) {
  const j = path.join(STATE_DIR, `${sid}.json`);
  if (isFile(j)) {
    try {
      return _extract_state(JSON.parse(fs.readFileSync(j, "utf-8")));
    } catch (e) {
      // File present but unparseable — abnormal (statusline writes verbatim
      // JSON). Log so the dropped cost-state is diagnosable; fall through to
      // the no-state path. A missing file (no statusline) is silent below.
      console.error(`stats.mjs: corrupt cost-state for ${sid}: ${e && e.message}`);
    }
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtLocal(d) {
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

function now_local() {
  return fmtLocal(new Date());
}

function local_fmt(epoch) {
  if (epoch === null || epoch === undefined) return null;
  const d = new Date(epoch * 1000);
  return Number.isNaN(d.getTime()) ? null : fmtLocal(d);
}

function find_transcript(sid) {
  const hits = fs.globSync(`${PROJECTS_GLOB}/*/${sid}.jsonl`);
  return hits.length ? hits[0] : null;
}

function session_totals(sid, mainPath) {
  const base = parse_transcript(mainPath || find_transcript(sid));
  for (const p of fs.globSync(`${PROJECTS_GLOB}/*/${sid}/**/*.jsonl`)) {
    const s = parse_transcript(p);
    base.input_tokens += s.input_tokens;
    base.output_tokens += s.output_tokens;
    base.cache_read_tokens += s.cache_read_tokens;
    base.cache_creation_tokens += s.cache_creation_tokens;
    base.turns += s.turns;
    base.tool_calls += s.tool_calls;
    _merge_facets(base.facets, s.facets);
    if (s.end_epoch && (base.end_epoch === null || s.end_epoch > base.end_epoch)) {
      base.end_epoch = s.end_epoch;
    }
    if (s.start_epoch && (base.start_epoch === null || s.start_epoch < base.start_epoch)) {
      base.start_epoch = s.start_epoch;
    }
  }
  return base;
}

function _merge_facets(a, b) {
  for (const k of ["tools", "agents", "skills"]) {
    for (const [name, n] of Object.entries(b[k])) {
      a[k][name] = (a[k][name] || 0) + n;
    }
  }
  a.tool_errors += b.tool_errors;
  a.compactions += b.compactions;
  a.cwd = a.cwd || b.cwd;
  a.branch = a.branch || b.branch;
}

function _new_facets() {
  return { tools: {}, tool_errors: 0, agents: {}, skills: {}, compactions: 0, cwd: "", branch: "" };
}

// ---- transcript-totals cache (Phase A) ----
// stats.csv stays the rendered source of truth; this cache only avoids re-parsing
// unchanged transcripts during backfill/report. The `res` field mirrors the
// return shape of session_totals(). _dirty tracks whether a write is needed.
function _load_totals_cache() {
  if (!isFile(TOTALS_CACHE)) return { _v: TOTALS_CACHE_VERSION, sids: {}, _dirty: false };
  try {
    const c = JSON.parse(fs.readFileSync(TOTALS_CACHE, "utf-8"));
    if (!c || c._v !== TOTALS_CACHE_VERSION) {
      return { _v: TOTALS_CACHE_VERSION, sids: {}, _dirty: true };
    }
    c.sids = (c.sids && typeof c.sids === "object" && !Array.isArray(c.sids)) ? c.sids : {};
    c._dirty = false;
    return c;
  } catch {
    return { _v: TOTALS_CACHE_VERSION, sids: {}, _dirty: true };
  }
}

function _save_totals_cache(cache) {
  if (!cache._dirty) return;
  try {
    fs.writeFileSync(
      TOTALS_CACHE,
      JSON.stringify({ _v: cache._v, sids: cache.sids }),
      { encoding: "utf-8", mode: 0o600 }
    );
  } catch {
    /* non-fatal: a missed cache write just means re-parsing next time */
  }
}

function _same_sub_mtimes(a, b) {
  if (!a || !b) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

// session_totals with mtime-gated caching. `mainPath` (the main transcript for
// sid) is optional; when absent, find_transcript resolves it (and a missing
// transcript returns the empty uncached result, as session_totals does).
function _cached_session_totals(sid, mainPath, cache) {
  const main = mainPath || find_transcript(sid);
  if (!main) return session_totals(sid, null);
  const subPaths = fs.globSync(`${PROJECTS_GLOB}/*/${sid}/**/*.jsonl`);
  const mainM = getmtime(main);
  const subM = {};
  for (const p of subPaths) subM[p] = getmtime(p);
  const entry = cache.sids[sid];
  if (entry && entry.main_mtime === mainM && _same_sub_mtimes(entry.sub, subM)) {
    return entry.res;
  }
  const res = session_totals(sid, main);
  cache.sids[sid] = { main_mtime: mainM, sub: subM, res };
  cache._dirty = true;
  return res;
}

// Extract skill names from user-typed slash commands in a user message body.
// Slash invocations appear as <command-name>/NAME</command-name> text injected
// by the harness; built-in CLI commands are filtered out. Returns one skill
// name per tag (a single slash invocation emits exactly one tag).
function _skill_slash_invocations(content) {
  if (!content) return [];
  const texts = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b && typeof b === "object" && typeof b.text === "string").map((b) => b.text)
      : [];
  const out = [];
  for (const t of texts) {
    const re = /<command-name>\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)<\/command-name>/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const nm = m[1];
      if (!BUILTIN_CLI_COMMANDS.has(nm)) out.push(nm);
    }
  }
  return out;
}

function parse_transcript(p) {
  const r = {
    last_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    end_epoch: null,
    start_epoch: null,
    turns: 0,
    tool_calls: 0,
    facets: _new_facets(),
  };
  const fc = r.facets;
  if (!p || !isFile(p)) return r;
  let last_model_epoch = null;
  for (const o of iter_jsonl(p)) {
    if (o.isSidechain === true || o.isMeta === true) continue;
    if (o.cwd) fc.cwd = o.cwd;
    if (o.gitBranch) fc.branch = o.gitBranch;
    if (o.isCompactSummary === true) fc.compactions += 1;
    const ts = epoch_from_iso(o.timestamp);
    if (ts) {
      if (r.end_epoch === null || ts > r.end_epoch) r.end_epoch = ts;
      if (r.start_epoch === null || ts < r.start_epoch) r.start_epoch = ts;
    }
    const typ = o.type;
    if (typ === "user") {
      const c = (o.message || {}).content;
      const human =
        typeof c === "string" ||
        (Array.isArray(c) && c.some((b) => b && typeof b === "object" && b.type === "text"));
      if (human) r.turns += 1;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && typeof b === "object" && b.type === "tool_result" && b.is_error) {
            fc.tool_errors += 1;
          }
        }
      }
      for (const nm of _skill_slash_invocations(c)) {
        fc.skills[nm] = (fc.skills[nm] || 0) + 1;
      }
      continue;
    }
    if (typ !== "assistant") continue;
    const msg = o.message || {};
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_use") {
          r.tool_calls += 1;
          const name = b.name || "?";
          fc.tools[name] = (fc.tools[name] || 0) + 1;
          const inp = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
          if (name === "Agent") {
            const st = inp.subagent_type || "general-purpose";
            fc.agents[st] = (fc.agents[st] || 0) + 1;
          } else if (name === "Skill") {
            const sk = inp.command || inp.skill || "?";
            fc.skills[sk] = (fc.skills[sk] || 0) + 1;
          }
        }
      }
    }
    const tk = _msg_tokens(msg);
    if (!tk) continue;
    r.input_tokens += tk.i;
    r.output_tokens += tk.o;
    r.cache_read_tokens += tk.cr;
    r.cache_creation_tokens += tk.cc;
    if (tk.model && (last_model_epoch === null || (ts !== null && ts >= (last_model_epoch ?? -1)))) {
      if (ts !== null) {
        last_model_epoch = ts;
        r.last_model = tk.model;
      }
    }
  }
  return r;
}

// Extract token usage from an assistant message; null for synthetic/zero rows.
function _msg_tokens(msg) {
  const usage = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage) && msg.usage !== null
    ? msg.usage : {};
  const i = _inum(usage.input_tokens);
  const o = _inum(usage.output_tokens);
  const cr = _inum(usage.cache_read_input_tokens);
  const cc = _inum(usage.cache_creation_input_tokens);
  if (msg.model === "<synthetic>" || (i === 0 && o === 0 && cr === 0 && cc === 0)) return null;
  return { i, o, cr, cc, model: msg.model };
}


const PRICE = {
  opus: [5.0, 25.0, 0.5, 6.25],
  sonnet: [3.0, 15.0, 0.3, 3.75],
  haiku: [1.0, 5.0, 0.1, 1.25],
  fable: [10.0, 50.0, 1.0, 12.5],
  // Non-Anthropic models routed through CC (proxy/:cloud tags). Priced from
  // provider docs so their sessions (no billed total_cost_usd → est-only) attribute
  // correctly. _price_key does substring match in insertion order — keep the more
  // specific glm-5.2/glm-5.1 ABOVE glm-5 so "glm-5.2:cloud" matches 5.2, not 5.
  // cache_create=0: GLM cache-write "limited-time free" (docs.z.ai); Kimi K3 has
  // no cache-write fee (cache_read=0.30 is the 90% cache-hit discount). Kimi K2.7
  // Code DOES charge cache_write=0.19 with no cache-read discount. Bump if promos end.
  "glm-5.2": [1.4, 4.4, 0.26, 0.0], // docs.z.ai/guides/overview/pricing
  "glm-5.1": [1.4, 4.4, 0.26, 0.0], // docs.z.ai
  "glm-5": [1.0, 3.2, 0.2, 0.0], // docs.z.ai
  "kimi-k3": [3.0, 15.0, 0.0, 0.30], // kimi.com/resources/kimi-k3-pricing
  "kimi-k2.7-code": [0.95, 4.0, 0.19, 0.0], // kimi.com/resources/kimi-k2-7-code-pricing
  // GPT-5.6 (openai.com/api/pricing; via claude-code wiki sources/openai-api-pricing
  // #flagship-models). 3 tiers only — no pro/mini/nano. cache_read=0.1×in,
  // cache_create=1.25×in. Substring match: keep the 3 specific keys here; a
  // generic "gpt-5.6" key added later must go BELOW these or it shadows them.
  "gpt-5.6-sol": [5.0, 30.0, 0.50, 6.25],
  "gpt-5.6-terra": [2.0, 12.0, 0.20, 2.50],
  "gpt-5.6-luna": [0.20, 1.20, 0.02, 0.25],
  // codex-auto-review is Codex CLI's internal reviewer thread (see codex.mjs) —
  // no public rate exists for it, so it's priced as an alias of gpt-5.6-terra
  // (mid GPT-5.6 tier) per user decision. Distinct key, no substring overlap
  // with any key above, so _price_key's ordered scan can't shadow or be shadowed.
  "codex-auto-review": [2.0, 12.0, 0.20, 2.50],
  // GPT-5.6 bare id and the GPT-5.4 family (openai.com/api/pricing, cross-checked
  // against ~/wiki/claude-code/sources/openai-api-pricing.md 2026-07-31). Bare
  // "gpt-5.6" MUST stay below the three suffixed gpt-5.6-* keys above — a model
  // string like "gpt-5.6-sol" includes "gpt-5.6" too, so listing the bare key
  // first would have it win the ordered scan and shadow all three (see their
  // comment). Within the 5.4 family the suffixed keys (mini/nano/pro) must
  // likewise precede the bare "gpt-5.4" — "gpt-5.4-mini".includes("gpt-5.4")
  // is true, so a bare key listed first would shadow all three.
  "gpt-5.6": [2.0, 12.0, 0.20, 2.50], // bare id → Terra rate, per user decision
  "gpt-5.4-mini": [0.75, 4.50, 0.075, 0.0],
  "gpt-5.4-nano": [0.20, 1.25, 0.02, 0.0],
  "gpt-5.4-pro": [30.0, 180.0, 0.0, 0.0], // no cached-input rate published
  // cache_create=0 for the whole 5.4 family: unlike GPT-5.6 (cache writes =
  // 1.25x input), the 5.4 rows publish no cache-write fee.
  "gpt-5.4": [2.50, 15.0, 0.25, 0.0], // keep BELOW the three 5.4 keys above
};
const DEFAULT_PRICE_KEY = "opus";

// Long-context tier mechanism: if a model bills input-side tokens at a higher
// rate above a token threshold, put [input, output, cache_read, cache_create]
// $/MTok in PRICE_ABOVE under its key. Applied per API call, never on summed
// session tokens (cache_read accumulates across turns and would spuriously
// trip it). Empty by default: as of the current lineup NO Claude model has a
// >200k premium — Fable/Opus/Sonnet all bill the full 1M window at standard
// rates (per claude.com/pricing#api). Kept as a mechanism so a tier can be
// re-added via pricing.json `above_200k` if Anthropic reintroduces one.
let LONG_CTX_THRESHOLD = 200000;
// GPT-5.6 long-context tier (>200k input-side tokens), same source as PRICE
// above (openai.com/api/pricing #flagship-models long-context). 2× short-ctx
// input/output, cache_read=0.1×in, cache_create=1.25×in. Applied per request in
// _msg_cost_tiered when i+cr+cc > LONG_CTX_THRESHOLD (200k, OpenAI's cutoff).
const PRICE_ABOVE = {
  "gpt-5.6-sol": [10.0, 45.0, 1.0, 12.5],
  "gpt-5.6-terra": [4.0, 18.0, 0.40, 5.0],
  "gpt-5.6-luna": [0.40, 1.80, 0.04, 0.50],
  // codex-auto-review aliases gpt-5.6-terra here too — same no-public-rate
  // reasoning as PRICE above.
  "codex-auto-review": [4.0, 18.0, 0.40, 5.0],
  // Bare gpt-5.6 = Terra long-ctx rate (mirrors its PRICE alias above). 5.4-mini
  // and 5.4-nano have no published long-context row, so they're absent here and
  // correctly fall back to their standard PRICE rate. gpt-5.4/gpt-5.4-pro's own
  // long-context cutoff isn't published (GPT-5.4 has a 272k window, wider than
  // GPT-5.6's) — reusing the single global LONG_CTX_THRESHOLD (200k) is the lazy
  // default rather than adding a per-key threshold mechanism; costs nothing
  // today since no gpt-5.4 rows exist on disk yet. ponytail: revisit the
  // threshold if/when real gpt-5.4 usage shows up and OpenAI publishes its cutoff.
  "gpt-5.6": [4.0, 18.0, 0.40, 5.0],
  "gpt-5.4-pro": [30.0, 135.0, 0.0, 0.0],
  "gpt-5.4": [5.0, 22.50, 0.50, 0.0],
};

// Optional pricing override so rates can be bumped without editing this file:
// ~/.agents/.harness-usage-report/state/pricing.json. Shape (all optional):
//   { "base": { "opus": [in, out, cache_read, cache_create], ... },
//     "above_200k": { "sonnet": [in, out, cache_read, cache_create], ... },
//     "long_context_threshold": 200000 }
// A bare { "opus": [...], ... } map is accepted as base overrides. Only 4-number
// rate arrays are honored; malformed/unreadable files are ignored silently.
const PRICE_OVERRIDE_JSON = path.join(SKILL_STATE_DIR, "pricing.json");

// Phase F: live pricing refresh. Layered resolve (lowest → highest priority):
//   embedded PRICE → pricing-cache.json (if <24h, from `fetch-pricing --oauth`)
//   → PROMOS (time-bounded intro rates, in-window) → manual pricing.json override.
// Network only on explicit `fetch-pricing --oauth` (same gate as fetch-usage); the
// module-load resolve stays local. Cache shape: {updated, base:{<family>:[4-array]}}.
const PRICING_CACHE_JSON = path.join(SKILL_STATE_DIR, "pricing-cache.json");
const PRICING_REMOTE_URL = "https://raw.githubusercontent.com/fabioconcina/claumon/main/pricing.json";
const PRICING_FETCH_TIMEOUT_MS = 10000;
const PRICING_CACHE_MAX_AGE_S = 24 * 3600;
// Known time-bounded intro rates the embedded table doesn't carry. Applied at load
// when today ≤ expires (after cache, before manual override). Closes the SKILL.md
// gap "Sonnet 5 intro pricing ($2/$10 to 2026-08-31) is not reflected".
const PROMOS = [
  { family: "sonnet", rates: [2.0, 10.0, 0.2, 2.5], expires: "2026-08-31" },
];

function _is_rate(a) {
  return Array.isArray(a) && a.length === 4 && a.every((x) => typeof x === "number" && Number.isFinite(x));
}

// Merge a family→4-array map into PRICE (validated; unknown families ignored).
function _merge_price_base(base) {
  if (!base || typeof base !== "object") return;
  for (const [k, v] of Object.entries(base)) {
    if (_is_rate(v) && PRICE[k] !== undefined) PRICE[k] = v.slice();
  }
}

function _load_pricing_cache() {
  if (!isFile(PRICING_CACHE_JSON)) return null;
  let c;
  try { c = JSON.parse(fs.readFileSync(PRICING_CACHE_JSON, "utf-8")); } catch { return null; }
  if (!c || typeof c !== "object") return null;
  // Freshness: mtime-based (the fetcher stamps `updated` too, but mtime is exact).
  if (Date.now() / 1000 - getmtime(PRICING_CACHE_JSON) > PRICING_CACHE_MAX_AGE_S) return null;
  return c;
}

function _promo_active(p) {
  if (!p.expires) return true;
  const d = new Date(p.expires + "T23:59:59");
  return Number.isNaN(d.getTime()) ? false : Date.now() <= d.getTime();
}

function _apply_price_overrides() {
  // 1. live-pricing cache (if fresh)
  const cache = _load_pricing_cache();
  if (cache) _merge_price_base(cache.base);
  // 2. time-bounded promos (win over cache while in-window)
  for (const p of PROMOS) {
    if (_promo_active(p) && _is_rate(p.rates) && PRICE[p.family] !== undefined) {
      PRICE[p.family] = p.rates.slice();
    }
  }
  // 3. manual override (always wins)
  if (!isFile(PRICE_OVERRIDE_JSON)) return;
  let ov;
  try { ov = JSON.parse(fs.readFileSync(PRICE_OVERRIDE_JSON, "utf-8")); } catch { return; }
  if (!ov || typeof ov !== "object" || Array.isArray(ov)) return;
  const bare = !ov.base && !ov.above_200k && !("long_context_threshold" in ov);
  const base = ov.base && typeof ov.base === "object" ? ov.base : (bare ? ov : null);
  if (base) for (const [k, v] of Object.entries(base)) if (_is_rate(v) && PRICE[k] !== undefined) PRICE[k] = v.slice();
  if (ov.above_200k && typeof ov.above_200k === "object") {
    for (const [k, v] of Object.entries(ov.above_200k)) if (_is_rate(v)) PRICE_ABOVE[k] = v.slice();
  }
  if (typeof ov.long_context_threshold === "number" && ov.long_context_threshold > 0) {
    LONG_CTX_THRESHOLD = ov.long_context_threshold;
  }
}
_apply_price_overrides();

export function _price_key(model) {
  const m = (model || "").toLowerCase();
  for (const k of Object.keys(PRICE)) {
    if (m.includes(k)) return k;
  }
  return DEFAULT_PRICE_KEY;
}

// Anthropic-family price keys. Any other PRICE key (glm/kimi/…) is a third-party
// model reached via a proxy or :cloud tag: Claude Code's billed total_cost_usd
// for those uses the wrong rates, so the report recomputes cost from tokens with
// the PRICE table instead. Unknown models resolve to DEFAULT_PRICE_KEY (opus, an
// Anthropic key) → treated as Anthropic, never overridden.
const _ANTHROPIC_PRICE_KEYS = new Set(["opus", "sonnet", "haiku", "fable"]);
function _is_third_party(model) {
  return !_ANTHROPIC_PRICE_KEYS.has(_price_key(model));
}

function _msg_cost(model, i, o, cr, cc) {
  const [inp, out, crp, ccp] = PRICE[_price_key(model)];
  return (i * inp + o * out + cr * crp + cc * ccp) / 1e6;
}

// Per-message cost with the long-context tier applied when this request's
// input-side tokens exceed the threshold. Use for absolute cost estimation.
function _msg_cost_tiered(model, i, o, cr, cc) {
  const above = PRICE_ABOVE[_price_key(model)];
  if (above && i + cr + cc > LONG_CTX_THRESHOLD) {
    return (i * above[0] + o * above[1] + cr * above[2] + cc * above[3]) / 1e6;
  }
  return _msg_cost(model, i, o, cr, cc);
}

// Sum assistant-message cost for one transcript file (per message so the
// long-context tier applies at request granularity). `includeSidechain` flips
// the isSidechain filter: the main transcript inlines sidechain echoes (skip
// them), but a subagent-run transcript IS the sidechain — every row is marked
// isSidechain relative to the parent, so include them there.
function _transcript_msg_cost(p, includeSidechain = false) {
  if (!p || !isFile(p)) return 0;
  let usd = 0;
  for (const o of iter_jsonl(p)) {
    if (!includeSidechain && o.isSidechain === true) continue;
    if (o.isMeta === true) continue;
    if (o.type !== "assistant") continue;
    const tk = _msg_tokens(o.message || {});
    if (!tk) continue;
    usd += _msg_cost_tiered(tk.model, tk.i, tk.o, tk.cr, tk.cc);
  }
  return usd;
}

// Approximate a session's cost from transcript tokens, for sessions with no
// billed cost captured (no statusline). Main transcript + each subagent-run
// transcript, summed per assistant message so the long-context tier applies at
// request granularity (Phase G: subagent tokens folded in so est_cost_usd isn't
// a floor). Billed-cost sessions are unaffected — total_cost_usd wins in the
// report.
function computed_cost_from_transcript(p) {
  if (!p || !isFile(p)) return 0;
  let usd = _transcript_msg_cost(p, false);
  const sid = path.basename(p, ".jsonl");
  if (sid && sid !== ZERO_UUID) {
    for (const sp of fs.globSync(`${PROJECTS_GLOB}/*/${sid}/**/*.jsonl`)) {
      usd += _transcript_msg_cost(sp, true);
    }
  }
  return usd;
}

// ---- record (live SessionEnd hook) ----

function _blank(v) {
  return v === null || v === undefined ? "" : v;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function cmd_record() {
  let data;
  try {
    data = JSON.parse(readStdin() || "{}");
  } catch (e) {
    // Abnormal: SessionEnd fired with a malformed payload. Log so it's
    // diagnosable; exit 0 so the hook never blocks.
    console.error(`stats.mjs record: bad stdin JSON: ${e && e.message}`);
    process.exit(0);
  }
  const sid = data.session_id;
  if (!sid || sid === ZERO_UUID || !/^[0-9a-fA-F-]{1,64}$/.test(sid)) {
    console.error(`stats.mjs record: bad session_id: ${sid}`);
    process.exit(0);
  }
  const state = read_cost_state(sid);
  // No state / no cost = no statusline wired (or a $0 session). Normal early
  // exit per the capture contract — stay silent to avoid spamming every
  // SessionEnd for statusline-less setups.
  if (!state || state.cost === null || state.cost === undefined || state.cost === "") process.exit(0);
  const t = session_totals(sid);
  let dur = _inum(state.duration_ms);
  if (!dur && t.start_epoch && t.end_epoch) {
    dur = Math.trunc((t.end_epoch - t.start_epoch) * 1000);
  }
  const rowd = {
    timestamp: now_local(),
    session_id: sid,
    total_cost_usd: state.cost,
    last_model: t.last_model,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read_tokens: t.cache_read_tokens,
    cache_creation_tokens: t.cache_creation_tokens,
    model_id: state.model_id || "",
    model_display_name: state.model_display_name || "",
    duration_ms: dur,
    api_duration_ms: _inum(state.api_duration_ms),
    lines_added: _inum(state.lines_added),
    lines_removed: _inum(state.lines_removed),
    rl_5h_pct: _blank(state.rl_5h_pct),
    rl_7d_pct: _blank(state.rl_7d_pct),
    context_pct: _blank(state.context_pct),
    context_window_size: _blank(state.context_window_size),
    turns: t.turns,
    tool_calls: t.tool_calls,
    start_epoch: t.start_epoch ? Math.trunc(t.start_epoch) : "",
    facets_json: JSON.stringify(t.facets),
    est_cost_usd: "",
  };
  _prepend_row(rowd);
  if (state.raw !== null && state.raw !== undefined) _archive(sid, state.raw);
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${sid}.json`));
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function _archive(sid, raw) {
  try {
    const rec = { recorded_at: now_local(), session_id: sid, statusline: raw };
    fs.appendFileSync(SESSIONS_JSONL, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function _prepend_row(rowd) {
  const line = _row_array(rowd).map((x) => _csv_field(x)).join(",");
  if (!isFile(STATS_CSV)) {
    fs.writeFileSync(STATS_CSV, HEADER + "\n" + line + "\n", { encoding: "utf-8", mode: 0o600 });
    return;
  }
  let text = fs.readFileSync(STATS_CSV, "utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  // splitlines() drops a trailing empty string from a final newline
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let rest;
  if (lines.length && lines[0].trim() !== HEADER) {
    rest = lines;
  } else {
    rest = lines.length > 1 ? lines.slice(1) : [];
  }
  const out = [HEADER, line, ...rest.filter((l) => l.trim())];
  fs.writeFileSync(STATS_CSV, out.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
}

// ---- backfill ----

// Rebuild stats.csv from all transcripts. Folds in any lingering cost-state
// snapshot (a session whose SessionEnd hook hasn't projected it yet) so its
// cost/duration/lines/rate-limits/context land in the row. `excludeSid` (the
// active session) is skipped entirely — its transcript is mid-flight.
function _rebuild_stats_csv(excludeSid, files) {
  const existing = {};
  if (isFile(STATS_CSV)) {
    const text = fs.readFileSync(STATS_CSV, "utf-8");
    for (const row of dictReader(text)) {
      const sid = (row.session_id || "").trim();
      if (!sid || sid === ZERO_UUID) continue;
      const prev = existing[sid];
      if (prev && (prev.total_cost_usd || "").trim() && !(row.total_cost_usd || "").trim()) {
        continue;
      }
      existing[sid] = row;
    }
  }

  const fwd = (ex, col) => (ex ? ex[col] || "" : "");

  const rows = [];
  const seen = new Set();
  let with_cost = 0;
  const cache = _load_totals_cache();
  for (const p of (files || fs.globSync(`${PROJECTS_GLOB}/*/*.jsonl`))) {
    const sid = path.basename(p, ".jsonl");
    if (sid === ZERO_UUID || sid === excludeSid) continue;
    seen.add(sid);
    const ex = existing[sid] || {};
    const t = _cached_session_totals(sid, p, cache);
    const st = read_cost_state(sid);
    const stCost = st && st.cost !== null && st.cost !== undefined && st.cost !== "" ? String(st.cost) : "";
    const cost = (ex.total_cost_usd || "").trim() || stCost;
    if (cost) with_cost += 1;
    // Token-estimated cost for sessions with no billed cost (no statusline).
    // Kept in a separate column so billed cost is never mixed with estimates.
    // Recomputed each backfill for
    // no-billed sessions (Phase G: subagent tokens folded in, so the estimate
    // stays current as the fold / pricing logic changes). Billed sessions skip
    // it entirely — total_cost_usd wins in the report.
    let estCost = "";
    if (!cost) {
      const c = computed_cost_from_transcript(p);
      if (c > 0) estCost = c.toFixed(4);
    }
    const fbNum = (exCol, stKey) => _inum(fwd(ex, exCol)) || (st ? _inum(st[stKey]) : 0);
    const fbRaw = (exCol, stKey) => {
      const ev = fwd(ex, exCol);
      return ev !== "" ? ev : st ? _blank(st[stKey]) : "";
    };
    let dur = fbNum("duration_ms", "duration_ms");
    if (!dur && t.start_epoch && t.end_epoch) {
      dur = Math.trunc((t.end_epoch - t.start_epoch) * 1000);
    }
    const ts =
      (ex.timestamp || "").trim() ||
      local_fmt(t.end_epoch) ||
      local_fmt(getmtime(p)) ||
      "";
    rows.push({
      timestamp: ts || "",
      session_id: sid,
      total_cost_usd: cost,
      last_model: t.last_model,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cache_read_tokens: t.cache_read_tokens,
      cache_creation_tokens: t.cache_creation_tokens,
      model_id: fwd(ex, "model_id") || (st ? st.model_id : "") || t.last_model,
      model_display_name: fwd(ex, "model_display_name") || (st ? st.model_display_name : ""),
      duration_ms: dur,
      api_duration_ms: fbNum("api_duration_ms", "api_duration_ms"),
      lines_added: fbNum("lines_added", "lines_added"),
      lines_removed: fbNum("lines_removed", "lines_removed"),
      rl_5h_pct: fbRaw("rl_5h_pct", "rl_5h_pct"),
      rl_7d_pct: fbRaw("rl_7d_pct", "rl_7d_pct"),
      context_pct: fbRaw("context_pct", "context_pct"),
      context_window_size: fbRaw("context_window_size", "context_window_size"),
      turns: t.turns,
      tool_calls: t.tool_calls,
      start_epoch: t.start_epoch ? Math.trunc(t.start_epoch) : "",
      facets_json: JSON.stringify(t.facets),
      est_cost_usd: estCost,
    });
  }
  // Fold in Codex CLI rollouts (own ingest path — no statusline/hook drives
  // this, so `report`/`backfill` are the only trigger). Never let a Codex
  // failure block stats.csv for a user who may not even use Codex: on error
  // the pre-existing Codex rows (already in `existing`) simply fall through to
  // the carry-forward loop below and are re-emitted verbatim.
  try {
    const { rows: codexRows } = codexIngest({
      stateDir: SKILL_STATE_DIR, localFmt: local_fmt, epochFromIso: epoch_from_iso,
      msgCostTiered: _msg_cost_tiered, priceKey: _price_key,
    });
    for (const r of codexRows) {
      rows.push(r);
      seen.add(r.session_id);
      if ((r.total_cost_usd || "").trim()) with_cost += 1;
    }
  } catch (e) {
    console.error(`stats.mjs: Codex ingest failed: ${e && e.message}`);
  }
  for (const [sid, ex] of Object.entries(existing)) {
    if (seen.has(sid) || sid === excludeSid) continue;
    if ((ex.total_cost_usd || "").trim()) with_cost += 1;
    const r = {};
    for (const c of COLS) r[c] = ex[c] || "";
    rows.push(r);
  }
  // Sort by timestamp string descending (Array.sort is stable since ES2019).
  rows.sort((a, b) => {
    const av = a.timestamp || "";
    const bv = b.timestamp || "";
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  const out_lines = [HEADER];
  for (const r of rows) {
    out_lines.push(_row_array(r).map((v) => _csv_field(v)).join(","));
  }
  fs.writeFileSync(STATS_CSV, out_lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  // Now that snapshots are folded into stats.csv, clear their staging files —
  // mirroring `record`: archive the raw statusline to sessions.jsonl, then
  // unlink. Only remove a snapshot whose sid actually landed in the written CSV
  // (so a snapshot with no transcript and no row isn't dropped unmerged), and
  // never touch the excluded active session's file (its data was skipped).
  const written = new Set(rows.map((r) => r.session_id));
  let removed = 0;
  for (const p of fs.globSync(`${STATE_GLOB}/*.json`)) {
    const sid = path.basename(p, ".json");
    if (sid === excludeSid || !written.has(sid)) continue;
    const st = read_cost_state(sid);
    if (st && st.raw !== null && st.raw !== undefined) _archive(sid, st.raw);
    try {
      fs.unlinkSync(p);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  _save_totals_cache(cache);
  return { sessions: rows.length, with_cost, no_cost: rows.length - with_cost, cleared: removed };
}

function cmd_backfill() {
  print(JSON.stringify(_rebuild_stats_csv(null)));
}

// ---- report: numeric helpers ----

function _fnum(v) {
  if (v === null || v === undefined || v === "") return 0.0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0.0 : f;
}

function _inum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0 : Math.trunc(f);
}

// ---- report (HTML) ----

export function _load_stats(csvPath = STATS_CSV) {
  // render() consumes only c.sessions (each with .facets); the client re-derives
  // day/month/model aggregates from the embedded payload. totals.sessions + usage
  // (tool/agent/skill tallies) are kept for the sibling improve.mjs roadmap.
  const sessions = [];
  const usage = { tools: {}, agents: {}, skills: {} };
  const text = fs.readFileSync(csvPath, "utf-8");
  for (const row of dictReader(text)) {
    const ts = (row.timestamp || "").trim();
    if (ts === "timestamp" || (row.total_cost_usd || "").trim() === "total_cost_usd") continue;
    const i = _inum(row.input_tokens);
    const o = _inum(row.output_tokens);
    const cr = _inum(row.cache_read_tokens);
    const cc = _inum(row.cache_creation_tokens);
    const dt = parseDateTime(ts);
    let facets = null;
    const fj = row.facets_json;
    if (fj) {
      try {
        facets = JSON.parse(fj);
        for (const kk of ["tools", "agents", "skills"]) {
          for (const [nm, cnt] of Object.entries(facets[kk] || {})) {
            usage[kk][nm] = (usage[kk][nm] || 0) + cnt;
          }
        }
      } catch {
        facets = null;
      }
    }
    sessions.push({
      ts,
      sid: (row.session_id || "").trim(),
      // Third-party rows: prefer est_cost_usd (per-call, per-model, tiered —
      // codexIngest folds up to 19 threads mixing models into one session row)
      // over recomputing from summed tokens at last_model's rate alone.
      cost: _is_third_party(row.last_model)
        ? (_fnum(row.est_cost_usd) || _msg_cost(row.last_model, i, o, cr, cc))
        : (_fnum(row.total_cost_usd) || _fnum(row.est_cost_usd)),
      model: (row.last_model || "").trim(),
      disp: (row.model_display_name || "").trim(),
      in: i, out: o, cr, cc, tok: i + o + cr + cc,
      dur: _inum(row.duration_ms),
      api: _inum(row.api_duration_ms),
      la: _inum(row.lines_added),
      lr: _inum(row.lines_removed),
      rl5: _fnum(row.rl_5h_pct),
      rl7: _fnum(row.rl_7d_pct),
      turns: _inum(row.turns),
      tools: _inum(row.tool_calls),
      hour: dt ? dt.getHours() : null,
      dow: dt ? jsWeekdayPy(dt) : null,
      facets,
    });
  }
  return { sessions, totals: { sessions: sessions.length }, usage };
}

function parseDateTime(ts) {
  // datetime.strptime(ts, "%Y-%m-%d %H:%M:%S") — strict; returns null on mismatch.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function jsWeekdayPy(d) {
  // Python datetime.weekday(): Mon=0..Sun=6. JS getDay(): Sun=0..Sat=6.
  return (d.getDay() + 6) % 7;
}

// ---- report freshness ----
// Active-session detection (Phase I). A session is active — mid-flight, excluded
// from the report so its incomplete transcript never pollutes it — iff its
// cost-state/<sid>.json is present AND fresh. The statusline writes cost-state on
// each render and `record` (SessionEnd) deletes it, so a recent cost-state = live;
// a stale lingering cost-state = hook-missed (crash) → fold it in, as before.
// Cost-state mtime tracks statusline activity, which outlives transcript writes
// across a mid-session pause (transcript mtime only advances on new messages), so
// it correctly classifies a paused-but-live session that the old 180s
// transcript-mtime window mislabeled as closed. Fall back to the transcript-mtime
// window only when no cost-state exists at all (no statusline wired). getmtime
// returns seconds.
function _ensure_fresh() {
  const COST_WIN = 900; // cost-state liveness window (tolerates a mid-session pause)
  const TX_WIN = 180;   // transcript-mtime fallback window (no statusline case)
  const now = Date.now() / 1000;
  const jsonl = fs.globSync(`${PROJECTS_GLOB}/*/*.jsonl`);
  const stateFiles = fs.globSync(`${STATE_GLOB}/*.json`);

  let active = null;
  if (stateFiles.length) {
    // Primary: the freshest cost-state within the liveness window is the live sid.
    let newest = 0, newestSid = null;
    for (const p of stateFiles) {
      const m = getmtime(p);
      if (m > newest) { newest = m; newestSid = path.basename(p, ".json"); }
    }
    if (newestSid && now - newest < COST_WIN) active = newestSid;
  } else {
    // Fallback: no cost-state (no statusline) — old transcript-mtime heuristic.
    let newest = 0, newestSid = null;
    for (const p of jsonl) {
      const m = getmtime(p);
      if (m > newest) { newest = m; newestSid = path.basename(p, ".jsonl"); }
    }
    if (newestSid && now - newest < TX_WIN) active = newestSid;
  }

  const csvMtime = isFile(STATS_CSV) ? getmtime(STATS_CSV) : 0;
  let need = csvMtime === 0;
  if (!need) {
    const scan = [
      ...jsonl.map((p) => [path.basename(p, ".jsonl"), getmtime(p)]),
      ...stateFiles.map((p) => [path.basename(p, ".json"), getmtime(p)]),
    ];
    for (const [sid, m] of scan) {
      if (sid === active) continue;
      if (m > csvMtime) { need = true; break; }
    }
    // Codex rollouts carry no session id here (mtime-only scan, see
    // codexMtimes) — compare max-mtime instead of per-sid. Exclude anything
    // within TX_WIN like the transcript fallback above: an open Codex session's
    // rollout keeps getting touched, and without this exclusion it would force
    // a full rebuild on every single `report` for as long as it stays open.
    if (!need) {
      for (const m of codexMtimes()) {
        if (now - m < TX_WIN) continue;
        if (m > csvMtime) { need = true; break; }
      }
    }
  }
  if (need) _rebuild_stats_csv(active, jsonl);
}

function cmd_report() {
  _ensure_fresh();
  // Refresh the OAuth usage snapshot (5h/7d gauges) each run, best-effort.
  // Appends to usage-snapshots.jsonl (consumed by the rate-limit forecast).
  // Only when creds are present (logged in) so it's a silent no-op when logged
  // out. Runs as a child (its exit(0)/stderr can't affect the report); --oauth
  // bypasses the env gate so no USAGE_REPORT_OAUTH=1 is needed per run.
  if (_read_access_token()) {
    try {
      execFileSync(process.execPath, [SCRIPT, "fetch-usage", "--oauth", "--save"],
        { stdio: "ignore" });
    } catch { /* best-effort: network/auth failure leaves the prior snapshot */ }
  }
  if (!isFile(STATS_CSV)) {
    print(`stats.csv not found at ${STATS_CSV}. Run \`node ${SCRIPT} backfill\` first.`);
    process.exit(1);
  }
  const c = _load_stats();
  // Lazy-rebuild the rate-limit forecast (Phase D) so render.mjs embeds a fresh
  // fit. Pass the loaded sessions for the statusline-rl fallback when OAuth is off.
  c.forecast = _load_forecast(c.sessions);
  const html_doc = render(c);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const out = path.join(REPORTS_DIR, `report-${reportStamp(new Date())}.html`);
  fs.writeFileSync(out, html_doc, { encoding: "utf-8", mode: 0o600 });
  print(String(out));
  _open_report(out);
}

function reportStamp(d) {
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  );
}

function _open_report(p) {
  // execFileSync (array args, no shell) so a path containing shell/cmd
  // metacharacters — e.g. a Windows username with `&` — can't be reinterpreted.
  // On win32 the default browser is opened via rundll32's FileProtocolHandler
  // rather than `cmd /c start`, which does not follow Node's arg quoting.
  try {
    const name = process.env.USAGE_REPORT_BROWSER;
    if (process.platform === "win32") {
      if (name) execFileSync(name, [p], { stdio: "ignore" });
      else execFileSync("rundll32", ["url.dll,FileProtocolHandler", p], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execFileSync("open", name ? ["-a", name, p] : [p], { stdio: "ignore" });
    } else {
      execFileSync(name || "xdg-open", [p], { stdio: "ignore" });
    }
  } catch {
    /* best-effort */
  }
}

// ---- fetch-usage (OAuth usage API; off by default) ----
// Mirrors claumon internal/api/usage.go + internal/auth/credentials.go. Single
// request, 10s timeout, no retry loop, no token logging. Gated behind
// USAGE_REPORT_OAUTH=1 / --oauth; without it this is a silent no-op so the
// skill's local-only default is preserved. Snapshot schema (Phase C/D consume):
//   { fetched_at, five_hour, seven_day, per_model:{sonnet,opus,design}, extra_usage, raw }

function _oauth_enabled(args) {
  return args && args.oauth ? true : process.env.USAGE_REPORT_OAUTH === "1";
}

function _read_access_token() {
  if (!isFile(CREDENTIALS_PATH)) return null;
  let f;
  try {
    f = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return null;
  }
  const tok = f && f.claudeAiOauth && f.claudeAiOauth.accessToken;
  return typeof tok === "string" && tok ? tok : null;
}

// Normalize the raw API body into the snapshot shape. Unknown/absent windows → null.
// ---- rate-limit forecast (Phase D) ----
// Assembles OAuth usage-snapshots into per-gauge completed windows + the open
// window, fits the empirical-Bayes prior + calibration (forecast.mjs), runs the
// projection, and persists state/forecast.json. Refit lazily: when the file is
// missing, >7d old, or usage-snapshots.jsonl has new data since the last fit.
// Falls back to a prior-only fit from statusline rl_5h_pct/rl_7d_pct when OAuth
// polling is off — no open window to project then, but the rate prior still
// renders so the panel isn't blank for local-only users.

// RFC3339 → epoch seconds; null when unparseable.
function _parse_reset_at(s) {
  if (s == null || s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

// NormalizeResetAt (mirrors claumon store/forecast.go): round to nearest minute,
// canonical UTC string so snapshots from one drifting window group together.
function _normalize_reset_at(s) {
  const e = _parse_reset_at(s);
  if (e == null) return s || "";
  const rounded = Math.round(e / 60) * 60;
  return new Date(rounded * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// fetched_at is local "YYYY-MM-DD HH:MM:SS" (now_local/parseDateTime use local
// time). → epoch seconds in the same local interpretation.
function _fetched_epoch(rec) {
  const d = parseDateTime(rec.fetched_at);
  return d ? Math.floor(d.getTime() / 1000) : null;
}

// Read usage-snapshots.jsonl into memory; skip malformed lines. Returns [] when
// the file is absent (OAuth off / no fetch yet).
function _load_usage_snapshots(p = USAGE_SNAPSHOTS_JSONL) {
  if (!isFile(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* drop corrupt line */ }
  }
  return out;
}

// Group snapshots into per-gauge windows keyed by normalized resets_at. Each
// window = {resetSec, resetsAtCanon, snaps:[{t,u}], uFinal}. The open window is
// the one whose reset is in the future (max resetSec > now); the rest completed.
function _gauge_windows(snaps, gauge) {
  const byReset = new Map();
  for (const rec of snaps) {
    const w = rec[gauge];
    if (!w || w.utilization == null || w.resets_at == null) continue;
    const t = _fetched_epoch(rec);
    if (t == null) continue;
    const canon = _normalize_reset_at(w.resets_at);
    const resetSec = _parse_reset_at(w.resets_at);
    if (resetSec == null) continue;
    let win = byReset.get(canon);
    if (!win) { win = { resetSec, resetsAtCanon: canon, snaps: [] }; byReset.set(canon, win); }
    win.snaps.push({ t, u: Number(w.utilization) });
  }
  const windows = [];
  for (const win of byReset.values()) {
    win.snaps.sort((a, b) => a.t - b.t);
    win.uFinal = win.snaps.reduce((m, s) => Math.max(m, s.u), 0);
    windows.push(win);
  }
  windows.sort((a, b) => a.resetSec - b.resetSec);
  return windows;
}

// ---- window balance: the 5h:7d exchange rate (Phase H) ----
// r = Sum(delta 5h%) / delta 7d%, measured INSIDE one weekly window: how much 5h
// capacity a unit of weekly budget costs. Structurally r ~= L7/L5 (ratio of the two
// budget sizes), so it STEPS on plan/limit changes rather than drifting — the trend
// is a regime-change detector, not a daily metric. Bucketed per 7d reset window,
// never per calendar day/week: a day carries too little delta-7d to divide by
// (1%-granular gauge), and a calendar week straddles the reset boundary.
//
// Both sums are LOWER bounds under sparse polling — an unobserved 5h window adds 0
// to Sum(delta 5h) while its usage still lands in delta 7d (7d is monotone inside a
// window) — so r is biased low. `coverage` = share of the WHOLE weekly window (not
// just the observed span) that sits within 5h of a snapshot; 1.0 means no 5h window
// could have gone unseen. Measured against the nominal window so that two snapshots
// a minute apart score ~0, not 1.
const WB_MIN_COVERAGE = 0.5; // gate for the pooled all-time ratio
const WB_MIN_D7 = 20;        // ...and enough weekly movement to divide by
const WB_GAP_SEC = 5 * 3600;
const _r2 = (x) => Math.round(x * 100) / 100;

function _wb_pool(windows, source) {
  const gated = windows.filter((w) => w.included);
  // Nothing gated in → do NOT pool every window: a barely-observed window has a
  // near-zero Sum(delta 5h) against a real delta 7d, which drags the ratio down
  // harder than it informs it. Fall back to the single best-observed window and
  // let `gated:false` label it.
  const rest = windows.filter((w) => w.d7 > 0)
    .sort((a, b) => (b.coverage || 0) - (a.coverage || 0) || b.d7 - a.d7);
  const pool = gated.length ? gated : rest.slice(0, 1);
  let S5 = 0, S7 = 0;
  for (const w of pool) { S5 += w.d5; S7 += w.d7; }
  if (S7 <= 0) return null;
  const r = S5 / S7;
  return {
    source, r: _r2(r), d5: _r2(S5), d7: _r2(S7), nWindows: pool.length,
    gated: gated.length > 0,
    hoursPer7dDay: _r2((r * 5) / 7), // 1 day of weekly budget, in hours of 5h capacity
    daysPer5hWindow: _r2(7 / r),     // one full 5h window, in days of weekly budget
  };
}

// OAuth path (accurate): weekly windows from usage-snapshots, 5h deltas from the
// 5h windows that opened inside each weekly span. `shortGauge`/`longGauge` default
// to Claude's five_hour/seven_day pair; the ollama path passes "session"/"weekly"
// (same window lengths, its own account quota) so one delta-pairing serves both.
function _window_balance_oauth(snaps, nowSec, shortGauge = "five_hour", longGauge = "seven_day") {
  const w5 = _gauge_windows(snaps, shortGauge);
  const dur = (GAUGE_DUR_HOURS.seven_day || 168) * 3600;
  const windows = [];
  for (const w of _gauge_windows(snaps, longGauge)) {
    if (w.snaps.length < 2) continue;
    const t0 = w.snaps[0].t, t1 = w.snaps[w.snaps.length - 1].t;
    // delta 7d over the OBSERVED span (7d is monotone inside a window). Pairing it
    // with the 5h windows that opened in the same span keeps both sides consistent;
    // the unobserved head of the window is dropped from both, not from one.
    const d7 = w.snaps[w.snaps.length - 1].u - w.snaps[0].u;
    // Each 5h window rose from 0 to its peak, so its own uFinal IS its delta.
    let d5 = 0, n5 = 0;
    for (const f of w5) {
      const ft = f.snaps[0].t;
      if (ft >= t0 && ft <= t1) { d5 += f.uFinal; n5++; }
    }
    let seen = 0;
    for (let i = 1; i < w.snaps.length; i++) {
      seen += Math.min(w.snaps[i].t - w.snaps[i - 1].t, WB_GAP_SEC);
    }
    const nominal = Math.min(w.resetSec, nowSec) - (w.resetSec - dur);
    const coverage = nominal > 0 ? Math.min(1, seen / nominal) : 0;
    windows.push({
      resetsAt: w.resetsAtCanon, resetSec: w.resetSec, d5: _r2(d5), d7: _r2(d7),
      r: d7 > 0 ? _r2(d5 / d7) : null, coverage: _r2(coverage), n5,
      nSnaps: w.snaps.length, included: coverage >= WB_MIN_COVERAGE && d7 >= WB_MIN_D7,
    });
  }
  return windows;
}

// Statusline fallback (lower bound, shown alongside): reset-aware deltas over the
// per-session rl gauges, bucketed into 7d bins anchored on `anchorSec`. Sessions
// are ordered by `ts`, which is the session's END (last transcript entry) — the
// order the gauges were actually read in. No coverage measure exists here (the
// gauge is only sampled when a session ends), so these windows never gate in.
function _window_balance_statusline(sessions, anchorSec) {
  const rl = (sessions || [])
    .filter((s) => /^claude/i.test(s.model || "") && s.rl5 > 0 && s.rl7 > 0)
    .map((s) => ({ ...s, _t: (parseDateTime(s.ts) || 0) && Math.floor(parseDateTime(s.ts).getTime() / 1000) }))
    .filter((s) => s._t)
    .sort((a, b) => a._t - b._t);
  if (rl.length < 2) return [];
  const W = 7 * 86400;
  const bins = new Map();
  let p5 = null, p7 = null;
  for (const s of rl) {
    const d5 = p5 === null || s.rl5 < p5 ? s.rl5 : s.rl5 - p5;
    const d7 = p7 === null || s.rl7 < p7 ? s.rl7 : s.rl7 - p7;
    p5 = s.rl5; p7 = s.rl7;
    const k = Math.ceil((s._t - anchorSec) / W);
    const b = bins.get(k) || { d5: 0, d7: 0, n: 0 };
    b.d5 += d5; b.d7 += d7; b.n++;
    bins.set(k, b);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({
    resetsAt: new Date((anchorSec + k * W) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    resetSec: anchorSec + k * W, d5: _r2(b.d5), d7: _r2(b.d7),
    r: b.d7 > 0 ? _r2(b.d5 / b.d7) : null, coverage: null, n5: null,
    nSnaps: b.n, included: false,
  }));
}

function _window_balance(snaps, sessions, nowSec) {
  const oauth = _window_balance_oauth(snaps, nowSec);
  const anchor = oauth.length
    ? oauth[oauth.length - 1].resetSec
    : Math.floor(Date.now() / 1000);
  const statusline = _window_balance_statusline(sessions, anchor);
  const pooled = _wb_pool(oauth, "oauth") || _wb_pool(statusline, "statusline");
  if (!pooled) return null;
  return {
    pooled, windows: oauth, statuslineWindows: statusline,
    minCoverage: WB_MIN_COVERAGE, minD7: WB_MIN_D7,
  };
}

// Fit prior + calibration (two-pass, claumon service.Refit) from completed
// windows. Returns {prior, calibration, nWindows} or null when <2 usable windows.
function _fit_gauge(gauge, windows, nowSec, cfg) {
  const dur = GAUGE_DUR_HOURS[gauge] || 5;
  const completed = windows.filter((w) => w.resetSec <= nowSec && w.snaps.length >= 2);
  const fcSessions = completed.map((w) => ({
    resetSec: w.resetSec, durationHours: dur, uFinal: w.uFinal, snapshots: w.snaps,
  }));
  const p1 = FC.fitPrior(fcSessions, 0, cfg.varianceEps);
  if (!p1.ok) return null;
  const cal = FC.calibrateSigmaSession(fcSessions, p1, cfg);
  const p2 = FC.fitPrior(fcSessions, cal.sigmaSessionSq, cfg.varianceEps);
  const prior = p2.ok ? p2 : p1;
  return { prior, calibration: cal, nWindows: completed.length };
}

// Prior-only fit from statusline rl points (fallback when OAuth is off). Each
// rl-bearing session is one synthetic completed window: uFinal = rl pct,
// durationHours = nominal window length. No snapshots → no calibration, no
// open window → no projection, but the rate prior still renders.
function _fit_gauge_statusline(sessions, gauge) {
  const key = gauge === "five_hour" ? "rl5" : "rl7";
  const dur = GAUGE_DUR_HOURS[gauge] || 5;
  const fcSessions = sessions
    .filter((s) => s[key] && s[key] > 0)
    .map((s) => ({ uFinal: s[key], durationHours: dur, snapshots: [] }));
  const prior = FC.fitPrior(fcSessions, 0, FC.defaultConfig().varianceEps);
  if (!prior.ok) return null;
  return { prior, calibration: { sigmaSessionSq: FC.defaultConfig().varianceEps, barTauSq: 0 },
    nWindows: fcSessions.length, source: "statusline" };
}

function _forecast_stale(max_age_days = 7) {
  if (!isFile(FORECAST_JSON)) return true;
  const fj = getmtime(FORECAST_JSON);
  if (Date.now() / 1000 - fj > max_age_days * 86400) return true;
  // New usage snapshots or new transcripts (statusline rl fallback) → refit.
  if (isFile(USAGE_SNAPSHOTS_JSONL) && getmtime(USAGE_SNAPSHOTS_JSONL) > fj) return true;
  if (isFile(OLLAMA_USAGE_JSONL) && getmtime(OLLAMA_USAGE_JSONL) > fj) return true;
  const newestJsonl = fs.globSync(`${PROJECTS_GLOB}/*/*.jsonl`)
    .reduce((mx, p) => Math.max(mx, getmtime(p)), 0);
  return newestJsonl > fj;
}

// ---- ollama Cloud rate-limit forecast (own account quota, no OAuth) ----
// Mirrors the Claude gauges/windowBalance/tokenYield path above, but reads
// ollama-usage.jsonl (daemon-sampled, no OAuth/statusline) and keys off
// session/weekly instead of five_hour/seven_day. Absent file or no usable
// records → out.ollama is omitted entirely (_build_forecast), so every existing
// card renders exactly as before.

// Evenly-spaced downsample to at most `cap` items, always keeping the last one
// (the newest reading is the one a reader looks for first).
function _stride(arr, cap) {
  if (arr.length <= cap) return arr;
  const step = Math.ceil(arr.length / cap);
  const out = arr.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function _ollama_window_balance(snaps, nowSec) {
  const windows = _window_balance_oauth(snaps, nowSec, "session", "weekly");
  const pooled = _wb_pool(windows, "ollama");
  if (!pooled) return null;
  return { pooled, windows, statuslineWindows: [], minCoverage: WB_MIN_COVERAGE, minD7: WB_MIN_D7 };
}

// Per-model Mtok per 1% of the ollama WEEKLY window. r5/r7-style per-session
// gauge deltas (the Claude client-side tokenYield) don't exist here — the scrape
// is one global cumulative reading with per-model REQUEST counts, not per-model
// tokens. So the split happens server-side: each consecutive snapshot pair's
// Δweekly% is divided across models by their request-count deltas
// (Δ%_model = Δ%_window × Δreq_model / Δreq_total), reset-aware like the
// window-balance deltas above (a drop in weekly% OR in total requests starts a
// fresh chain — delta = the current value/reading, not a negative). Aggregated
// by day, then paired with that day's token totals from stats.csv sessions
// (`:cloud` stripped — stats.csv routes ollama models through a proxy tag the
// scrape doesn't carry). A scrape entry with no matching sessions (e.g. "web
// search") still consumes its Δ% share but pairs with 0 tokens — it stays in
// `models`/`agg` at e=0 rather than being dropped, since it's real quota draw.
function _ollama_token_yield(snaps, sessions) {
  const recs = snaps
    .filter((r) => r.weekly && r.weekly.utilization != null && Array.isArray(r.models))
    .map((r) => ({ t: _fetched_epoch(r), day: (r.fetched_at || "").slice(0, 10), u: Number(r.weekly.utilization), models: r.models }))
    .filter((r) => r.t != null && r.day)
    .sort((a, b) => a.t - b.t);
  // Day -> stripped model_id -> token total, from the loaded stats.csv sessions.
  const tokByDayModel = {};
  for (const s of (sessions || [])) {
    const day = (s.ts || "").slice(0, 10);
    const m = (s.model || "").replace(/:cloud$/, "");
    if (!day || !m) continue;
    const dm = tokByDayModel[day] || (tokByDayModel[day] = {});
    dm[m] = (dm[m] || 0) + s.tok;
  }
  const sumD = {};
  let prevU = null, prevReq = {};
  for (const r of recs) {
    const curTotalReq = r.models.reduce((a, m) => a + _fnum(m && m.requests), 0);
    const prevTotalReq = Object.values(prevReq).reduce((a, v) => a + v, 0);
    const reset = prevU === null || r.u < prevU || curTotalReq < prevTotalReq;
    const dPct = reset ? r.u : r.u - prevU;
    prevU = r.u;
    if (dPct > 0) {
      const reqDelta = {};
      let totalReq = 0;
      for (const m of r.models) {
        const name = m && m.model;
        if (!name) continue;
        const cur = _fnum(m.requests);
        const prev = reset ? 0 : (prevReq[name] || 0);
        const d = Math.max(0, cur - prev);
        reqDelta[name] = d;
        totalReq += d;
      }
      if (totalReq > 0) {
        for (const [name, d] of Object.entries(reqDelta)) {
          if (d <= 0) continue;
          const share = dPct * (d / totalReq);
          (sumD[name] = sumD[name] || {})[r.day] = (sumD[name][r.day] || 0) + share;
        }
      }
    }
    prevReq = {};
    for (const m of r.models) { if (m && m.model) prevReq[m.model] = _fnum(m.requests); }
  }
  const series = {}, agg = {}, models = [], dayset = {};
  for (const [name, byDay] of Object.entries(sumD)) {
    let aggT = 0, aggD = 0;
    series[name] = {};
    for (const [day, d] of Object.entries(byDay)) {
      if (d < 0.05) continue;
      const t = (tokByDayModel[day] && tokByDayModel[day][name]) || 0;
      series[name][day] = { e: (t / 1e6) / d, t, d };
      dayset[day] = 1;
      aggT += t; aggD += d;
    }
    if (aggD < 0.05) continue;
    agg[name] = { e: (aggT / 1e6) / aggD, t: aggT, d: aggD };
    models.push(name);
  }
  models.sort();
  return { days: Object.keys(dayset).sort(), series, agg, models };
}

function _build_ollama_forecast(nowSec, cfg, fitAt, sessions) {
  const snaps = _load_usage_snapshots(OLLAMA_USAGE_JSONL);
  if (!snaps.length) return null;
  const gauges = {};
  for (const gauge of ["session", "weekly"]) {
    const windows = _gauge_windows(snaps, gauge);
    const fit = _fit_gauge(gauge, windows, nowSec, cfg);
    if (!fit) { gauges[gauge] = { ok: false }; continue; }
    // Open window = the future reset with the most snapshots. No statusline
    // fallback exists for ollama, so a failed fit is simply {ok:false}.
    const open = windows.filter((w) => w.resetSec > nowSec)
      .sort((a, b) => b.snaps.length - a.snaps.length)[0];
    let result = null;
    if (open && open.snaps.length >= 1) {
      const last = open.snaps[open.snaps.length - 1];
      const r = FC.runForecast({
        nowSec: last.t, resetSec: open.resetSec, uNow: last.u,
        snapshots: open.snaps, prior: fit.prior, calibration: fit.calibration,
        thresholds: [100, 80],
      }, cfg);
      if (r.ok) result = {
        forecast: r.forecast, posterior: { rHat: r.posterior.rHat, usedOLS: r.posterior.usedOLS, n: r.posterior.n },
        etas: r.etas, openResetSec: open.resetSec, uNow: last.u, nSnaps: open.snaps.length,
      };
    }
    gauges[gauge] = {
      ok: true, source: "ollama", nWindows: fit.nWindows,
      prior: { mu0: fit.prior.mu0, tau0Sq: fit.prior.tau0Sq, nSessions: fit.prior.nSessions },
      calibration: fit.calibration, result,
    };
  }
  return {
    modelVersion: FC.MODEL_VERSION, fitAt,
    gauges,
    windowBalance: _ollama_window_balance(snaps, nowSec),
    tokenYield: _ollama_token_yield(snaps, sessions),
    // Trend series for the utilization card. Evenly strided down to
    // OLLAMA_SERIES_CAP points, keeping the full time span: forecast.json is
    // embedded verbatim into every report HTML and svgRateTrend draws two dots
    // (each with a <title>) per point, so the raw ~48 samples/day would add
    // ~290 bytes of SVG per sample — a month of sampling is 400KB in one card.
    // Striding (not last-N truncation) keeps the whole history readable.
    series: _stride(snaps, OLLAMA_SERIES_CAP).map((rec) => ({
      ts: rec.fetched_at,
      session: rec.session && rec.session.utilization != null ? Number(rec.session.utilization) : null,
      weekly: rec.weekly && rec.weekly.utilization != null ? Number(rec.weekly.utilization) : null,
    })).filter((r) => r.session != null || r.weekly != null),
  };
}

// ---- Codex weekly rate-limit forecast (own account quota, no OAuth/statusline) ----
// Mirrors _build_ollama_forecast, but Codex Plus exposes only ONE rate-limit
// window: rate_limits.primary.window_minutes is always 10080 (weekly),
// secondary is always null — so there's no five_hour/session pairing and no
// window-balance ratio to compute. Absent/empty codex-usage.jsonl → null, so
// out.codex is omitted entirely on a machine with no Codex.
function _build_codex_forecast(nowSec, cfg, fitAt) {
  const snaps = _load_usage_snapshots(CODEX_USAGE_JSONL);
  if (!snaps.length) return null;
  const windows = _gauge_windows(snaps, "weekly");
  const fit = _fit_gauge("weekly", windows, nowSec, cfg);
  let gauge = { ok: false };
  if (fit) {
    const open = windows.filter((w) => w.resetSec > nowSec)
      .sort((a, b) => b.snaps.length - a.snaps.length)[0];
    let result = null;
    if (open && open.snaps.length >= 1) {
      const last = open.snaps[open.snaps.length - 1];
      const r = FC.runForecast({
        nowSec: last.t, resetSec: open.resetSec, uNow: last.u,
        snapshots: open.snaps, prior: fit.prior, calibration: fit.calibration,
        thresholds: [100, 80],
      }, cfg);
      if (r.ok) result = {
        forecast: r.forecast, posterior: { rHat: r.posterior.rHat, usedOLS: r.posterior.usedOLS, n: r.posterior.n },
        etas: r.etas, openResetSec: open.resetSec, uNow: last.u, nSnaps: open.snaps.length,
      };
    }
    gauge = {
      ok: true, source: "codex", nWindows: fit.nWindows,
      prior: { mu0: fit.prior.mu0, tau0Sq: fit.prior.tau0Sq, nSessions: fit.prior.nSessions },
      calibration: fit.calibration, result,
    };
  }
  return {
    modelVersion: FC.MODEL_VERSION, fitAt,
    gauges: { weekly: gauge },
    // Trend series for the utilization card, strided like the ollama one.
    series: _stride(snaps, OLLAMA_SERIES_CAP).map((rec) => ({
      ts: rec.fetched_at,
      weekly: rec.weekly && rec.weekly.utilization != null ? Number(rec.weekly.utilization) : null,
    })).filter((r) => r.weekly != null),
  };
}

// Compute the forecast for both gauges and persist. Returns the payload that
// render.mjs embeds. `sessions` is the _load_stats() session list (for the
// statusline fallback); pass null to skip that fallback.
function _build_forecast(sessions) {
  const cfg = FC.defaultConfig();
  const nowSec = Math.floor(Date.now() / 1000);
  const snaps = _load_usage_snapshots();
  const out = { fitAt: now_local(), modelVersion: FC.MODEL_VERSION, gauges: {} };
  for (const gauge of ["five_hour", "seven_day"]) {
    const windows = _gauge_windows(snaps, gauge);
    const fit = _fit_gauge(gauge, windows, nowSec, cfg);
    if (fit) {
      // Open window = the future reset with the most snapshots (usually the
      // latest reset_at). Project from its latest snapshot as uNow/nowSec.
      const open = windows.filter((w) => w.resetSec > nowSec)
        .sort((a, b) => b.snaps.length - a.snaps.length)[0];
      let result = null;
      if (open && open.snaps.length >= 1) {
        const last = open.snaps[open.snaps.length - 1];
        const r = FC.runForecast({
          nowSec: last.t, resetSec: open.resetSec, uNow: last.u,
          snapshots: open.snaps, prior: fit.prior, calibration: fit.calibration,
          thresholds: [100, 80],
        }, cfg);
        if (r.ok) result = {
          forecast: r.forecast, posterior: { rHat: r.posterior.rHat, usedOLS: r.posterior.usedOLS, n: r.posterior.n },
          etas: r.etas, openResetSec: open.resetSec, uNow: last.u, nSnaps: open.snaps.length,
        };
      }
      out.gauges[gauge] = {
        ok: true, source: "oauth", nWindows: fit.nWindows,
        prior: { mu0: fit.prior.mu0, tau0Sq: fit.prior.tau0Sq, nSessions: fit.prior.nSessions },
        calibration: fit.calibration, result,
      };
      continue;
    }
    // No OAuth history → try the statusline fallback (prior only, no projection).
    if (sessions) {
      const fb = _fit_gauge_statusline(sessions, gauge);
      if (fb) {
        out.gauges[gauge] = {
          ok: true, source: fb.source, nWindows: fb.nWindows,
          prior: { mu0: fb.prior.mu0, tau0Sq: fb.prior.tau0Sq, nSessions: fb.prior.nSessions },
          calibration: fb.calibration, result: null,
        };
        continue;
      }
    }
    out.gauges[gauge] = { ok: false };
  }
  out.windowBalance = _window_balance(snaps, sessions, nowSec);
  const ollama = _build_ollama_forecast(nowSec, cfg, out.fitAt, sessions);
  if (ollama) out.ollama = ollama;
  const codex = _build_codex_forecast(nowSec, cfg, out.fitAt);
  if (codex) out.codex = codex;
  fs.writeFileSync(FORECAST_JSON, JSON.stringify(out, null, 2), { encoding: "utf-8", mode: 0o600 });
  return out;
}

// Public: lazy-rebuild + read. Called from cmd_report so render.mjs gets a
// fresh forecast payload alongside the SESSIONS embed.
export function _load_forecast(sessions) {
  if (_forecast_stale()) _build_forecast(sessions);
  if (!isFile(FORECAST_JSON)) return null;
  try { return JSON.parse(fs.readFileSync(FORECAST_JSON, "utf-8")); } catch { return null; }
}

function cmd_forecast(args) {
  // Force a refit (--force) or just read+print the persisted fit. The statusline
  // fallback needs the session list; guard a missing stats.csv so `forecast` still
  // works from a fresh state dir (OAuth-only).
  if (args.force) {
    let sessions = null;
    if (isFile(STATS_CSV)) {
      try { sessions = _load_stats().sessions; } catch { sessions = null; }
    }
    _build_forecast(sessions);
  }
  const f = isFile(FORECAST_JSON) ? JSON.parse(fs.readFileSync(FORECAST_JSON, "utf-8")) : null;
  if (!f) { printErr("no forecast.json — run: node stats.mjs forecast --force"); process.exit(1); }
  print(`forecast -> ${FORECAST_JSON}  (model ${f.modelVersion}, fit ${f.fitAt})`);
  for (const gauge of ["five_hour", "seven_day"]) {
    const g = f.gauges[gauge];
    if (!g || !g.ok) { print(`  ${gauge}: no data`); continue; }
    const p = g.prior;
    print(`  ${gauge} [${g.source}]: nWindows=${g.nWindows} mu0=${fixed(p.mu0, 3)}%/h tau0^2=${p.tau0Sq.toExponential(2)} sigma^2=${g.calibration.sigmaSessionSq.toExponential(2)}`);
    if (g.result) {
      const fc = g.result.forecast;
      print(`    projected @reset: ${fixed(fc.f, 1)}%  80% CI [${fixed(fc.lower, 1)}, ${fixed(fc.upper, 1)}]  (uNow ${fixed(g.result.uNow, 1)}%, ${g.result.nSnaps} snaps, ${g.result.posterior.usedOLS ? "OLS" : "prior"})`);
      for (const thr of [100, 80]) {
        const e = g.result.etas[String(thr)];
        if (!e) continue;
        if (e.pInf >= 0.5) print(`    ETA ${thr}%: ${fixed(e.pInf * 100, 0)}% never-crosses`);
        else print(`    ETA ${thr}%: median ${local_fmt(e.median)} (pInf ${fixed(e.pInf * 100, 0)}%)${e.upper ? '' : '  open-ended'}`);
      }
    } else {
      print(`    no open window to project${g.source === "statusline" ? " (statusline fallback: enable OAuth polling for a projection)" : ""}`);
    }
  }
  const wb = f.windowBalance;
  if (!wb) { print("  window balance: no data"); return; }
  const p = wb.pooled;
  print(`  window balance [${p.source}${p.gated ? "" : ", ungated"}]: r = ${fixed(p.r, 2)}  (n=${p.nWindows} window${p.nWindows === 1 ? "" : "s"}, Σ Δ5=${fixed(p.d5, 0)}% Σ Δ7=${fixed(p.d7, 0)}%)`);
  print(`    1 day of 7d budget = ${fixed(p.hoursPer7dDay, 2)}h of 5h capacity  ·  one 5h window = ${fixed(p.daysPer5hWindow, 2)} days of 7d budget`);
  for (const w of wb.windows) {
    print(`    ${w.resetsAt.slice(0, 16)}  r=${w.r == null ? "—" : fixed(w.r, 2)}  Δ5=${fixed(w.d5, 0)}% Δ7=${fixed(w.d7, 0)}%  cov=${fixed(w.coverage * 100, 0)}%${w.included ? "" : "  (excluded)"}`);
  }
  if (wb.statuslineWindows.length) {
    print(`    statusline lower bound: ${wb.statuslineWindows.map((w) => (w.r == null ? "—" : fixed(w.r, 2))).join(" ")}`);
  }
}

function _map_usage(raw) {
  const pick = (o) => (o && typeof o === "object")
    ? { utilization: o.utilization ?? null, resets_at: o.resets_at ?? null }
    : null;
  const eu = raw && raw.extra_usage;
  return {
    five_hour: pick(raw && raw.five_hour),
    seven_day: pick(raw && raw.seven_day),
    per_model: {
      sonnet: pick(raw && raw.seven_day_sonnet),
      opus: pick(raw && raw.seven_day_opus),
      // API key is seven_day_omelette (claumon maps it to "design").
      design: pick(raw && raw.seven_day_omelette),
    },
    extra_usage: eu && typeof eu === "object"
      ? {
          is_enabled: eu.is_enabled ?? null,
          monthly_limit: eu.monthly_limit ?? null,
          used_credits: eu.used_credits ?? null,
          utilization: eu.utilization ?? null,
        }
      : null,
  };
}

async function _do_usage_request(token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), USAGE_API_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(USAGE_API_URL, {
      headers: {
        Authorization: "Bearer " + token,
        "anthropic-beta": USAGE_API_BETA,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await resp.text();
  return { status: resp.status, body };
}

async function cmd_fetch_usage(args) {
  if (!_oauth_enabled(args)) {
    // Silent no-op — local-only default. Exit clean so `report`/automation that
    // calls this unconditionally doesn't error when OAuth is off.
    process.exit(0);
  }
  const token = _read_access_token();
  if (!token) {
    printErr("fetch-usage: no OAuth credentials at " + CREDENTIALS_PATH +
      " (run `claude /login`). Skipping.");
    process.exit(0);
  }
  let resp;
  try {
    resp = await _do_usage_request(token);
  } catch (e) {
    printErr("fetch-usage: request failed: " + (e && e.message ? e.message : String(e)));
    process.exit(0);
  }
  if (resp.status === 401) {
    printErr("fetch-usage: auth expired (401) — re-run `claude /login`.");
    process.exit(0);
  }
  if (resp.status === 429) {
    printErr("fetch-usage: rate limited (429). Retry later.");
    process.exit(0);
  }
  if (resp.status !== 200) {
    printErr("fetch-usage: API returned " + resp.status + ": " + resp.body.slice(0, 200));
    process.exit(0);
  }
  let raw;
  try {
    raw = JSON.parse(resp.body);
  } catch (e) {
    printErr("fetch-usage: parse error: " + e.message);
    process.exit(0);
  }
  const usage = _map_usage(raw);
  const rec = { fetched_at: now_local(), ...usage, raw };
  if (args.save) {
    try {
      fs.appendFileSync(USAGE_SNAPSHOTS_JSONL, JSON.stringify(rec) + "\n",
        { encoding: "utf-8", mode: 0o600 });
    } catch (e) {
      printErr("fetch-usage: write failed: " + e.message);
      process.exit(0);
    }
  }
  // Summary (never the token). utilization is already in percent (API contract,
  // matches statusline rate_limits.used_percentage — both stored as percent).
  const fmt = (w) => w && w.utilization != null
    ? Number(w.utilization).toFixed(1) + "%"
    : "—";
  print("fetched: " + rec.fetched_at);
  print("  5h:  " + fmt(usage.five_hour) +
    (usage.five_hour && usage.five_hour.resets_at ? "  resets " + usage.five_hour.resets_at : ""));
  print("  7d:  " + fmt(usage.seven_day) +
    (usage.seven_day && usage.seven_day.resets_at ? "  resets " + usage.seven_day.resets_at : ""));
  for (const m of ["sonnet", "opus", "design"]) {
    const v = usage.per_model[m];
    if (v && v.utilization != null) print("  7d." + m + ": " + fmt(v));
  }
  if (usage.extra_usage && usage.extra_usage.is_enabled) {
    print("  extra-usage: enabled  used " + (usage.extra_usage.used_credits ?? "—") +
      " / " + (usage.extra_usage.monthly_limit ?? "—"));
  }
  if (args.save) print("saved → " + USAGE_SNAPSHOTS_JSONL);
}

// ---- fetch-pricing (live pricing refresh; Phase F, same off-by-default gate as fetch-usage) ----
// Fetches claumon's remote pricing.json (per-model-id rates), reduces to the
// skill's family keys (latest model-id per family by version), writes the cache,
// and re-applies overrides so the active PRICE reflects it. Malformed/empty
// remote → ignored (silent), embedded table unchanged.

// Parse "claude-opus-4-8" / "claude-sonnet-5" → [4,8] / [5] for version ordering.
function _model_version_key(id) {
  const nums = id.match(/(\d+)(?:-(\d+))?/g) || [];
  const parts = [];
  for (const seg of nums) {
    for (const n of seg.split("-")) {
      const x = parseInt(n, 10);
      if (!Number.isNaN(x)) parts.push(x);
    }
  }
  return parts.length ? parts : [0];
}

// Reduce a remote {modelId: {input,output,cache_read,cache_write_5m,...}} map to
// family → [input, output, cache_read, cache_create(=cache_write_5m)], keeping
// the highest-version model-id per family (proxy for current rate).
function _reduce_remote_to_families(models) {
  const fams = {};
  for (const [id, p] of Object.entries(models)) {
    if (!p || typeof p !== "object") continue;
    const m = id.toLowerCase();
    let fam = null;
    for (const k of Object.keys(PRICE)) { if (m.includes(k)) { fam = k; break; } }
    if (!fam) continue;
    const rates = [p.input, p.output, p.cache_read, p.cache_write_5m ?? p.cache_write_1h];
    if (!_is_rate(rates)) continue;
    const vk = _model_version_key(id);
    const prev = fams[fam];
    if (!prev || _cmp_version(vk, prev.vk) > 0) fams[fam] = { rates: rates.map(Number), vk };
  }
  const out = {};
  for (const [f, v] of Object.entries(fams)) out[f] = v.rates;
  return out;
}

function _cmp_version(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0, bi = b[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

async function cmd_fetch_pricing(args) {
  if (!_oauth_enabled(args)) {
    process.exit(0); // silent no-op — local-only default, same as fetch-usage
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRICING_FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(PRICING_REMOTE_URL, { signal: ctrl.signal });
  } catch (e) {
    printErr("fetch-pricing: request failed: " + (e && e.message ? e.message : String(e)));
    process.exit(0);
  } finally {
    clearTimeout(timer);
  }
  if (resp.status !== 200) {
    printErr("fetch-pricing: remote returned " + resp.status);
    process.exit(0);
  }
  let body;
  try { body = await resp.text(); } catch (e) {
    printErr("fetch-pricing: read failed: " + e.message);
    process.exit(0);
  }
  if (body.length > 1 << 20) { printErr("fetch-pricing: remote > 1MB, ignored"); process.exit(0); }
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) {
    printErr("fetch-pricing: parse error: " + e.message);
    process.exit(0);
  }
  const models = parsed && parsed.models && typeof parsed.models === "object" ? parsed.models : null;
  if (!models || !Object.keys(models).length) {
    printErr("fetch-pricing: remote has no models, ignored");
    process.exit(0);
  }
  const base = _reduce_remote_to_families(models);
  if (!Object.keys(base).length) {
    printErr("fetch-pricing: no recognized families in remote, ignored");
    process.exit(0);
  }
  const cache = { updated: now_local(), source: PRICING_REMOTE_URL, base };
  try {
    fs.writeFileSync(PRICING_CACHE_JSON, JSON.stringify(cache, null, 2),
      { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    printErr("fetch-pricing: write failed: " + e.message);
    process.exit(0);
  }
  // Re-apply so the live process reflects the refresh (cache → promos → manual).
  _apply_price_overrides();
  print("fetched pricing: " + cache.updated + "  (" + Object.keys(models).length + " models → " +
    Object.keys(base).length + " families)");
  for (const f of Object.keys(PRICE)) {
    print("  " + f.padEnd(8) + "$" + PRICE[f][0] + "/" + PRICE[f][1] + "  (cache " + (base[f] ? "set" : "—") + ")");
  }
  print("saved → " + PRICING_CACHE_JSON);
}

// ---- pricing diagnostic (Phase F): print the resolved table + which layer set it ----
function cmd_pricing() {
  const cache = _load_pricing_cache();
  print("resolved pricing ($/MTok [input, output, cache_read, cache_create]):");
  for (const f of Object.keys(PRICE)) {
    const tags = [];
    if (cache && cache.base && cache.base[f]) tags.push("cache");
    const promo = PROMOS.find((p) => p.family === f && _promo_active(p));
    if (promo) tags.push("promo→" + promo.expires);
    if (isFile(PRICE_OVERRIDE_JSON)) tags.push("override?");
    print("  " + f.padEnd(8) + JSON.stringify(PRICE[f]) + (tags.length ? "  [" + tags.join(",") + "]" : "  [embedded]"));
  }
  if (cache) print("cache: " + cache.updated + " (fresh) → " + PRICING_CACHE_JSON);
  else print("cache: absent or stale (>24h) → embedded + promos only");
}

// ---- install (cross-machine setup) ----

function _settings_path() {
  return path.join(CLAUDE_DIR, "settings.json");
}

function _load_settings() {
  const p = _settings_path();
  if (!isFile(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null; // corrupt → refuse to write
  }
}

// Classify a SessionEnd command: "ours" invokes THIS stats.mjs with `record`,
// "foreign" is some other stats.mjs record hook; null otherwise.
function _record_hook_kind(cmd, stats_abs) {
  if (!cmd.replace(/\s+$/, "").endsWith('" record')) return null;
  const forms = [stats_abs, stats_abs.replace(/\\/g, "/")];
  if (forms.some((f) => cmd.includes(f))) return "ours";
  if (cmd.includes("stats.mjs")) return "foreign";
  return null;
}

function cmd_install(args) {
  const stats_abs = SCRIPT;
  const hook_cmd = `node "${stats_abs}" record`;
  const s_path = _settings_path();
  let cfg = _load_settings();
  const corrupt = cfg === null;
  if (corrupt) cfg = {};

  if (!cfg.hooks) cfg.hooks = {};
  if (!cfg.hooks.SessionEnd) cfg.hooks.SessionEnd = [];
  const se = cfg.hooks.SessionEnd;
  const existing = [];
  for (const block of se) {
    for (const h of block.hooks || []) {
      if (h.type === "command") existing.push(h.command || "");
    }
  }
  const already = existing.some((c) => _record_hook_kind(c, stats_abs) === "ours");
  const foreign = existing.filter((c) => _record_hook_kind(c, stats_abs) === "foreign");

  print("=== harness-usage-report install ===");
  print(`platform: ${process.platform}   interpreter: node`);
  print(`stats.mjs: ${stats_abs}`);
  print(`settings: ${s_path}`);
  print(`hook cmd: ${hook_cmd}`);
  print(`dirs:     ${STATE_DIR} , ${REPORTS_DIR}`);

  let action;
  if (already) {
    action = "noop";
    print("SessionEnd hook already present.");
  } else if (foreign.length && !args.force) {
    print("REFUSING: a SessionEnd record-hook points to a different stats.mjs:");
    for (const c of foreign) print(`  - ${c}`);
    print("Re-run with --force to replace it.");
    return;
  } else {
    action = "add";
  }

  let sl_action = "skip";
  let sl_note = "";
  if (args.with_statusline) {
    const sl = cfg.statusLine;
    if (sl && sl.command) {
      sl_note = "existing statusLine left in place (remove it first to use the reference)";
    } else {
      sl_action = "install";
    }
  }

  if (args.dry_run) {
    print("\n[dry-run] nothing written.");
    print(
      `would ${action === "add" ? "add" : "keep"} SessionEnd hook; ` +
        `${action !== "noop" ? "create" : "ensure"} dirs; statusline: ${sl_action}.`
    );
    return;
  }

  for (const d of [STATE_DIR, REPORTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }

  if (action === "add") {
    if (foreign.length) {
      cfg.hooks.SessionEnd = se
        .filter((block) => block.hooks)
        .map((block) => ({
          hooks: (block.hooks || []).filter(
            (h) =>
              !(h.type === "command" && _record_hook_kind(h.command || "", stats_abs) === "foreign")
          ),
        }));
    }
    cfg.hooks.SessionEnd.push({ hooks: [{ type: "command", command: hook_cmd }] });
    if (corrupt) {
      print(`\n${sl_note || "settings.json unreadable"} — add this SessionEnd hook manually:`);
      print('  hooks.SessionEnd -> hooks -> { type: "command", command: <below> }');
      print(`    ${hook_cmd}`);
    } else {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(s_path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      print(`\nWrote SessionEnd hook to ${s_path}.`);
    }
  }

  if (sl_action === "install") {
    const src = path.join(SKILL_DIR, "scripts", "statusline.mjs");
    if (isFile(src)) {
      const dest = path.join(CLAUDE_DIR, "statusline.mjs");
      fs.writeFileSync(dest, fs.readFileSync(src, "utf-8"), "utf-8");
      const sl_cmd = `node "${dest}"`;
      const cfg2 = _load_settings() || {};
      cfg2.statusLine = { type: "command", command: sl_cmd };
      if (!corrupt) {
        fs.writeFileSync(s_path, JSON.stringify(cfg2, null, 2) + "\n", "utf-8");
        print(`Installed reference statusline → ${dest}`);
        print(`  statusLine.command: ${sl_cmd}`);
      } else {
        print(`Reference statusline copied to ${dest}; add to settings.json:`);
        print('  statusLine -> { type: "command", command: <below> }');
        print(`    ${sl_cmd}`);
      }
    } else {
      print(`No reference statusline.mjs shipped at ${src} — skipping.`);
    }
  }

  print("\nCapture contract: your statusline must write the raw statusline JSON to");
  print(`  ${STATE_DIR}/<session_id>.json   (last write per session wins)`);
  print("See INSTALL.md and scripts/statusline.mjs reference. Without it, the report");
  print("still renders from transcripts only (cost/duration/lines blank).");
  print("\nDone. Generate a report:  node " + stats_abs + " report");
}

// ---- output helpers ----

function print(s) {
  process.stdout.write(s + "\n");
}

function printErr(s) {
  process.stderr.write(s + "\n");
}

function fixed(n, d) {
  return Number(n).toFixed(d);
}

// ---- CLI dispatch ----

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    printErr("usage: stats.mjs {record,backfill,report,install,fetch-usage,fetch-pricing,forecast,pricing}");
    process.exit(2);
  }
  if (cmd === "record") {
    cmd_record();
  } else if (cmd === "backfill") {
    cmd_backfill();
  } else if (cmd === "report") {
    cmd_report();
  } else if (cmd === "install") {
    const args = {
      dry_run: argv.includes("--dry-run"),
      force: argv.includes("--force"),
      with_statusline: argv.includes("--with-statusline"),
    };
    cmd_install(args);
  } else if (cmd === "fetch-usage") {
    await cmd_fetch_usage({
      save: argv.includes("--save"),
      oauth: argv.includes("--oauth"),
    });
  } else if (cmd === "forecast") {
    cmd_forecast({ force: argv.includes("--force") });
  } else if (cmd === "fetch-pricing") {
    await cmd_fetch_pricing({ oauth: argv.includes("--oauth") });
  } else if (cmd === "pricing") {
    cmd_pricing();
  } else {
    printErr(`unknown command: ${cmd}`);
    process.exit(2);
  }
}

// Only dispatch the CLI when invoked directly (not on import).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT) {
  main().catch((e) => {
    printErr(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
