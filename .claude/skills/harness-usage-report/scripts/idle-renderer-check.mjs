import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

import { render } from "./render.mjs";
import { _load_stats } from "./stats.mjs";

const SAMPLE_MS = 60_000;
const SETTLE_MS = 2_500;
const SETTLE_TIMEOUT_MS = 15_000;
const MAX_TASK_DURATION_MS = 1_000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(path.dirname(SCRIPT_DIR), "assets", "example-stats.csv");

async function launchBrowser() {
  const attempts = [
    ["bundled Chromium", {}],
    ["Microsoft Edge", { channel: "msedge" }],
    ["Google Chrome", { channel: "chrome" }],
  ];
  const failures = [];
  for (const [name, options] of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true });
    } catch (error) {
      failures.push(`${name}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`No Chromium-family browser could launch:\n${failures.join("\n")}`);
}

async function waitForAnimationFramesToSettle(page) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous = await page.evaluate(() => window.__idleRafProbe.snapshot());
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const current = await page.evaluate(() => window.__idleRafProbe.snapshot());
    if (current.requested !== previous.requested || current.fired !== previous.fired) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= SETTLE_MS) {
      return current;
    }
  }

  throw new Error(`Animation frames did not settle within ${SETTLE_TIMEOUT_MS}ms`);
}

function metricMap(result) {
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-report-idle-"));
const reportPath = path.join(tempDir, "report.html");
let browser;

try {
  fs.writeFileSync(reportPath, render(_load_stats(FIXTURE)), "utf8");
  browser = await launchBrowser();
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    let requested = 0;
    let fired = 0;
    window.requestAnimationFrame = (callback) => {
      requested += 1;
      return requestFrame((timestamp) => {
        fired += 1;
        callback(timestamp);
      });
    };
    Object.defineProperty(window, "__idleRafProbe", {
      value: { snapshot: () => ({ requested, fired }) },
    });
  });

  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");
  await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });

  const glowCanvases = await page.locator("canvas#glow").count();
  assert.equal(glowCanvases, 0, "the removed ambient-glow canvas returned");

  const settledFrames = await waitForAnimationFramesToSettle(page);
  await client.send("HeapProfiler.collectGarbage");
  const beforeMetrics = metricMap(await client.send("Performance.getMetrics"));

  await page.waitForTimeout(SAMPLE_MS);

  const afterFrames = await page.evaluate(() => window.__idleRafProbe.snapshot());
  const afterMetrics = metricMap(await client.send("Performance.getMetrics"));
  await client.send("HeapProfiler.collectGarbage");
  const afterGcMetrics = metricMap(await client.send("Performance.getMetrics"));
  const idleTaskDurationMs = (afterMetrics.TaskDuration - beforeMetrics.TaskDuration) * 1_000;

  assert.deepEqual(afterFrames, settledFrames, "new JavaScript animation frames ran while idle");
  assert.equal(afterGcMetrics.Nodes, beforeMetrics.Nodes, "the live DOM node count changed while idle");
  assert.ok(
    idleTaskDurationMs <= MAX_TASK_DURATION_MS,
    `idle TaskDuration grew by ${idleTaskDurationMs.toFixed(1)}ms (limit ${MAX_TASK_DURATION_MS}ms)`,
  );

  console.log(
    JSON.stringify({
      sampleSeconds: SAMPLE_MS / 1_000,
      idleAnimationFrames: afterFrames.fired - settledFrames.fired,
      domNodes: afterGcMetrics.Nodes,
      idleTaskDurationMs: Number(idleTaskDurationMs.toFixed(1)),
    }),
  );
} finally {
  await browser?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
