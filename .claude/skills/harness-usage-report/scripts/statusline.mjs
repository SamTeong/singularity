// Cross-platform statusline for the harness-usage-report capture pipeline.
//
// Contract (the only hard requirement): write the raw statusline JSON payload
// — read verbatim from stdin — to
//     ~/.agents/.harness-usage-report/state/cost-state/<session_id>.json
// (last write per session wins ≈ final snapshot). The harness-usage-report SessionEnd
// hook then projects that JSON into stats.csv and archives it to sessions.jsonl.
// It also appends a deduped per-render row to state/cost-history.jsonl (appendHistory).
//
// Everything below the contract renders the three-line status display: model,
// context usage bar, cost / rate limits (5h/7d) / dir, worktree, git status.
// Invoke explicitly: `node statusline.mjs` (Node is guaranteed on PATH; shebang
// is not honoured on Windows).
import { mkdirSync, writeFileSync, statSync, readFileSync, appendFileSync, renameSync, rmdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// --- Read stdin verbatim ---
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");

let d;
try { d = JSON.parse(raw); } catch { process.exit(0); }

const stateRoot = process.env.USAGE_REPORT_STATE || join(homedir(), ".agents", ".harness-usage-report", "state");
const stateDir = join(stateRoot, "cost-state");

// --- Contract: persist the raw payload ---
const g = (...path) => {
  let c = d;
  for (const k of path) {
    if (c === null || typeof c !== "object") return undefined;
    c = c[k];
  }
  return c;
};
const sid = (g("session_id") || "").trim();
// Guard the join: sid comes from the statusline payload — reject anything that
// isn't hex+hyphens (≤64) so a crafted session_id can't escape stateDir via ../.
if (sid && /^[0-9a-fA-F-]{1,64}$/.test(sid)) {
  const file = join(stateDir, sid + ".json");
  try {
    appendHistory(file);
  } catch { /* never break the status line */ }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, raw, { encoding: "utf8", mode: 0o600 });
  } catch { /* never break the status line */ }
}

// Per-render series: one row to cost-history.jsonl when this session's cost or
// 5h % moved since its previous payload (the cost-state file about to be
// overwritten holds it, so dedup never reads the jsonl). Above HISTORY_CAP the
// file rotates to cost-history.jsonl.1, replacing the old one: at most two files.
// The cap matches the daemon's 2 MB tail read (usage-history.mjs), so both files are read whole.
// A mkdir lock serialises check+rename so a second render can't rename the fresh file over .1;
// a render that loses the lock skips rotation. Stale locks are left in place: reclaiming a
// directory by pathname has no compare-and-swap, so two stale-lock observers can steal from
// each other. A stale lock can stop rotation until manually cleared, but never races writers.
function rotateHistory(hist, cap) {
  const lock = hist + ".lock";
  try { mkdirSync(lock); } catch { return; }
  try { if (statSync(hist).size > cap) renameSync(hist, hist + ".1"); } catch { /* not there yet, or rename failed */ }
  finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}
function appendHistory(file) {
  const HISTORY_CAP = 2 * 1024 * 1024;
  const pick = (o) => [o?.cost?.total_cost_usd ?? null, o?.rate_limits?.five_hour?.used_percentage ?? null];
  const now = pick(d);
  let prev = null;
  try { prev = pick(JSON.parse(readFileSync(file, "utf8"))); } catch { /* first render or SessionEnd removed it */ }
  if (prev && prev[0] === now[0] && prev[1] === now[1]) return;
  const hist = join(stateRoot, "cost-history.jsonl");
  rotateHistory(hist, HISTORY_CAP);
  let size = 0;
  try { size = statSync(hist).size; } catch { /* not there yet */ }
  if (size > 2 * HISTORY_CAP) return; // rotation keeps failing: skip the append, keep the cap
  const cw = g("context_window") || {};
  const tokens = Number.isFinite(cw.total_input_tokens) || Number.isFinite(cw.total_output_tokens)
    ? { input: cw.total_input_tokens ?? null, output: cw.total_output_tokens ?? null }
    : null;
  mkdirSync(stateRoot, { recursive: true });
  appendFileSync(hist, JSON.stringify({
    ts: new Date().toISOString(), session_id: sid, cost_usd: now[0], tokens,
    five_hour_pct: now[1], five_hour_resets_at: g("rate_limits", "five_hour", "resets_at") ?? null,
  }) + "\n", { encoding: "utf8", mode: 0o600 });
}

// --- ANSI ---
const ESC = "\x1b";
const GREEN = ESC + "[32m", YELLOW = ESC + "[33m", RED = ESC + "[31m", RESET = ESC + "[0m";
const colorFor = (pct) => (pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN);

const roundHalfUp = (v) => Math.floor(Number(v) + 0.5);
const roundPct = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const r = roundHalfUp(v);
  return r > 100 ? 100 : r;
};
const fmtTokens = (n) => {
  if (n === null || n === undefined || n === "") return "";
  n = Number(String(n).replace(/,/g, ""));
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "m";
  if (n >= 1000) return roundHalfUp(n / 1000) + "k";
  return String(Math.trunc(n));
};

// --- Fields ---
const model = g("model", "display_name") || "Unknown Model";
const effort = g("effort", "level");
const totalCost = g("cost", "total_cost_usd");
const currentDir = g("workspace", "current_dir") || g("cwd");
const worktree = g("worktree", "name");

