import assert from "node:assert/strict";
import process from "node:process";
import { createInterface } from "node:readline";
import vm from "node:vm";

assert.equal(process.env.USAGE_SNAPSHOT_ORACLE_BRIDGE, "1");

const input = await new Promise((resolve, reject) => {
  let text = "";
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => { text += line; });
  reader.on("close", () => {
    try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
  });
});

function extractFunction(source, name) {
  const match = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `pinned main source is missing ${name}`);
  const start = match.index;
  const open = source.indexOf("{", match.index + match[0].length);
  assert.notEqual(open, -1, `pinned main source has no body for ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/^export\s+/, "");
  }
  assert.fail(`pinned main source has an unterminated body for ${name}`);
}

const names = [
  "parseDateTime",
  "_parse_reset_at",
  "_normalize_reset_at",
  "_fetched_epoch",
  "_map_usage",
  "_gauge_windows",
];
const program = names.map((name) => extractFunction(input.source, name)).join("\n");
const context = vm.createContext({ Date, Map, Math, Number, RegExp });
vm.runInContext(`${program}\nthis.oracle = { _map_usage, _gauge_windows };`, context, {
  timeout: 1_000,
});

const { _map_usage, _gauge_windows } = context.oracle;
const windows = (rows) => Object.fromEntries(
  ["five_hour", "seven_day"].map((gauge) => [gauge, _gauge_windows(rows, gauge)]),
);
process.stdout.write(JSON.stringify({
  mapped: _map_usage(input.regularRaw),
  regularWindows: windows(input.regularRows),
  costWindows: windows(input.costRows),
  rawOnlyWindows: windows(input.rawOnlyRows),
}));
