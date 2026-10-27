import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Called by tests/usage_report_render_cross_language.rs with a scratch directory that
// already holds <case>.html (native output) or <case>.error (native rejection).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, "../../..");
const fixtureDir = path.join(scriptDir, "fixtures/render-oracle");
const scratch = process.argv[2];
assert.ok(scratch, "usage: node usage_report_render_oracle.mjs <scratch-dir>");
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

const fixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith(".json")).sort();
assert.ok(fixtures.length >= 3, "expected at least three render fixtures");
for (const file of fixtures) {
  const name = file.slice(0, -".json".length);
  const payload = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8"));
  globalThis.__oracleTimestamp = `${payload.generated_local.replace(" ", "T")}Z`;
  const forecastPath = path.join(stateDir, "forecast.json");
  if (payload.forecast == null) {
    fs.rmSync(forecastPath, { force: true });
  } else {
    fs.writeFileSync(forecastPath, JSON.stringify(payload.forecast), "utf8");
  }
  globalThis.__syntheticRoadmap = payload.roadmap;
  let oracleHtml;
  let oracleError;
  try { oracleHtml = render(payload); } catch (error) { oracleError = error; }

  const nativeHtmlPath = path.join(scratch, `${name}.html`);
  const nativeErrorPath = path.join(scratch, `${name}.error`);
  if (fs.existsSync(nativeHtmlPath)) {
    assert.equal(oracleError, undefined, `${name}: oracle rejected a payload the native renderer accepted: ${oracleError?.stack ?? ""}`);
    const nativeHtml = fs.readFileSync(nativeHtmlPath, "utf8");
    if (nativeHtml !== oracleHtml) {
      let at = 0; while (at < nativeHtml.length && at < oracleHtml.length && nativeHtml[at] === oracleHtml[at]) at++;
      throw new Error(`${name}: HTML differs at UTF-16 offset ${at} (native ${nativeHtml.length}, oracle ${oracleHtml.length})`);
    }
    process.stdout.write(`${name}: exact HTML match (${nativeHtml.length} code units)\n`);
  } else {
    assert.ok(fs.existsSync(nativeErrorPath), `${name}: native renderer produced neither HTML nor an error`);
    assert.ok(oracleError, `${name}: oracle rendered a payload the native renderer rejected`);
    process.stdout.write(`${name}: both renderers reject the payload\n`);
  }
}

// Assert the copied oracle tree contains only the renderer and its seven assets.
const copiedFiles = [];
function listFiles(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) listFiles(file); else copiedFiles.push(path.relative(copiedSkill, file).replaceAll("\\", "/")); } }
listFiles(copiedSkill);
assert.deepEqual(copiedFiles.sort(), ["render.mjs", ...names.map(n => `sources/${n}`)].sort());
