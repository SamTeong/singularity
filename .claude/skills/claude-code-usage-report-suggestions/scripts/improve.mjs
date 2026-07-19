// claude-code-usage-report-suggestions: audit the claude-code-usage-report pipeline end-to-end (capture -> schema ->
// aggregation -> visualization) and emit a prioritized improvement roadmap.
// Read-only, stdlib only. Imports claude-code-usage-report's stats.mjs as the data layer.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
// Forward-slash base for fs.globSync (a backslash is a glob escape on Windows).
const PROJECTS_GLOB = PROJECTS_DIR.replace(/\\/g, "/");
// State root; USAGE_REPORT_STATE overrides it (must match stats.mjs/statusline.mjs).
const SKILL_STATE_DIR = process.env.USAGE_REPORT_STATE || path.join(HOME, ".agents", ".claude-code-usage-report", "state");
const SESSIONS_JSONL = path.join(SKILL_STATE_DIR, "sessions.jsonl");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);

// ---- fs helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _sibling_skill(name, file) {
  // Resolve a sibling skill's script path without hardcoding the install root.
  const anchor = path.join(path.dirname(SKILL_DIR), name, "scripts", file);
  const cands = [
    anchor,
    path.join(HOME, ".agents", "skills", name, "scripts", file),
    path.join(HOME, ".claude", "skills", name, "scripts", file),
  ];
  for (const cand of cands) {
    if (isFile(cand)) return cand;
  }
  return anchor;
}

const STATS_MJS = _sibling_skill("claude-code-usage-report", "stats.mjs");

async function _load_stats_module() {
  // Import claude-code-usage-report's stats.mjs so we reuse its single-pass CSV loader (DRY).
  try {
    return await import(pathToFileURL(STATS_MJS).href);
  } catch {
    return null;
  }
}

