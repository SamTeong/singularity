// Codex CLI rollout ingestion: folds `~/.codex/sessions/**/rollout-*.jsonl`
// (one file per THREAD, subagent/fork threads share their root's session_id)
// into stats.mjs-shaped rows, one per ROOT session. Node ESM, stdlib only.
// Imported by stats.mjs — never throws, a missing/unreadable ~/.codex is the
// normal case on any machine that hasn't used Codex.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CACHE_VERSION = 1;

// Keyset stats.mjs asserts on every ingested row (order mirrors its HEADER).
export const CODEX_ROW_KEYS = [
  "timestamp", "session_id", "total_cost_usd", "last_model", "input_tokens",
  "output_tokens", "cache_read_tokens", "cache_creation_tokens", "model_id",
  "model_display_name", "duration_ms", "api_duration_ms", "lines_added",
  "lines_removed", "rl_5h_pct", "rl_7d_pct", "context_pct",
  "context_window_size", "turns", "tool_calls", "start_epoch", "facets_json",
  "est_cost_usd",
];

// codex-auto-review is an internal reviewer thread, not the model actually
// doing the work — letting it win last_model misprices the whole session.
const AUTO_REVIEW_MODEL = "codex-auto-review";
const UNKNOWN_MODEL_RE = /^(gpt-|codex)/i;

function _default_codex_home() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

