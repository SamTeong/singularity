import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(SCRIPT_DIR, "sources", "app.js"), "utf8");

function initializedRange(sessions, forecast, preset = "all") {
  let onReady;
  let range;
  const context = {
    SESSIONS: sessions,
    FORECAST: forecast,
    document: {
      addEventListener(name, fn) { if (name === "DOMContentLoaded") onReady = fn; },
      documentElement: { dataset: { theme: "light" } },
    },
    localStorage: {
      getItem() { return JSON.stringify({ from: "2026-01-01", to: "2026-01-02", preset }); },
      setItem() {},
    },
  };
  vm.runInNewContext(app, context, { filename: "app.js" });
  context.initControls = (value) => { range = value; };
  context.render = () => {};
  context.initRoadmapFilter = () => {};
  context.__lbl = () => {};
  onReady();
  return { range, presetRange: context.presetRange };
}

const quotaDates = ["2026-10-19", "2026-10-22", "2026-10-25"];
const series = quotaDates.map((day) => ({ ts: `${day}T12:00:00.000Z`, session: 12, weekly: 20 }));
const forecast = {
  codex: { series },
  ollama: {
    series,
    tokenYield: { series: { model: Object.fromEntries(quotaDates.map((day) => [day, { t: 1000, d: 1 }])) } },
  },
  windowBalance: { series: [{ resetAt: "2030-01-01T00:00:00.000Z" }] },
};
const sessions = [{ ts: "2026-06-30T12:00:00.000Z" }];

for (const preset of ["all", "7d", "30d"]) {
  const { range } = initializedRange(sessions, forecast, preset);
  assert.equal(range.to, "2026-10-25", `${preset} ends at the newest independent quota observation`);
  assert.equal(range.from, preset === "all" ? "2026-06-30" : preset === "7d" ? "2026-10-19" : "2026-09-26");
  assert.ok(quotaDates.some((day) => day >= range.from && day <= range.to), `${preset} includes quota samples`);
}

const quotaOnly = initializedRange([], forecast, "all").range;
assert.deepEqual({ from: quotaOnly.from, to: quotaOnly.to }, { from: "2026-10-19", to: "2026-10-25" });

const sessionsOnly = initializedRange(sessions, {}, "30d").range;
assert.deepEqual({ from: sessionsOnly.from, to: sessionsOnly.to }, { from: "2026-06-01", to: "2026-06-30" });

console.log("date-range presets: 3 ranges, quota-only, sessions-only passed");