function countDir(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function _data_inventory() {
  let archive = 0;
  if (isFile(SESSIONS_JSONL)) {
    try {
      const text = fs.readFileSync(SESSIONS_JSONL, "utf-8");
      archive = text ? text.trimEnd().split("\n").filter(Boolean).length : 0;
    } catch {
      archive = 0;
    }
  }
  return {
    transcripts: fs.globSync(`${PROJECTS_GLOB}/*/*.jsonl`).length,
    history: isFile(path.join(CLAUDE_DIR, "history.jsonl")),
    tasks: countDir(path.join(CLAUDE_DIR, "tasks")),
    file_history: countDir(path.join(CLAUDE_DIR, "file-history")),
    archive,
  };
}

// ---- roadmap ----

async function build_roadmap() {
  // Return { suggestions, inventory, totals, usage }.
  // Each suggestion: {area, status in (available|partial|idea), text}.
  const inv = _data_inventory();
  const stats_found = isFile(STATS_MJS);
  const m = stats_found ? await _load_stats_module() : null;
  let sessions = [];
  let totals = { sessions: 0 };
  let usage = { tools: {}, agents: {}, skills: {} };
  if (m !== null && isFile(m.STATS_CSV)) {
    try {
      const c = m._load_stats();
      sessions = c.sessions;
      totals = c.totals;
      usage = c.usage;
    } catch {
      /* leave defaults */
    }
  }
  const n = totals.sessions || 1;
  const loc_cov = sessions.reduce((acc, s) => acc + (((s.la || 0) + (s.lr || 0)) > 0 ? 1 : 0), 0);
  const sg = [];

  function add(area, status, text) {
    sg.push({ area, status, text });
  }

  // --- data you already have locally but the report doesn't chart yet ---
  if (inv.history) {
    add("Prompt patterns", "available",
      "history.jsonl present — add prompt-length distribution, prompts/session, and " +
      "think-time between prompts (when in the day you're most productive).");
  }
  if (inv.tasks) {
    add("Task completion", "available",
      `${inv.tasks} TaskCreate todo lists in ~/.claude/tasks — add a todo ` +
      "completion-rate stat (done vs abandoned per session).");
  }
  if (inv.file_history) {
    add("File churn", "available",
      `${inv.file_history} file-history snapshots — surface most-edited files/repos ` +
      "and real churn, independent of statusline line counts.");
  }
  add("Response latency", "available",
    "Transcript message timestamps support a think-time vs generation-time split per session.");

  // --- capture/coverage gaps (fill as more sessions record) ---
  add("LOC coverage", "partial",
    `lines added/removed present for ${loc_cov}/${totals.sessions || 0} sessions ` +
    `(${Math.round(loc_cov / n * 100)}%); $/line is now cost-scoped to line-bearing rows and ` +
    "shown as '—' below 5% coverage. Value still firms up as more sessions record via the statusline.");
  add("Active-time tracking", "partial",
    "$/hour now uses an active-time proxy (cost>0 sessions, per-session duration uncapped " +
    "— legit sessions can exceed 8h) instead of raw transcript wall-clock span, which " +
    "counted idle/hung sessions (e.g. 577h @ $0). The $0-cost filter alone drops " +
    "idle/hung sessions; proxy still underestimates real hourly cost because idle is " +
    "distributed within billed sessions; a true fix needs turn-level active-time capture " +
    "in the statusline, not transcript span.");
  add("Rate-limit utilization", "partial",
    "rl_5h_pct / rl_7d_pct now charted (utilization %, throttle-safety >80%/100%, " +
    "spend per 7d%-point at peak). Forward-only from the statusline rate_limits field " +
    "(Claude Code v2.1.80+, Claude.ai Pro/Max only — absent for API-key/Bedrock/Vertex " +
    "and some Max 20x oauth users). Coverage grows as sessions record; efficient-use " +
    "judgment firms up once a full 7-day window is captured.");
  add("Rate-limit forecast", "done",
    "Empirical-Bayes forecast (claumon MODEL v2.1 port, forecast.mjs) projects each " +
    "gauge to its reset boundary with an 80% credible interval + ETA-to-threshold, " +
    "fit from OAuth usage-snapshots; prior-only statusline-rl fallback when OAuth is off. " +
    "`stats.mjs forecast [--force]` prints/forces the fit (state/forecast.json).");
  add("Prior calibration", "done",
    "Out-of-sample audit of the percentile cost priors (Phase E): hold out the most " +
    "recent ~20% of cost-calibrated ops per category, refit p50/p90, score coverage / " +
    "bias / pinball. Printed by `priors` (p90 cov / bias columns) and `estimate` (OOS " +
    "calibration row); p90 coverage < 0.70 flagged as unreliable.");
  add("Live pricing refresh", "done",
    "Layered pricing (Phase F): embedded PRICE → 24h cache (state/pricing-cache.json, " +
    "from `fetch-pricing --oauth`) → time-bounded PROMOS → manual pricing.json override. " +
    "Sonnet 5 intro $2/$10 reflected via PROMOS through 2026-08-31. `fetch-pricing --oauth` " +
    "pulls claumon's remote, reduces model-ids to family keys; `pricing` prints the resolved table.");
  add("Subagent tokens in est cost", "done",
    "Phase G: est_cost_usd (no-billed sessions) now folds in subagent-run transcript " +
    "tokens, summed per assistant message with _msg_cost_tiered. The isSidechain skip is " +
    "scoped to the main transcript (subagent files are themselves the sidechain). Billed " +
    "sessions unchanged; priors still calibrate on billed only.");
  add("EB shrinkage in estimate", "done",
    "Phase H: small-n category cost priors are shrunk toward a cross-category grand " +
    "mean (FC.fitPrior between-category variance + normal-normal conjugacy; shift scaled " +
    "by per-category withinVar/n). Stored per category as `shrink`; `estimate` prints a " +
    "`shrunk (EB, small-n)` row when n_cost < 20. Large-n categories keep raw (data-weight≈1).");
  add("Active-session detection", "done",
    "Phase I: report excludes the mid-flight session via cost-state freshness (statusline " +
    "rewrites cost-state/<sid>.json per render; fresh <900s = live) instead of the old 180s " +
    "transcript-mtime window, which mislabeled a paused-but-live session as closed and folded " +
    "its incomplete transcript in. Stale lingering cost-state (hook-missed) still folds in; " +
    "180s transcript-mtime fallback kept for the no-statusline case.");
  if (inv.archive === 0) {
    add("Statusline archive", "partial",
      "sessions.jsonl is empty — the full-JSON archive fills as new sessions end; future " +
      "metrics (rate-limit trends, context fullness) then need no re-capture.");
  } else {
    add("Statusline archive", "available",
      `${inv.archive} sessions archived in sessions.jsonl — mine rate-limit % and ` +
      "context-fullness trends next.");
  }

  // --- visualization / UX improvements ---
  add("Report UX", "idea",
    "Add a date-range filter, a session search box, sortable tables, and CSV/PNG export.");
  add("Report UX", "idea",
    "Per-project filter mirroring the model filter; drill from a project into its sessions.");
  add("Cross-tool", "idea",
    "Reconcile against other AI-coding spend trackers (e.g. CodeBurn, agent-insights) " +
    "for spend across Copilot, Cursor, Codex, if you use any.");
  return { suggestions: sg, inventory: inv, totals, usage, stats_found };
}

async function cmd_roadmap(args) {
  const { suggestions: sg, inventory: inv, totals, usage, stats_found } = await build_roadmap();
  if (args.json) {
    console.log(JSON.stringify(sg));
    return;
  }
  console.log("=== claude-code-usage-report-suggestions · pipeline audit ===");
  console.log(`stats.mjs found: ${stats_found}   sessions in stats.csv: ${totals.sessions || 0}`);
  console.log(`transcripts=${inv.transcripts}  history.jsonl=${inv.history}  tasks=${inv.tasks}  ` +
    `file-history=${inv.file_history}  sessions.jsonl=${inv.archive}`);
  if (usage.tools && Object.keys(usage.tools).length) {
    const entries = Object.entries(usage.tools);
    entries.sort((a, b) => b[1] - a[1]); // stable: preserves insertion order on ties
    const top = Object.fromEntries(entries.slice(0, 8));
    console.log(`top tools: ${JSON.stringify(top)}`);
  }
  console.log("\n=== roadmap (status · area · idea) ===");
  for (const s of sg) {
    console.log(`[${s.status.padEnd(9)}] ${s.area}: ${s.text}`);
  }
  console.log("\nImplement an item: ask to add it; the agent edits stats.mjs/statusline.mjs and re-runs backfill+report.");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    process.stderr.write(`improve.mjs: error: ${e.message}\n`);
    process.exit(2);
  }
  const cmd = parsed.positionals[0];
  if (cmd === "roadmap") {
    await cmd_roadmap(parsed.values);
  } else {
    process.stderr.write("improve.mjs: error: the following arguments are required: cmd\n");
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});