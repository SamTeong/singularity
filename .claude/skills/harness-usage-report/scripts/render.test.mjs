// The example report must render from fixtures only: an explicit roadmap bypasses
// the live suggestions inventory, which counts the real ~/.claude/file-history.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "usage-report-test-"));
process.env.USAGE_REPORT_STATE = state;
fs.copyFileSync(path.join(SKILL, "assets/example-forecast.json"), path.join(state, "forecast.json"));
const { _load_stats } = await import("./stats.mjs");
const { render } = await import("./render.mjs");
const c = _load_stats(path.join(SKILL, "assets/example-stats.csv"));
const ROADMAP = [{ status: "idea", area: "demo", text: "synthetic roadmap entry" }];

test("explicit roadmap replaces the live suggestions inventory", () => {
  const html = render(c, ROADMAP);
  assert.match(html, /synthetic roadmap entry/);
  assert.doesNotMatch(html, /file-history snapshots/);
});

test("rendering is byte-stable for the same fixtures", () => {
  assert.equal(render(c, ROADMAP), render(c, ROADMAP));
});

after(() => fs.rmSync(state, { recursive: true, force: true }));
