// Regenerate assets/example-report.html from the committed anonymized fixture
// (assets/example-stats.csv) using the current renderer. No local session data
// is read. Run after any design/render change so the example stays current:
//   node scripts/render-example.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _load_stats } from "./stats.mjs";
import { render } from "./render.mjs";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSV = path.join(SKILL, "assets/example-stats.csv");
const OUT = path.join(SKILL, "assets/example-report.html");

const c = _load_stats(CSV);
fs.writeFileSync(OUT, render(c), "utf-8");
console.log("wrote", OUT, "from", path.basename(CSV), `(${c.totals.sessions} sessions)`);