// Rollouts move from sessions/ into archived_sessions/ over time; scan both.
function _rollout_files(codexHome) {
  const out = [];
  for (const base of [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) {
    if (!isDir(base)) continue;
    const baseGlob = base.replace(/\\/g, "/"); // fs.globSync treats \ as an escape on Windows
    try {
      for (const p of fs.globSync(`${baseGlob}/**/rollout-*.jsonl`)) out.push(p);
    } catch (e) {
      console.error(`codex.mjs: glob failed under ${base}: ${e && e.message}`);
    }
  }
  return out;
}

// Filename embeds the thread's own id (rollout-<ts>-<threadid>.jsonl), so it
// doubles as the cache key without having to open the file first.
function _thread_id_from_filename(p) {
  const base = path.basename(p, ".jsonl");
  const m = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(base);
  return m ? m[1] : base;
}

export function codexMtimes(deps = {}) {
  const codexHome = deps.codexHome || _default_codex_home();
  const out = [];
  for (const p of _rollout_files(codexHome)) {
    try {
      out.push(fs.statSync(p).mtimeMs / 1000);
    } catch (e) {
      console.error(`codex.mjs: stat failed for ${p}: ${e && e.message}`);
    }
  }
  return out;
}

// ---- per-thread parse ----

// Read+parse one rollout file. Throws (caller catches) only on a read
// failure — a locked/EBUSY file on Windows must not abort the whole scan. A
// malformed individual line is skipped and parsing continues.
function* _iter_jsonl_or_throw(p) {
  const text = fs.readFileSync(p, "utf-8");
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

function _new_thread_res() {
  return {
    rootId: null,
    cwd: "",
    startEpoch: null,
    endEpoch: null,
    turns: 0,
    toolCalls: 0,
    tools: {},
    turnContexts: [], // {epoch, model}
    tokenReadings: [], // {epoch, model, i (non-cached input), o, cr, cc}
    rateReadings: [], // {epoch, usedPercent, resetsAt}
    contextWindowSize: null, // {epoch, size}
  };
}

function _parse_thread(filePath, fallbackId, epochFromIso) {
  const res = _new_thread_res();
  let metaSeen = false;
  let currentModel = null;

  for (const o of _iter_jsonl_or_throw(filePath)) {
    if (!o || typeof o !== "object") continue;
    const ts = epochFromIso(o.timestamp);
    if (ts !== null) {
      if (res.startEpoch === null || ts < res.startEpoch) res.startEpoch = ts;
      if (res.endEpoch === null || ts > res.endEpoch) res.endEpoch = ts;
    }
    const typ = o.type;
    const p = o.payload || {};

    if (typ === "session_meta") {
      // Appears 1-2x per file (a subagent thread's file also embeds the
      // root's own meta) — take only the first, which is this thread's own.
      // Verified across 124 real rollouts: no file has >1 distinct session_id; second meta is parent's meta replayed into fork (same session_id, different id).
      if (!metaSeen) {
        metaSeen = true;
        res.rootId = p.session_id || p.id || fallbackId;
        res.cwd = p.cwd || "";
      }
      continue;
    }
    if (typ === "turn_context") {
      if (p.model) {
        currentModel = p.model;
        res.turnContexts.push({ epoch: ts, model: p.model });
      }
      continue;
    }
    if (typ === "response_item") {
      if (p.type === "custom_tool_call" || p.type === "function_call") {
        res.toolCalls += 1;
        const nm = `codex:${p.name || "?"}`;
        res.tools[nm] = (res.tools[nm] || 0) + 1;
      }
      continue;
    }
    if (typ !== "event_msg") continue;

    if (p.type === "user_message") {
      res.turns += 1;
    } else if (p.type === "mcp_tool_call_end") {
      res.toolCalls += 1;
      const nm = `codex:${_dig(p, "invocation", "tool") || "?"}`;
      res.tools[nm] = (res.tools[nm] || 0) + 1;
    } else if (p.type === "token_count") {
      const info = p.info || {};
      const last = info.last_token_usage || {};
      const rawIn = _num(last.input_tokens);
      const cr = _num(last.cached_input_tokens);
      const cc = _num(last.cache_write_input_tokens);
      const outT = _num(last.output_tokens);
      // input_tokens includes cached_input_tokens — strip it so cache_read
      // and input are reported disjointly, matching the CSV schema.
      if (rawIn || cr || cc || outT) {
        res.tokenReadings.push({ epoch: ts, model: currentModel, i: Math.max(0, rawIn - cr), o: outT, cr, cc });
      }
      if (typeof info.model_context_window === "number") {
        if (!res.contextWindowSize || (ts ?? -Infinity) >= (res.contextWindowSize.epoch ?? -Infinity)) {
          res.contextWindowSize = { epoch: ts, size: info.model_context_window };
        }
      }
      const primary = _dig(p, "rate_limits", "primary");
      if (primary && typeof primary.used_percent === "number") {
        res.rateReadings.push({ epoch: ts, usedPercent: primary.used_percent, resetsAt: primary.resets_at ?? null });
      }
    }
  }

  if (!metaSeen) res.rootId = fallbackId;
  // A call with no preceding turn_context in this thread (edge case — every
  // real rollout emits turn_context before its first token_count) falls back
  // to the thread's last known model rather than going unpriced.
  for (const r of res.tokenReadings) {
    if (!r.model) r.model = currentModel || "";
  }
  return res;
}

// ---- mtime-gated per-thread cache (codex-cache.json) ----

function _load_cache(cachePath) {
  if (!isFile(cachePath)) return { version: CACHE_VERSION, threads: {}, _dirty: false };
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (!c || c.version !== CACHE_VERSION) return { version: CACHE_VERSION, threads: {}, _dirty: true };
    c.threads = (c.threads && typeof c.threads === "object" && !Array.isArray(c.threads)) ? c.threads : {};
    c._dirty = false;
    return c;
  } catch {
    return { version: CACHE_VERSION, threads: {}, _dirty: true };
  }
}

function _save_cache(cachePath, cache) {
  if (!cache._dirty) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ version: cache.version, threads: cache.threads }), { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* non-fatal: a missed cache write just means re-parsing next time */
  }
}

// ---- session (root) folding ----

function _new_session_acc() {
  return {
    startEpoch: null, endEpoch: null, turns: 0, toolCalls: 0, tools: {}, cwd: "", cwdEpoch: null,
    turnContexts: [], tokenReadings: [], rateReadings: [], contextWindowSize: null,
  };
}

