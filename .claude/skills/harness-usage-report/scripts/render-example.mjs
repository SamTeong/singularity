// Regenerate assets/example-report.html from the committed anonymized fixtures
// (assets/example-stats.csv + assets/example-forecast.json) using the current
// renderer. No local session data, live quota/forecast state or host inventory is
// read: the roadmap below is fixed rather than collected. Run after
// any design/render change so the example stays current:
//   node scripts/render-example.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSV = path.join(SKILL, "assets/example-stats.csv");
const FORECAST = path.join(SKILL, "assets/example-forecast.json");
const OUT = path.join(SKILL, "assets/example-report.html");
// The hero banner prints the render time; pin it so the example is byte-stable.
const STAMP = "2026-08-15 12:00:00";
// Fixed roadmap rows: the live inventory counts this host's ~/.claude state.
const ROADMAP = [
  { status: "available", area: "capture", text: "Capture line counts and API time from the statusline." },
  { status: "partial", area: "schema", text: "Backfill older rows where the schema gained columns." },
  { status: "idea", area: "visualization", text: "Compare harness efficiency side by side." },
];

// render.mjs resolves its state root at module-evaluation time, so point
// USAGE_REPORT_STATE at a temp dir holding only the synthetic fixture before
// importing it (dynamic import, not a top-level one).
const state = fs.mkdtempSync(path.join(os.tmpdir(), "usage-report-example-"));
process.env.USAGE_REPORT_STATE = state;
fs.copyFileSync(FORECAST, path.join(state, "forecast.json"));
try {
  const { _load_stats } = await import("./stats.mjs");
  const { render } = await import("./render.mjs");
  const c = _load_stats(CSV);
  const html = render(c, ROADMAP).replace(
    /<span class='mut'>generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/span>/,
    `<span class='mut'>generated ${STAMP}</span>`,
  );
  if (!html.includes(`generated ${STAMP}`)) throw new Error("generated banner not pinned");
  fs.writeFileSync(OUT, html, "utf-8");
  console.log("wrote", OUT, "from", path.basename(CSV), `(${c.totals.sessions} sessions)`);
} finally {
  fs.rmSync(state, { recursive: true, force: true });
}
