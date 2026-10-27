// Synthetic differential oracle for usage_report_codex_rows.rs. Slices the
// bundled codex.mjs parse + row-builder functions out of the checked-in source
// and runs them over these fixture files only; no real HOME/CODEX_HOME reads.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import vm from "node:vm";

const sourcePath = new URL("../../../.claude/skills/harness-usage-report/scripts/codex.mjs", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const fixtureDir = new URL("./fixtures/codex-oracle/", import.meta.url);

// Brace-matched slice of one declaration. Strips line/block comments while
// scanning so an apostrophe in prose can't masquerade as a string opener.
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
  let depth = 0;
  let parens = 0;
  let opened = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unclosed comment in ${name}`);
      i = end + 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "{" && parens === 0) {
      opened = true;
      depth++;
    } else if (c === "}" && opened && parens === 0 && --depth === 0) {
      return source.slice(start, i + 1);
    }
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

const fixtures = process.argv[2].split(",").map((name) => ({
  name,
  text: fs.readFileSync(new URL(name, fixtureDir), "utf8"),
}));
const sessionDir = "/synthetic/codex/sessions/2026/01/01";
const texts = new Map(fixtures.map((fixture) => [`${sessionDir}/${fixture.name}`, fixture.text]));
const fakeFs = {
  readFileSync(p) {
    if (!texts.has(p)) throw new Error("oracle read outside fixture: " + p);
    return texts.get(p);
  },
  statSync(p) {
    if (p === "/synthetic/codex/sessions" || p === "/synthetic/codex/archived_sessions") {
      return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
    }
    if (texts.has(p)) return { isDirectory: () => false, isFile: () => true, mtimeMs: 1000 };
    throw new Error("oracle stat outside fixture: " + p);
  },
  globSync(pattern) {
    return pattern.startsWith("/synthetic/codex/sessions/") ? [...texts.keys()] : [];
  },
  mkdirSync() {},
  writeFileSync() {},
  appendFileSync() {},
};
const fakePath = {
  join: (...parts) => parts.join("/"),
  basename: (p, ext) => {
    const base = p.slice(p.lastIndexOf("/") + 1);
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  dirname: (p) => p.slice(0, p.lastIndexOf("/")),
};
const prelude = `
const fs = fakeFs;
const path = fakePath;
const console = fakeConsole;
function _default_codex_home() { throw new Error("oracle must inject codexHome"); }
`;
const declarations = [
  "isDir", "isFile", "_num", "_dig", "_rollout_files", "_thread_id_from_filename",
  "_iter_jsonl_or_throw", "_new_thread_res", "_parse_thread", "_load_cache", "_save_cache",
  "_new_session_acc", "_merge_thread_into_session", "_last_by_epoch", "_maybe_warn_unknown_model",
  "_append_usage_jsonl", "codexIngest",
].filter((name, index, all) => all.indexOf(name) === index);
const constants = ["CACHE_VERSION", "AUTO_REVIEW_MODEL", "UNKNOWN_MODEL_RE", "MODEL_DISPLAY_NAMES"];
const context = vm.createContext({ fakeFs, fakePath, fakeConsole: console, JSON, Object, Array, String, Number, Math, Set, RegExp, Map, Date, Infinity, NaN });
const script = prelude
  + constants.map(constant).join("\n")
  + "\n" + declarations.map(declaration).join("\n")
  + `
globalThis.result = codexIngest({
  codexHome: "/synthetic/codex",
  stateDir: "/synthetic/state",
  localFmt: (epoch) => "epoch:" + epoch.toFixed(3),
  epochFromIso: (value) => {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time / 1000;
  },
  msgCostTiered: (model, input, output, cacheRead, cacheCreation) =>
    input * 0.5 + output * 2 + cacheRead * 0.25 + cacheCreation * 0.5,
  priceKey: (model) => model,
  defaultKey: "default",
}).rows;
`;
vm.runInContext(script, context);
process.stdout.write(JSON.stringify(context.result) + "\n");
