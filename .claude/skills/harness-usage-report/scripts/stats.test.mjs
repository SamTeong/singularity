import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _has_newer_input, _load_usage_snapshots } from "./stats.mjs";
import { _render_style } from "./render.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
