// Synthetic differential oracle for usage_report_forecast_build.rs. Slices the
// checked-in stats.mjs forecast-assembly declarations and runs `_build_forecast`
// under a fake clock, stub snapshot loader, and a no-op forecast writer. Reads
// only the fixture on stdin and the checked-in source; no HOME or state access.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import vm from "node:vm";
import * as FC from "../../../.claude/skills/harness-usage-report/scripts/forecast.mjs";

const sourcePath = new URL(
  "../../../.claude/skills/harness-usage-report/scripts/stats.mjs",
  import.meta.url,
);
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
    // Skip line comments so an apostrophe in prose cannot open a quote.
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

function constLine(prefix) {
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`source anchor missing: ${prefix}`);
  return source.slice(start, source.indexOf("\n", start));
}

// Only the forecast-assembly half of stats.mjs: the filesystem loader, the
// clock and the forecast writer are injected by the prelude below.
const slices = [
  declaration("_parse_reset_at"),
  declaration("_normalize_reset_at"),
  declaration("parseDateTime"),
  declaration("_fetched_epoch"),
  declaration("_fnum"),
  declaration("_gauge_windows"),
  constLine("const _r2 = "),
  declaration("_wb_pool"),
  declaration("_window_balance_oauth"),
  declaration("_window_balance_statusline"),
  declaration("_window_balance"),
  declaration("_fit_gauge"),
  declaration("_fit_gauge_statusline"),
  declaration("_stride"),
  declaration("_ollama_window_balance"),
  declaration("_ollama_token_yield"),
  declaration("_build_ollama_forecast"),
  declaration("_codex_window_balance"),
  declaration("_build_codex_forecast"),
  declaration("_build_forecast"),
].join("\n");

const PRELUDE = `
const USAGE_SNAPSHOTS_JSONL = "/synthetic/usage-snapshots.jsonl";
const OLLAMA_USAGE_JSONL = "/synthetic/ollama-usage.jsonl";
const CODEX_USAGE_JSONL = "/synthetic/codex-usage.jsonl";
const FORECAST_JSON = "/synthetic/forecast.json";
const OLLAMA_SERIES_CAP = 400;
const GAUGE_DUR_HOURS = { five_hour: 5, seven_day: 7 * 24, session: 5, weekly: 7 * 24 };
const WB_MIN_COVERAGE = 0.5;
const WB_MIN_D7 = 20;
const WB_GAP_SEC = 5 * 3600;
const fs = { writeFileSync() {} };
Date.now = () => globalThis.__now_ms;
function now_local() { return globalThis.__fit_at; }
// Stands in for the state-dir reader: same fetched-epoch sort, fixture data.
function _load_usage_snapshots(p = USAGE_SNAPSHOTS_JSONL) {
  const list = p === OLLAMA_USAGE_JSONL ? globalThis.__ollama
    : p === CODEX_USAGE_JSONL ? globalThis.__codex : globalThis.__claude;
  return list.slice().sort((a, b) => (_fetched_epoch(a) ?? Infinity) - (_fetched_epoch(b) ?? Infinity));
}
`;

if (process.env.FORECAST_BUILD_ORACLE_BRIDGE !== "1") {
  throw new Error("run through usage_report_forecast_build_cross_language.rs");
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const fixture = JSON.parse(raw);

const context = vm.createContext({
  FC,
  __now_ms: fixture.nowSec * 1000,
  __fit_at: fixture.fitAt,
  __claude: [],
  __ollama: [],
  __codex: [],
  __sessions: null,
});
vm.runInContext(PRELUDE + slices, context);

const documents = fixture.cases.map((testCase) => {
  context.__claude = testCase.claudeSnaps;
  context.__ollama = testCase.ollamaSnaps;
  context.__codex = testCase.codexSnaps;
  context.__sessions = testCase.sessions;
  return vm.runInContext("_build_forecast(globalThis.__sessions)", context);
});

process.stdout.write(JSON.stringify(documents));
