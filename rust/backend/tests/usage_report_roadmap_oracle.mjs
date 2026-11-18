// Synthetic source-bound oracle for usage_report_roadmap.rs. Extracts the bundled
// build_roadmap from improve.mjs and runs it in a VM with injected inventory/stats
// stubs: no filesystem, home, credential, CLI, or report-generator access.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../../../.claude/skills/harness-usage-report-suggestions/scripts/improve.mjs", import.meta.url),
  "utf8",
);

const start = source.indexOf("async function build_roadmap(");
const end = source.indexOf("async function cmd_roadmap(");
if (start < 0 || end < 0) throw new Error("source anchors missing: build_roadmap / cmd_roadmap");
const declaration = source.slice(start, source.lastIndexOf("}", end) + 1);

const cases = JSON.parse(fs.readFileSync(0, "utf8"));
const num = (value) => (typeof value === "string" ? Number(value) : value);
const prelude = `
const STATS_MJS = "/synthetic/stats.mjs";
function isFile() { return true; }
function _data_inventory() { return fixture.inventory; }
async function _load_stats_module() {
  return {
    STATS_CSV: "/synthetic/stats.csv",
    _load_stats: () => ({ sessions: fixture.sessions, totals: fixture.totals, usage: { tools: {}, agents: {}, skills: {} } }),
  };
}
`;

const results = [];
for (const entry of cases) {
  const fixture = {
    inventory: entry.inventory,
    sessions: entry.stats.rows.map((row) => ({ la: num(row.la), lr: num(row.lr) })),
    totals: { sessions: num(entry.stats.totals) },
  };
  const context = vm.createContext({ fixture });
  vm.runInContext(prelude + declaration + "\nglobalThis.promise = build_roadmap();", context, { timeout: 5000 });
  results.push((await context.promise).suggestions);
}
process.stdout.write(JSON.stringify(results) + "\n");
