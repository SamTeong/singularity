import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _has_newer_input, _load_usage_snapshots } from "./stats.mjs";

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
