import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repo = "C:/git/singularity/.worktrees/feat-rust-read-services";
const cargoHome = process.env.HOME;
const cargoUserProfile = process.env.USERPROFILE;
const cargoCandidates = [
  process.env.CARGO,
  ...[cargoHome, cargoUserProfile].filter(Boolean).map((home) => path.join(home, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo")),
  "C:/Users/sate/.cargo/bin/cargo.exe",
];
const cargoCommand = cargoCandidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? "cargo";
const scratchParent = process.env.USAGE_REPORT_RENDER_SCRATCH;
assert.ok(scratchParent, "USAGE_REPORT_RENDER_SCRATCH must point to an empty task scratch directory");
fs.mkdirSync(scratchParent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchParent, "native-render-oracle-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
const sourceDir = path.join(repo, ".claude/skills/harness-usage-report/scripts");
const copiedSkill = path.join(scratch, "synthetic-home/.agents/skills/harness-usage-report/scripts");
const stateDir = path.join(scratch, "synthetic-state");
fs.mkdirSync(path.join(copiedSkill, "sources"), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const names = ["base.html", "hero.html", "app.js", "style.css", "skin-phosphor.css", "fonts.css", "motion.html"];
for (const name of names) fs.copyFileSync(path.join(sourceDir, "sources", name), path.join(copiedSkill, "sources", name));
const rendererSource = fs.readFileSync(path.join(sourceDir, "render.mjs"), "utf8");
const fetchStart = rendererSource.indexOf("function _fetch_roadmap() {");
const fetchEnd = rendererSource.indexOf("\n}\n\nfunction _render_suggestions", fetchStart);
assert.notEqual(fetchStart, -1);
assert.notEqual(fetchEnd, -1);
assert.equal(rendererSource.indexOf("function _fetch_roadmap() {", fetchStart + 1), -1, "expected exactly one roadmap acquisition helper");
const acquire = rendererSource.slice(fetchStart, fetchEnd + 2);
assert.match(acquire, /execFileSync\(process\.execPath, \[IMPROVE_MJS, "roadmap", "--json"\]/);
const stubbedRenderer = rendererSource.slice(0, fetchStart) +
  "function _fetch_roadmap() { return globalThis.__syntheticRoadmap; }" +
  rendererSource.slice(fetchEnd + 2);
fs.writeFileSync(path.join(copiedSkill, "render.mjs"), stubbedRenderer, "utf8");

const cases = [
  { name: "empty-fallback", payload: { sessions: [], forecast: null, roadmap: null, generated_local: "2026-10-25 01:02:03" } },
  { name: "populated-projection", payload: {
    sessions: [{ ts: null, sid: "lone-" + String.fromCharCode(0xd83d), cost: -0, model: "model-é🧪", in: 1e21, out: 1e-7, cr: null, cc: 4, tok: 5, dur: 6, api: 7, la: 8, lr: 9, rl5: 10, rl7: 11, turns: 12, tools: { "<tool>": 1 }, hour: 13, dow: 14,
      facets: { tools: { "edit<&": 2 }, agents: { "agent-é": 1 }, skills: { "skill🧪": 1 }, compactions: "2.9tail", tool_errors: "Infinity", cwd: " /repo/é " } }],
    forecast: { gauges: [{ label: "</script><x>", n: 1e21 }, "é🧪"] },
    roadmap: [{ area: "<area>&", status: "available", text: "quote ' and \"" }, { area: "idea", status: "idea", text: "text" }, { area: "unknown", status: "future", text: "unknown status" }, { area: "done", status: "done", text: "done" }],
    generated_local: "2026-10-25 01:02:03",
  } },
  { name: "forecast-array-empty-roadmap", payload: { sessions: [], forecast: ["<", 1e-7], roadmap: [], generated_local: "2026-01-02 03:04:05" } },
  { name: "array-coercion-and-surrogate-keys", payload: { sessions: [Object.assign({ facets: { tools: { [String.fromCharCode(0xd83d)]: 1, "<key>": 2 }, compactions: ["\uFEFF2tail"], tool_errors: ["\u00853"], cwd: "\uFEFF /repo/\uD83D\uFEFF" } }, { [String.fromCharCode(0xd83d)]: "ignored" })], forecast: { escaped: "quote \" slash \\\\ line\n-é🧪", values: [-0, 1e21, 1e-7, 1e-8, 1e20] }, roadmap: null, generated_local: "2026-02-03 04:05:06" } },
  { name: "malformed-roadmap-entry", payload: { sessions: [], forecast: {}, roadmap: [null], generated_local: "2026-01-02 03:04:05" } },
];

const nativeDate = Date;
globalThis.Date = class FixedDate extends nativeDate {
  constructor(...args) { super(...(args.length ? args : [globalThis.__oracleTimestamp])); }
  getFullYear() { return this.getUTCFullYear(); }
  getMonth() { return this.getUTCMonth(); }
  getDate() { return this.getUTCDate(); }
  getHours() { return this.getUTCHours(); }
  getMinutes() { return this.getUTCMinutes(); }
  getSeconds() { return this.getUTCSeconds(); }
  static now() { return nativeDate.parse("2026-10-25T01:02:03Z"); }
};
process.env.HOME = path.join(scratch, "synthetic-home");
process.env.USERPROFILE = process.env.HOME;
process.env.USAGE_REPORT_STATE = stateDir;
const { render } = await import(pathToFileURL(path.join(copiedSkill, "render.mjs")));

for (const item of cases) {
  globalThis.__oracleTimestamp = `${item.payload.generated_local.replace(" ", "T")}Z`;
  const inputPath = path.join(scratch, `${item.name}.json`);
  const payloadText = JSON.stringify(item.payload).replaceAll("é", "\\u00e9").replaceAll("🧪", "\\ud83e\\uddea");
  fs.writeFileSync(inputPath, payloadText, "utf8");
  if (item.payload.forecast == null) {
    fs.rmSync(path.join(stateDir, "forecast.json"), { force: true });
  } else {
    fs.writeFileSync(path.join(stateDir, "forecast.json"), JSON.stringify(item.payload.forecast).replaceAll("é", "\\u00e9").replaceAll("🧪", "\\ud83e\\uddea"), "utf8");
  }
  globalThis.__syntheticRoadmap = item.payload.roadmap;
  let oracleHtml;
  let oracleError;
  try { oracleHtml = render(item.payload); } catch (error) { oracleError = error; }

  let nativeHtml;
  let nativeError;
  try {
    const cargoEnv = { ...process.env, HOME: cargoHome, USERPROFILE: cargoUserProfile };
    if (cargoHome === undefined) delete cargoEnv.HOME;
    if (cargoUserProfile === undefined) delete cargoEnv.USERPROFILE;
    delete cargoEnv.USAGE_REPORT_STATE;
    nativeHtml = execFileSync(cargoCommand, ["run", "--offline", "--quiet", "--manifest-path", path.join(repo, "rust/backend/Cargo.toml"), "--example", "usage_report_render_fixture", "--", inputPath], { cwd: repo, env: cargoEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { nativeError = error; }
  assert.equal(Boolean(nativeError), Boolean(oracleError), `${item.name}: renderer error parity; native stderr=${String(nativeError?.stderr ?? "").slice(0, 1400)} stdout=${String(nativeError?.stdout ?? "").slice(0, 600)}; oracle error=${String(oracleError?.stack ?? oracleError ?? "none").slice(0, 900)}`);
  if (!oracleError) {
    if (nativeHtml !== oracleHtml) {
      let at = 0; while (at < nativeHtml.length && at < oracleHtml.length && nativeHtml[at] === oracleHtml[at]) at++;
      throw new Error(`${item.name}: HTML differs at UTF-16 offset ${at} (native ${nativeHtml.length}, oracle ${oracleHtml.length})`);
    }
    process.stdout.write(`${item.name}: exact HTML match (${nativeHtml.length} code units)\n`);
  } else {
    assert.match(String(nativeError.stderr), /render error:/, `${item.name}: native malformed-input error`);
    process.stdout.write(`${item.name}: both renderers reject malformed roadmap input\n`);
  }
}

// Assert the copied oracle tree contains only the renderer and its seven assets.
const copiedFiles = [];
function listFiles(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) listFiles(file); else copiedFiles.push(path.relative(copiedSkill, file).replaceAll("\\", "/")); } }
listFiles(copiedSkill);
assert.deepEqual(copiedFiles.sort(), ["render.mjs", ...names.map(n => `sources/${n}`)].sort());