function _merge_thread_into_session(acc, res) {
  if (res.startEpoch !== null && (acc.startEpoch === null || res.startEpoch < acc.startEpoch)) acc.startEpoch = res.startEpoch;
  if (res.endEpoch !== null && (acc.endEpoch === null || res.endEpoch > acc.endEpoch)) acc.endEpoch = res.endEpoch;
  acc.turns += res.turns;
  acc.toolCalls += res.toolCalls;
  for (const [k, v] of Object.entries(res.tools)) acc.tools[k] = (acc.tools[k] || 0) + v;
  if (res.cwd && (acc.cwdEpoch === null || res.startEpoch < acc.cwdEpoch)) { acc.cwd = res.cwd; acc.cwdEpoch = res.startEpoch; }
  acc.turnContexts.push(...res.turnContexts);
  acc.tokenReadings.push(...res.tokenReadings);
  acc.rateReadings.push(...res.rateReadings);
  if (res.contextWindowSize && (!acc.contextWindowSize || (res.contextWindowSize.epoch ?? -Infinity) >= (acc.contextWindowSize.epoch ?? -Infinity))) {
    acc.contextWindowSize = res.contextWindowSize;
  }
}

function _last_by_epoch(list) {
  let best = null;
  for (const item of list) {
    if (best === null || (item.epoch ?? -Infinity) >= (best.epoch ?? -Infinity)) best = item;
  }
  return best;
}

// stats.mjs's price table falls through unknown models to opus — that would
// bill a Codex session as Anthropic. Warn once per distinct offending model.
function _maybe_warn_unknown_model(model, priceKey, warned) {
  if (!model || warned.has(model)) return;
  if (UNKNOWN_MODEL_RE.test(model) && priceKey(model) === "opus") {
    warned.add(model);
    console.error(`codex.mjs: unrecognized Codex model "${model}" falls through to opus pricing`);
  }
}

// Append newly-observed weekly-quota readings, deduped against the file's
// last line then within this pass. `readings` should only contain readings
// from threads reparsed THIS run (cache hits carry readings already recorded
// in a prior pass) so an unchanged ~/.codex produces zero new lines.
function _append_usage_jsonl(usagePath, readings, localFmt) {
  if (!readings.length) return;
  let lastPair = null;
  if (isFile(usagePath)) {
    try {
      const lines = fs.readFileSync(usagePath, "utf-8").split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]);
        lastPair = [last.weekly.utilization, last.weekly.resets_at];
      }
    } catch {
      lastPair = null;
    }
  }
  const out = [];
  for (const r of readings) {
    const pair = [r.usedPercent, r.resetsAt];
    if (lastPair && lastPair[0] === pair[0] && lastPair[1] === pair[1]) continue;
    out.push(JSON.stringify({ fetched_at: localFmt(r.epoch), weekly: { utilization: r.usedPercent, resets_at: r.resetsAt } }));
    lastPair = pair;
  }
  if (!out.length) return;
  try {
    fs.mkdirSync(path.dirname(usagePath), { recursive: true });
    fs.appendFileSync(usagePath, out.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    console.error(`codex.mjs: failed to write ${usagePath}: ${e && e.message}`);
  }
}

