// Synthetic differential oracle for usage_report_freshness.rs. Extracts the
// checked-in _ensure_fresh declaration and runs it under a fake clock, fake
// glob snapshot, and a no-op rebuild spy. Reads only the supplied case file and
// the checked-in source.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import vm from "node:vm";

const sourcePath = new URL("../../../.claude/skills/harness-usage-report/scripts/stats.mjs", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");

function declaration(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`source anchor missing: ${marker}`);
  const open = source.indexOf("{", start + marker.length);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    // The body has apostrophes in comments; skip line comments so they cannot open a quote.
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed declaration: ${name}`);
}

const REBUILD = "if (need) _rebuild_stats_csv(active, jsonl);";
const body = declaration("_ensure_fresh");
if (body.split(REBUILD).length !== 2) throw new Error("expected exactly one terminal rebuild expression");
// Capture the decision even when need is false, keeping the spy call intact.
const instrumented = body.replace(
  REBUILD,
  "globalThis.__capture = { active, need, jsonl }; if (need) _rebuild_stats_csv(active, jsonl);",
);

const PRELUDE = `
const fs = {
  globSync(pattern) {
    if (pattern.indexOf("projects") >= 0) return globalThis.__globbed.jsonl;
    if (pattern.indexOf("state") >= 0) return globalThis.__globbed.state;
    throw new Error("oracle glob outside fixture: " + pattern);
  },
};
const PROJECTS_GLOB = "/synthetic/projects";
const STATE_GLOB = "/synthetic/state";
const STATS_CSV = "/synthetic/stats.csv";
const Date = { now: () => globalThis.__now_ms };
const path = {
  basename(file, ext) {
    let name = file.slice(file.lastIndexOf("/") + 1);
    if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length);
    return name;
  },
};
function getmtime(file) {
  if (file === STATS_CSV) return globalThis.__csv_mtime;
  if (!globalThis.__mtimes.has(file)) throw new Error("oracle mtime outside fixture: " + file);
  return globalThis.__mtimes.get(file);
}
function isFile(file) {
  return file === STATS_CSV && globalThis.__csv_exists;
}
function codexMtimes() {
  return globalThis.__codex;
}
function _rebuild_stats_csv(active, jsonl) {
  globalThis.__rebuilds.push({ active, jsonl });
}
`;

const casesPath = process.argv[2];
if (!casesPath) throw new Error("usage: usage_report_freshness_oracle.mjs <cases-file>");

function num(token) {
  return Number(token);
}

function parseCases(text) {
  const cases = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "CASE") {
      current = { name: rest[0], nowMs: 0, csvMtime: 0, csvExists: false, transcripts: [], state: [], codex: [] };
      cases.push(current);
      continue;
    }
    if (!current) throw new Error("entry before CASE: " + line);
    if (key === "NOWMS") current.nowMs = num(rest[0]);
    else if (key === "CSV") current.csvMtime = num(rest[0]);
    else if (key === "CSV_EXISTS") current.csvExists = rest[0] === "1";
    else if (key === "T") current.transcripts.push([rest[0] === "~" ? "" : rest[0], num(rest[1])]);
    else if (key === "S") current.state.push([rest[0] === "~" ? "" : rest[0], num(rest[1])]);
    else if (key === "X") current.codex.push(num(rest[0]));
    else throw new Error("unknown case line: " + line);
  }
  return cases;
}

function run(current) {
  const transcriptPaths = current.transcripts.map(([sid], index) => `/synthetic/projects/p${index}/${sid}.jsonl`);
  const statePaths = current.state.map(([sid], index) => `/synthetic/state/p${index}/${sid}.json`);
  const mtimes = new Map();
  current.transcripts.forEach(([, mtime], index) => mtimes.set(transcriptPaths[index], mtime));
  current.state.forEach(([, mtime], index) => mtimes.set(statePaths[index], mtime));
  const globbed = { jsonl: transcriptPaths, state: statePaths };
  const rebuilds = [];
  const context = vm.createContext({
    __now_ms: current.nowMs,
    __mtimes: mtimes,
    __globbed: globbed,
    __csv_exists: current.csvExists,
    __csv_mtime: current.csvMtime,
    __codex: current.codex,
    __rebuilds: rebuilds,
  });
  vm.runInContext(PRELUDE + instrumented + "\n_ensure_fresh();", context);
  const capture = context.__capture;
  if (!capture) throw new Error(`capture missing for ${current.name}`);
  if (capture.need !== (rebuilds.length === 1)) throw new Error(`rebuild spy disagreed for ${current.name}`);
  if (rebuilds.length && rebuilds[0].jsonl !== globbed.jsonl) throw new Error(`rebuild lost the glob snapshot for ${current.name}`);
  const active = capture.active === null ? "<none>" : capture.active;
  return `${current.name}\t${active}\t${capture.need ? "1" : "0"}`;
}

process.stdout.write(parseCases(fs.readFileSync(casesPath, "utf8")).map(run).join("\n") + "\n");