const cu = g("context_window", "current_usage") || {};
const used = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
  .reduce((s, k) => s + (cu[k] || 0), 0);
const windowSize = g("context_window", "context_window_size");

// --- Usage string ---
let usedDisplay = 0, usageStr = "0%";
if (used && windowSize) {
  usedDisplay = roundHalfUp((used / Number(windowSize)) * 100);
  if (usedDisplay < 0) usedDisplay = 0;
  usageStr = `${usedDisplay}% [${fmtTokens(used)}/${fmtTokens(windowSize)}]`;
}
const usageSeg = `${colorFor(usedDisplay)}${usageStr}${RESET}`;

// --- Cost ---
const costStr = (totalCost !== null && totalCost !== undefined && totalCost !== "")
  ? "$" + Number(totalCost).toFixed(2)
  : "$0.00";

// --- Rate limits ---
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtClock = (dt) => {
  // 12-hour, no leading zero, uppercase AM/PM (e.g. 3:45PM)
  const h = dt.getHours(), m = dt.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
};
const fmtRl = (pct, resetTs, label, showDate) => {
  if (pct === null || pct === undefined || pct === "" || resetTs === null || resetTs === undefined || resetTs === "") return "";
  const local = new Date(Math.trunc(resetTs) * 1000);
  let s = `${label} ${pct}% ${fmtClock(local)}`;
  if (showDate) s += ` ${local.getDate()} ${MONTHS[local.getMonth()]} (${WEEKDAYS[local.getDay()]})`;
  return `${colorFor(pct)}${s}${RESET}`;
};

const rlParts = [];
const s5 = fmtRl(roundPct(g("rate_limits", "five_hour", "used_percentage")), g("rate_limits", "five_hour", "resets_at"), "5h", false);
if (s5) rlParts.push(s5);
const s7 = fmtRl(roundPct(g("rate_limits", "seven_day", "used_percentage")), g("rate_limits", "seven_day", "resets_at"), "7d", true);
if (s7) rlParts.push(s7);
const rateLimitStr = rlParts.join(" | ");

// --- Git (porcelain status + rev-parse; -C avoids changing cwd) ---
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", currentDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
};
let gitStr = "no branch";
let repoRoot = currentDir;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

if (currentDir && isDir(currentDir)) {
  const status = git("status", "--porcelain=v2", "--branch");
  if (status !== null) {
    let branch = "", staged = 0, modified = 0;
    for (const line of status.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        branch = line.slice(14);
      } else if (line.length >= 4 && (line[0] === "1" || line[0] === "2" || line[0] === "u")) {
        const xy = line.slice(2, 4);
        if (xy[0] !== ".") staged++;
        if (xy[1] !== ".") modified++;
      }
    }
    const rp = git("rev-parse", "--show-toplevel", "--short", "HEAD");
    if (rp) {
      const rpLines = rp.split("\n");
      const top = rpLines[0] && rpLines[0].trim();
      if (top) repoRoot = top;
      if (branch === "(detached)" && rpLines[1]) branch = rpLines[1].trim();
    }
    gitStr = branch;
    if (staged) gitStr += ` ${GREEN}+${staged}${RESET}`;
    if (modified) gitStr += ` ${YELLOW}~${modified}${RESET}`;
  }
}

const dirDisplay = repoRoot || "";

// --- Skill-scopes (added via --add-dir; only dirs under ~/.agents/skill-scopes) ---
const scopesRoot = join(homedir(), ".agents", "skill-scopes");
const scopes = (g("workspace", "added_dirs") || [])
  .filter((p) => typeof p === "string" && p.startsWith(scopesRoot))
  .map((p) => basename(p))
  .filter(Boolean);

// --- Output (two lines); only include segments that have data ---
// ASCII only, deliberately. Every emoji here (🤖 🧠 💰 ⏳ 📁 🌳 🌿 🧩) is a
// width-ambiguous glyph: the renderer's cell count disagrees with what the
// terminal actually draws, so the in-place redraw skips cells it thinks are
// unchanged and leaves stale characters from the previous frame wedged into
// the new one. Keep this line 7-bit — no emoji, no box-drawing bars.
// Cache-TTL countdown: cache-refresh plugin records the main-agent turn end.
let ttlSeg = "";
try {
  if (sid && /^[0-9a-fA-F-]{1,64}$/.test(sid)) {
    const { turnEndMs } = JSON.parse(readFileSync(join(stateRoot, "cache-ttl", sid + ".json"), "utf8"));
    if (Number.isFinite(turnEndMs)) {
      ttlSeg = ` ${Math.max(0, 60 - Math.floor((Date.now() - turnEndMs) / 60000))}m`;
    }
  }
} catch { /* no TTL segment */ }
const p1 = [effort ? `${model} ${effort}` : model, usageSeg + ttlSeg, costStr];
if (rateLimitStr) p1.push(rateLimitStr);
const line1 = p1.join(" | ");

const p2 = [];
if (sid) p2.push(sid);
p2.push(dirDisplay);
if (worktree) p2.push(worktree);
p2.push(gitStr);
if (scopes.length) p2.push(scopes.join(","));
const line2 = p2.join(" | ");

process.stdout.write(line1 + "\n" + line2);