export function codexIngest(deps = {}) {
  const codexHome = deps.codexHome || _default_codex_home();
  const { stateDir, localFmt, epochFromIso, msgCostTiered, priceKey } = deps;
  const cachePath = path.join(stateDir, "codex-cache.json");
  const usagePath = path.join(stateDir, "codex-usage.jsonl");
  const cache = _load_cache(cachePath);

  const files = _rollout_files(codexHome);
  const threadResults = {}; // fileKey -> res (this run's full view, cached or fresh)
  const freshReadings = []; // rate readings from threads reparsed THIS run only
  const seen = new Set();
  let skipped = 0;

  for (const f of files) {
    const key = _thread_id_from_filename(f);
    seen.add(key);
    let mtime;
    try {
      mtime = fs.statSync(f).mtimeMs / 1000;
    } catch (e) {
      console.error(`codex.mjs: stat failed for ${f}: ${e && e.message}`);
      skipped += 1;
      continue;
    }
    const cached = cache.threads[key];
    if (cached && cached.mtime === mtime && cached.res) {
      threadResults[key] = cached.res;
      continue;
    }
    let res;
    try {
      res = _parse_thread(f, key, epochFromIso);
    } catch (e) {
      console.error(`codex.mjs: unreadable rollout ${f}: ${e && e.message}`);
      skipped += 1;
      continue;
    }
    threadResults[key] = res;
    freshReadings.push(...res.rateReadings);
    cache.threads[key] = { mtime, res };
    cache._dirty = true;
  }

  for (const k of Object.keys(cache.threads)) {
    if (!seen.has(k)) {
      delete cache.threads[k];
      cache._dirty = true;
    }
  }
  _save_cache(cachePath, cache);

  const sessions = {};
  for (const res of Object.values(threadResults)) {
    const rootId = res.rootId;
    if (!sessions[rootId]) sessions[rootId] = _new_session_acc();
    _merge_thread_into_session(sessions[rootId], res);
  }

  const warned = new Set();
  const rows = [];
  for (const [rootId, acc] of Object.entries(sessions)) {
    const latestNonReview = _last_by_epoch(acc.turnContexts.filter((tc) => tc.model !== AUTO_REVIEW_MODEL));
    const latestAny = _last_by_epoch(acc.turnContexts);
    const lastModel = (latestNonReview || latestAny || {}).model || "";
    _maybe_warn_unknown_model(lastModel, priceKey, warned);

    let inputSum = 0, outputSum = 0, crSum = 0, ccSum = 0, estCost = 0;
    for (const r of acc.tokenReadings) {
      inputSum += r.i;
      outputSum += r.o;
      crSum += r.cr;
      ccSum += r.cc;
      const model = r.model || lastModel;
      if (model) {
        _maybe_warn_unknown_model(model, priceKey, warned);
        estCost += msgCostTiered(model, r.i, r.o, r.cr, r.cc);
      }
    }

    const latestRate = _last_by_epoch(acc.rateReadings);
    const hasDuration = acc.startEpoch !== null && acc.endEpoch !== null;

    rows.push({
      timestamp: acc.endEpoch !== null ? localFmt(acc.endEpoch) : "",
      session_id: rootId,
      total_cost_usd: "", // Codex is subscription-billed; no real USD exists
      last_model: lastModel,
      input_tokens: inputSum,
      output_tokens: outputSum,
      cache_read_tokens: crSum,
      cache_creation_tokens: ccSum,
      model_id: lastModel,
      model_display_name: "",
      duration_ms: hasDuration ? Math.trunc((acc.endEpoch - acc.startEpoch) * 1000) : "",
      api_duration_ms: "",
      lines_added: "",
      lines_removed: "",
      rl_5h_pct: "",
      rl_7d_pct: latestRate ? latestRate.usedPercent : "",
      context_pct: "",
      context_window_size: acc.contextWindowSize ? acc.contextWindowSize.size : "",
      turns: acc.turns,
      tool_calls: acc.toolCalls,
      start_epoch: acc.startEpoch !== null ? Math.trunc(acc.startEpoch) : "",
      facets_json: JSON.stringify({
        tools: acc.tools, tool_errors: 0, agents: {}, skills: {}, compactions: 0,
        cwd: acc.cwd, branch: "",
      }),
      est_cost_usd: estCost > 0 ? estCost.toFixed(4) : "",
    });
  }

  freshReadings.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
  _append_usage_jsonl(usagePath, freshReadings, localFmt);

  return { rows, threads: Object.keys(threadResults).length, sessions: rows.length, skipped };
}

// ---- --selftest ----

