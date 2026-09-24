import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _render_style } from "./render.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// stats.mjs reads USAGE_REPORT_STATE (and therefore pricing.json) once at
// import — point it at a fixture dir *before* importing, so these tests never
// touch the user's real state.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-report-state-"));
process.env.USAGE_REPORT_STATE = fixtureDir;
fs.writeFileSync(path.join(fixtureDir, "pricing.json"), JSON.stringify({
  base: {
    "gpt-6-sol": [2.0, 10.0, 0.20, 2.50],
    "gpt-6-luna": [0.10, 0.50, 0.01, 0.125],
    "gpt-5.6-sol": [4.0, 20.0, 0.40, 5.0],
    opus: [5.0, 25.0, 0.5, 6.25],
    sonnet: [3.0, 15.0, 0.3, 3.75],
  },
  above_200k: {
    "gpt-6-sol": [4.0, 15.0, 0.40, 5.0],
    "gpt-6-luna": [0.20, 0.75, 0.02, 0.25],
    "gpt-5.6-sol": [8.0, 30.0, 0.80, 10.0],
  },
  long_context_threshold: 200000,
  default_key: "opus",
}, null, 2));

const { _has_newer_input, _load_usage_snapshots, _msg_cost_tiered, _price_key } = await import("./stats.mjs");

assert.equal(_msg_cost_tiered("gpt-6-sol", 272000, 0, 0, 0), 0.544);
assert.equal(_msg_cost_tiered("gpt-6-sol", 272001, 0, 0, 0), 1.088004);
assert.equal(_msg_cost_tiered("gpt-6-luna", 272000, 0, 0, 0), 0.0272);
assert.equal(_msg_cost_tiered("gpt-6-luna", 272001, 0, 0, 0), 0.0544002);
assert.equal(_msg_cost_tiered("gpt-5.6-sol", 200001, 0, 0, 0), 1.600008);
// default_key fallback: an unrecognized model resolves to pricing.json's default_key.
assert.equal(_price_key("some-unrecognized-model"), "opus");
console.log("ok");

// No pricing.json at all => every model unpriced (null key, null cost), never a throw.
{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-report-empty-"));
  process.env.USAGE_REPORT_STATE = emptyDir;
  const mod = await import(`./stats.mjs?case=no-pricing-file`);
  assert.equal(mod._price_key("claude-opus-5-5"), null, "no pricing.json + no default_key => null");
  assert.equal(mod._msg_cost_tiered("claude-opus-5-5", 100, 100, 0, 0), null, "no pricing.json => est cost null, not a throw");
  fs.rmSync(emptyDir, { recursive: true, force: true });
  console.log("ok");
}

// default_key fallback when it names a real base entry.
{
  const dkDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-report-defaultkey-"));
  fs.writeFileSync(path.join(dkDir, "pricing.json"), JSON.stringify({
    base: { sonnet: [3.0, 15.0, 0.3, 3.75] },
    default_key: "sonnet",
  }));
  process.env.USAGE_REPORT_STATE = dkDir;
  const mod = await import(`./stats.mjs?case=default-key-fallback`);
  assert.equal(mod._price_key("totally-unrecognized-model-id"), "sonnet");
  fs.rmSync(dkDir, { recursive: true, force: true });
  console.log("ok");
}

// base key order IS match order: a less-specific key listed first shadows a
// more-specific one listed after it (order dependency is load-bearing, not a bug).
{
  const orderDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-report-order-"));
  fs.writeFileSync(path.join(orderDir, "pricing.json"), JSON.stringify({
    base: { opus: [1, 1, 1, 1], "opus-5-5": [2, 2, 2, 2] },
  }));
  process.env.USAGE_REPORT_STATE = orderDir;
  const mod = await import(`./stats.mjs?case=order`);
  assert.equal(mod._price_key("claude-opus-5-5"), "opus", "bare 'opus' listed first wins the ordered scan");
  fs.rmSync(orderDir, { recursive: true, force: true });
  console.log("ok");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-report-"));
try {
  const forecast = path.join(dir, "forecast.json");
  const codexUsage = path.join(dir, "codex-usage.jsonl");
  fs.writeFileSync(forecast, "{}");
  fs.writeFileSync(codexUsage, "{}");

  const earlier = new Date(Date.now() - 2_000);
  fs.utimesSync(forecast, earlier, earlier);
  assert.equal(_has_newer_input(forecast, [codexUsage]), true);

  fs.utimesSync(codexUsage, earlier, earlier);
  assert.equal(_has_newer_input(forecast, [codexUsage]), false);

  fs.writeFileSync(codexUsage, [
    '{"fetched_at":"2026-08-01 12:00:00"}',
    '{"fetched_at":"2026-07-25 12:00:00"}',
  ].join("\n"));
  assert.deepEqual(
    _load_usage_snapshots(codexUsage).map((snapshot) => snapshot.fetched_at),
    ["2026-07-25 12:00:00", "2026-08-01 12:00:00"],
  );
  console.log("ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

// app.js is the shared chart layer for every skin — it must resolve colour
// purely through CSS custom properties (var(--...)) so a skin swap never
// requires touching the data layer. A hex-colour-shaped token (#rgb or
// #rrggbb at a token boundary) would be a literal that no skin can override.
{
  const appJsPath = path.join(SCRIPT_DIR, "sources", "app.js");
  const appJs = fs.readFileSync(appJsPath, "utf-8");
  const hexColorRe = /(?<![0-9a-zA-Z])#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;
  const hits = appJs.match(hexColorRe) || [];
  assert.deepEqual(hits, [], `app.js contains hex colour literal(s): ${hits.join(", ")}`);
  console.log("ok");
}

// render_style() must load the Phosphor skin file, and it must come last in
// the concatenation order (skin-phosphor.css after style.css) so it wins the
// `:root[data-skin="phosphor"]` vs `:root[data-theme="dark"]` specificity tie.
// The series ramp must be reassigned INSIDE the Phosphor token block, not merely
// present somewhere in the output: `--pal-*` is declared in style.css's base
// :root, so a looser check passes even when the skin forgets the ramp entirely —
// and a forgotten ramp leaves --pal-1 resolving to Phosphor's --ac and puts
// orange into the data layer, breaking the chrome-only rule.
{
  const style = _render_style();
  const SKIN = ':root[data-skin="phosphor"]';
  assert.ok(style.includes(SKIN), "render_style() output is missing the Phosphor skin block");

  const blockStart = style.indexOf(SKIN);
  const block = style.slice(blockStart, style.indexOf("}", blockStart));
  for (let i = 1; i <= 8; i += 1) {
    assert.ok(
      block.includes(`--pal-${i}:`),
      `the Phosphor token block does not reassign --pal-${i} — the ZAPAC series ramp would leak through`,
    );
  }
  for (const tok of ["--tok-in", "--tok-out", "--tok-cr", "--tok-cc", "--paper-fg"]) {
    assert.ok(block.includes(`${tok}:`), `the Phosphor token block does not reassign ${tok}`);
  }
  console.log("ok");
}
