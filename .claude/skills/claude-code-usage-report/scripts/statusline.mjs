// Cross-platform statusline for the claude-code-usage-report capture pipeline.
//
// Contract (the only hard requirement): write the raw statusline JSON payload
// — read verbatim from stdin — to
//     ~/.agents/.claude-code-usage-report/state/cost-state/<session_id>.json
// (last write per session wins ≈ final snapshot). The claude-code-usage-report SessionEnd
// hook then projects that JSON into stats.csv and archives it to sessions.jsonl.
//
// Everything below the contract renders the two-line status display: model,
// context usage bar, cost, rate limits (5h/7d), dir, worktree, git status.
// Invoke explicitly: `node statusline.mjs` (Node is guaranteed on PATH; shebang
// is not honoured on Windows).
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// --- Read stdin verbatim ---
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");

let d;
try { d = JSON.parse(raw); } catch { process.exit(0); }

const stateRoot = process.env.USAGE_REPORT_STATE || join(homedir(), ".agents", ".claude-code-usage-report", "state");
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
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, sid + ".json"), raw, { encoding: "utf8", mode: 0o600 });
  } catch { /* never break the status line */ }
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
const makeBar = (pct) => {
  const width = 10;
  let filled = Math.floor((pct * width) / 100);
  if (filled < 0) filled = 0;
  if (filled > width) filled = width;
  return "█".repeat(filled) + "░".repeat(width - filled);
};

// --- Fields ---
const model = g("model", "display_name") || "Unknown Model";
const totalCost = g("cost", "total_cost_usd");
const currentDir = g("workspace", "current_dir") || g("cwd");
const worktree = g("worktree", "name");

const cu = g("context_window", "current_usage") || {};
const used = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
  .reduce((s, k) => s + (cu[k] || 0), 0);
const windowSize = g("context_window", "context_window_size");

// --- Usage string + bar ---
let usedDisplay = 0, usageStr = "0%";
if (used && windowSize) {
  usedDisplay = roundHalfUp((used / Number(windowSize)) * 100);
  if (usedDisplay < 0) usedDisplay = 0;
  usageStr = `${usedDisplay}% [${fmtTokens(used)}/${fmtTokens(windowSize)}]`;
}
const barPct = Math.min(usedDisplay, 100);
const usageSeg = `${colorFor(usedDisplay)}${makeBar(barPct)} ${usageStr}${RESET}`;

// --- Cost ---
const costStr = (totalCost !== null && totalCost !== undefined && totalCost !== "")
  ? "$" + Number(totalCost).toFixed(2)
  : "$0.00";

// --- Rate limits ---
const nowSec = () => Math.floor(Date.now() / 1000);
const fmtRelative = (resetTs) => {
  const diff = Math.trunc(resetTs) - nowSec();
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (hours && mins) return `in ${hours}h ${mins}m`;
  if (hours) return `in ${hours}h`;
  return `in ${mins}m`;
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmtClock = (dt) => {
  // 12-hour, no leading zero, uppercase AM/PM (e.g. 3:45PM)
  const h = dt.getHours(), m = dt.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
};
const dayStart = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
const fmtRl = (pct, resetTs, label, showDate) => {
  if (pct === null || pct === undefined || pct === "" || resetTs === null || resetTs === undefined || resetTs === "") return "";
  const color = colorFor(pct);
  const local = new Date(Math.trunc(resetTs) * 1000);
  const resetTime = fmtClock(local);
  const relative = fmtRelative(resetTs);
  const bar = makeBar(pct);
  if (showDate) {
    const diffDays = Math.round((dayStart(local) - dayStart(new Date())) / 86400000);
    const diffSecs = Math.trunc(resetTs) - nowSec();
    let dateStr;
    if (diffDays <= 0) dateStr = " today";
    else if (diffDays === 1) dateStr = " tomorrow";
    else dateStr = ` in ${diffDays} days (${WEEKDAYS[local.getDay()]})`;
    if (diffSecs <= 86400) dateStr = `${dateStr} (${relative})`;
    return `${color}${label} ${bar} ${pct}% resets ${resetTime}${dateStr}${RESET}`;
  }
  return `${color}${label} ${bar} ${pct}% resets ${resetTime} (${relative})${RESET}`;
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
const p1 = [`🤖 ${model}`, `🧠 ${usageSeg}`, `💰 ${costStr}`];
if (rateLimitStr) p1.push(`⏱️ ${rateLimitStr}`);
const line1 = p1.join(" | ");

const p2 = [`📁 ${dirDisplay}`];
if (worktree) p2.push(`🌳 ${worktree}`);
p2.push(`🌿 ${gitStr}`);
if (scopes.length) p2.push(`🧩 ${scopes.join(",")}`);
const line2 = p2.join(" | ");

process.stdout.write(line1 + "\n" + line2);
