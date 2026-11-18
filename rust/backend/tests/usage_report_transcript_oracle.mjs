// Synthetic differential oracle for usage_report_transcript.rs. Reads only
// these checked-in synthetic fixture strings and source declarations.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import vm from "node:vm";

const sourcePath = new URL("../../../.claude/skills/harness-usage-report/scripts/stats.mjs", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");

function declaration(name) {
  const marker = `function ${name}(`;
  const generatorMarker = `function* ${name}(`;
  let start = source.indexOf(marker);
  let prefix = marker;
  const generatorStart = source.indexOf(generatorMarker);
  if (generatorStart >= 0 && (start < 0 || generatorStart < start)) {
    start = generatorStart;
    prefix = generatorMarker;
  }
  if (start < 0) throw new Error(`source anchor missing: ${marker}`);
  const open = source.indexOf("{", start + prefix.length);
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
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed declaration: ${name}`);
}

function constant(name) {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`source anchor missing: const ${name}`);
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error(`source terminator missing: ${name}`);
  return source.slice(start, end + 1).replace("const ", "globalThis.");
}

const main = fs.readFileSync(new URL("./fixtures/usage_report_transcript_main.jsonl", import.meta.url), "utf8");
const nested = fs.readFileSync(new URL("./fixtures/usage_report_transcript_nested.jsonl", import.meta.url), "utf8");
const nullCase = process.argv.includes("--null-case");
const typeErrorCase = process.argv.includes("--type-error-case");
const nullText = fs.readFileSync(new URL("./fixtures/usage_report_transcript_null.jsonl", import.meta.url), "utf8");
const typeErrorText = fs.readFileSync(new URL("./fixtures/usage_report_transcript_type_error.jsonl", import.meta.url), "utf8");
const caseName = process.argv.find((value) => value.endsWith("-case"))?.slice(2, -5) ?? "normal";
const focusedCases = new Set(["timestamp-error", "inum-object-error", "inum-array-error", "model-truthiness", "surrogate-skill", "overlapping-skill", "feff-inum"]);
const focusedText = focusedCases.has(caseName)
  ? fs.readFileSync(new URL(`./fixtures/usage_report_transcript_${caseName}.jsonl`, import.meta.url), "utf8")
  : null;
const files = new Map([
  ["/synthetic/main.jsonl", nullCase ? nullText : typeErrorCase ? typeErrorText : focusedText ?? main],
  ["/synthetic/sub/child.jsonl", focusedText ? "" : nested],
]);
const fakeFs = {
  readFileSync(path) { if (!files.has(path)) throw new Error("oracle read outside fixture: " + path); return files.get(path); },
  statSync(path) { if (!files.has(path)) throw new Error("oracle stat outside fixture: " + path); return { isFile: () => true }; },
  globSync(pattern) { return pattern.includes("/**/*.jsonl") ? ["/synthetic/sub/child.jsonl"] : []; },
};
const prelude = `
const fs = fakeFs;
const PROJECTS_GLOB = "/synthetic/projects";
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
const FIXTURE_EPOCHS = new Map([
  ["2024-01-01T00:00:01+00:00", 1704067201000],
  ["2024-01-01T00:00:02+00:00", 1704067202000],
  ["2024-01-01T00:00:03+00:00", 1704067203000],
  ["2024-01-01T00:00:04+00:00", 1704067204000],
  ["2024-01-01T00:00:05+00:00", 1704067205000],
  ["2024-01-01T00:00:06+00:00", 1704067206000],
  ["1970-01-01T00:00:00+00:00", 0],
]);
class FixtureDate {
  constructor(value) { this.value = value; }
  getTime() { return FIXTURE_EPOCHS.get(this.value) ?? NaN; }
}
globalThis.Date = FixtureDate;
`;
const declarations = ["iter_jsonl", "epoch_from_iso", "_merge_facets", "_new_facets", "_skill_slash_invocations", "parse_transcript", "session_totals", "_msg_tokens", "_inum"];
const context = vm.createContext({ fakeFs, Date, Number, Math, JSON, Object, Array, String, Set, RegExp, Map, NaN });
let result;
try {
  const expression = caseName === "parsefloat-grammar"
    ? `globalThis.result = ["Infinity", "+Infinity", "-Infinity", "Infinityx", "+Infinityx", "-Infinityx", "infinity", "inf", "12.9x", "1e309", "-1e309", "1e309x"].map((value) => String(_inum(value)));`
    : `globalThis.result = session_totals("fixture", "/synthetic/main.jsonl");`;
  vm.runInContext(prelude + constant("BUILTIN_CLI_COMMANDS") + declarations.map(declaration).join("\n") + `\n${expression}`, context);
  result = context.result;
} catch (error) {
  if (!nullCase && !typeErrorCase && !caseName.endsWith("-error")) throw error;
  result = { oracle_error: error.name };
}
process.stdout.write(JSON.stringify(result) + "\n");