function _stub_epoch_from_iso(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

function _stub_local_fmt(epoch) {
  const d = new Date(epoch * 1000);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// Deterministic stand-in for stats.mjs's tiered cost function, just enough
// arithmetic to verify est_cost_usd sums call-by-call rather than off totals.
function _stub_msg_cost_tiered(model, i, o, cr, cc) {
  return (i + o + cr + cc) * 0.000001;
}

function _stub_price_key(model) {
  const known = { "codex-test-sol": "sol", "codex-test-terra": "terra", [AUTO_REVIEW_MODEL]: "auto-review" };
  return known[model] || "opus";
}

function _selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selftest failed: ${msg}`);
  };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-selftest-"));
  const stateDir = path.join(home, "state");
  const sessionsDir = path.join(home, "codexhome", "sessions", "2026", "01", "01");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const ROOT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const SUB_ID = "aaaaaaaa-0000-4000-8000-000000000002";
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const iso = (ms) => new Date(t0 + ms).toISOString();

  const rootLines = [
    { timestamp: iso(0), type: "session_meta", payload: { session_id: ROOT_ID, id: ROOT_ID, cwd: "C:\\proj" } },
    { timestamp: iso(1000), type: "turn_context", payload: { model: "codex-test-sol" } },
    { timestamp: iso(2000), type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { timestamp: iso(3000), type: "event_msg", payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 100 }, total_token_usage: { input_tokens: 1000, output_tokens: 100 }, model_context_window: 200000 },
      rate_limits: { primary: { used_percent: 10, window_minutes: 10080, resets_at: 2000000000 }, secondary: null },
    } },
    "not valid json{{{",
    // Simulates a post-compaction reset: total_token_usage drops even though
    // real usage keeps accruing — codexIngest must sum last_token_usage only.
    { timestamp: iso(4000), type: "event_msg", payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50 }, total_token_usage: { input_tokens: 500, output_tokens: 50 }, model_context_window: 200000 },
      rate_limits: { primary: { used_percent: 12, window_minutes: 10080, resets_at: 2000000000 }, secondary: null },
    } },
    { timestamp: iso(5000), type: "response_item", payload: { type: "custom_tool_call", name: "exec" } },
    { timestamp: iso(6000), type: "response_item", payload: { type: "function_call", name: "wait" } },
    { timestamp: iso(7000), type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "lean-ctx", tool: "ctx_read" } } },
  ];
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${ROOT_ID}.jsonl`),
    rootLines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );

  const subLines = [
    { timestamp: iso(60000), type: "session_meta", payload: { session_id: ROOT_ID, id: SUB_ID, cwd: "C:\\proj\\sub" } },
    { timestamp: iso(61000), type: "turn_context", payload: { model: "codex-test-terra" } },
    { timestamp: iso(62000), type: "event_msg", payload: { type: "user_message", message: "subtask" } },
    { timestamp: iso(63000), type: "event_msg", payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 0, cache_write_input_tokens: 50, output_tokens: 20 }, total_token_usage: { input_tokens: 300, output_tokens: 20 }, model_context_window: 200000 },
      rate_limits: { primary: { used_percent: 15, window_minutes: 10080, resets_at: 2000000000 }, secondary: null },
    } },
    { timestamp: iso(64000), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch" } },
  ];
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-2026-01-01T00-01-00-${SUB_ID}.jsonl`),
    subLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );

  // A directory named like a rollout file: readFileSync throws EISDIR,
  // simulating a locked/unreadable file. Must not abort the scan.
  fs.mkdirSync(path.join(sessionsDir, "rollout-2026-01-01T00-02-00-aaaaaaaa-0000-4000-8000-000000000003.jsonl"));

  const deps = {
    codexHome: path.join(home, "codexhome"),
    stateDir,
    localFmt: _stub_local_fmt,
    epochFromIso: _stub_epoch_from_iso,
    msgCostTiered: _stub_msg_cost_tiered,
    priceKey: _stub_price_key,
  };

  const result1 = codexIngest(deps);
  assert(result1.skipped === 1, `expected 1 skipped (the fake directory), got ${result1.skipped}`);
  assert(result1.threads === 2, `expected 2 parsed threads, got ${result1.threads}`);
  assert(result1.sessions === 1, `expected threads folded into 1 root session, got ${result1.sessions}`);

  const row = result1.rows[0];
  assert(Object.keys(row).sort().join(",") === CODEX_ROW_KEYS.slice().sort().join(","), "row keyset mismatch");
  assert(row.session_id === ROOT_ID, `expected root session_id ${ROOT_ID}, got ${row.session_id}`);
  // input_tokens excludes cache: (1000-200) + (500-100) + 300 = 1500
  assert(row.input_tokens === 1500, `expected input_tokens 1500, got ${row.input_tokens}`);
  assert(row.cache_read_tokens === 300, `expected cache_read_tokens 300, got ${row.cache_read_tokens}`);
  assert(row.cache_creation_tokens === 50, `expected cache_creation_tokens 50, got ${row.cache_creation_tokens}`);
  // output: 100 + 50 + 20 = 170
  assert(row.output_tokens === 170, `expected output_tokens 170, got ${row.output_tokens}`);
  assert(row.turns === 2, `expected turns 2, got ${row.turns}`);
  assert(row.tool_calls === 4, `expected tool_calls 4, got ${row.tool_calls}`);
  // subagent's turn_context is chronologically last -> its model wins
  assert(row.last_model === "codex-test-terra", `expected last_model codex-test-terra, got ${row.last_model}`);
  assert(row.rl_7d_pct === 15, `expected rl_7d_pct 15 (latest reading), got ${row.rl_7d_pct}`);
  assert(row.context_window_size === 200000, `expected context_window_size 200000, got ${row.context_window_size}`);
  assert(row.total_cost_usd === "", "total_cost_usd must be blank (Codex is subscription-billed)");
  const expectCost = ((800 + 100 + 200 + 0) + (400 + 50 + 100 + 0) + (300 + 20 + 0 + 50)) * 0.000001;
  assert(row.est_cost_usd === expectCost.toFixed(4), `expected est_cost_usd ${expectCost.toFixed(4)}, got ${row.est_cost_usd}`);
  const facets = JSON.parse(row.facets_json);
  assert(facets.tools["codex:exec"] === 1, "expected facets.tools codex:exec=1");
  assert(facets.tools["codex:ctx_read"] === 1, "expected facets.tools codex:ctx_read=1");
  assert(facets.cwd === "C:\\proj", `expected facets.cwd from the root thread, got ${facets.cwd}`);

  const usagePath = path.join(stateDir, "codex-usage.jsonl");
  const linesAfterFirst = fs.readFileSync(usagePath, "utf-8").split(/\r?\n/).filter((l) => l.trim()).length;
  assert(linesAfterFirst > 0, "expected codex-usage.jsonl to gain lines on first ingest");

  // Second run over unchanged data: cache hits everywhere, zero new readings
  // gathered, usage.jsonl must not grow.
  const result2 = codexIngest(deps);
  assert(result2.skipped === 1 && result2.sessions === 1, "second run should reproduce the same shape");
  const linesAfterSecond = fs.readFileSync(usagePath, "utf-8").split(/\r?\n/).filter((l) => l.trim()).length;
  assert(linesAfterSecond === linesAfterFirst, `codex-usage.jsonl grew on an unchanged rerun: ${linesAfterFirst} -> ${linesAfterSecond}`);

  // Nonexistent codexHome must degrade to empty results, never throw.
  const missingResult = codexIngest({ ...deps, codexHome: path.join(home, "does-not-exist") });
  assert(missingResult.rows.length === 0 && missingResult.skipped === 0, "nonexistent codexHome should return empty, not throw");
  const missingMtimes = codexMtimes({ codexHome: path.join(home, "does-not-exist") });
  assert(Array.isArray(missingMtimes) && missingMtimes.length === 0, "codexMtimes on a missing codexHome should return []");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok");
}

// Only dispatch the CLI when invoked directly (not on import), mirroring stats.mjs.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--selftest")) {
    try {
      _selftest();
    } catch (e) {
      console.error(String(e && e.message ? e.message : e));
      process.exit(1);
    }
  } else {
    console.error("usage: codex.mjs --selftest");
    process.exit(2);
  }
}
