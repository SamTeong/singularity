// Regenerate the three README screenshots from assets/example-report.html.
// Drives a local Chromium via playwright-core (no MCP). Run after render-example.mjs
// whenever the design changes:
//   npm i -g playwright-core   # or install in scope; browsers via `npx playwright install chromium`
//   node scripts/screenshot-example.mjs
// playwright-core is resolved across known module roots (override: PW_CORE=<dir
// containing node_modules/playwright-core>). Browser is auto-discovered: playwright's
// own build -> newest ms-playwright build -> system Edge/Chrome. Override with CHROMIUM_EXE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = path.join(SKILL, "assets");
const REPORT = pathToFileURL(path.join(ASSETS, "example-report.html")).href;
const HOME = os.homedir();

// Resolve playwright-core without declaring it as a skill dep: walk a few known
// module roots (PW_CORE override -> script-local -> ~/.agents/bin/pw-core ->
// global npm). ESM ignores NODE_PATH, so resolve explicitly via createRequire.
function loadChromium() {
  const bases = [
    process.env.PW_CORE && path.join(process.env.PW_CORE, "_"),
    path.join(SKILL, "scripts", "_"),
    path.join(HOME, ".agents", "bin", "pw-core", "_"),
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "_"),
    "/usr/local/lib/node_modules/_",
  ].filter(Boolean);
  for (const base of bases) {
    try {
      const entry = createRequire(base).resolve("playwright-core");
      return import(pathToFileURL(entry).href).then((m) => m.chromium || m.default?.chromium);
    } catch {}
  }
  throw new Error(
    "playwright-core not found. Install it and a browser:\n" +
      "  npm i -g playwright-core && npx playwright install chromium\n" +
      "or point PW_CORE at a dir containing node_modules/playwright-core.",
  );
}

// Newest ms-playwright chromium build for the current OS (fallback browser).
function findMsPlaywrightChromium() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
    path.join(HOME, "AppData", "Local", "ms-playwright"),
    path.join(HOME, "Library", "Caches", "ms-playwright"),
    path.join(HOME, ".cache", "ms-playwright"),
  ].filter(Boolean);
  const rel =
    { win32: "chrome-win64/chrome.exe", darwin: "chrome-mac/Chromium.app/Contents/MacOS/Chromium" }[
      process.platform
    ] || "chrome-linux/chrome";
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const builds = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => (parseInt(b.split("-")[1]) || 0) - (parseInt(a.split("-")[1]) || 0));
    for (const b of builds) {
      const exe = path.join(root, b, rel);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Launch order: explicit CHROMIUM_EXE -> playwright's own browser -> newest
// ms-playwright build -> system Edge/Chrome (channel, needs no path).
async function launchBrowser(chromium) {
  if (process.env.CHROMIUM_EXE)
    return chromium.launch({ executablePath: process.env.CHROMIUM_EXE, headless: true });
  try {
    return await chromium.launch({ headless: true });
  } catch {}
  const exe = findMsPlaywrightChromium();
  if (exe) return chromium.launch({ executablePath: exe, headless: true });
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error("No Chromium/Chrome/Edge found. Run: npx playwright install chromium");
}

// [name, startAnchorId|null, endAnchorId|null, endCardH3?]
// Start at top(startAnchorId)-pad (or page top). End at bottom of the card whose
// <h3> matches endCardH3, else at top(endAnchorId)-gap.
const SHOTS = [
  ["screenshot-overview", null, null, "Daily spend calendar"],
  ["screenshot-token-economics", "sec-token-economics", null, "Token composition by day"],
  ["screenshot-by-project", "sec-by-project", "sec-models"],
];

const chromium = await loadChromium();
const browser = await launchBrowser(chromium);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto(REPORT, { waitUntil: "networkidle" });
// Hide sticky/fixed chrome, and flatten the position:fixed ambient glow to the
// solid --paper base. On a full-height capture viewport the glow gradient would
// stretch and cool the deeper sections, giving each screenshot a different tint.
await page.addStyleTag({
  content: ".topbar,.secnav{display:none!important} #glow,body::before{display:none!important}",
});
await page.waitForTimeout(1800); // let charts + reveal animations settle
// Grow the viewport to the full document height so clip regions past the first
// viewport still land inside the captured surface (clip is page-absolute).
const fullH = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 1280, height: Math.min(fullH, 16000) });
await page.waitForTimeout(400);

const topOf = (id) =>
  page.evaluate((i) => {
    if (!i) return 0;
    const r = document.getElementById(i).getBoundingClientRect();
    return r.top + window.scrollY;
  }, id);

const cardBottom = (h3text) =>
  page.evaluate((t) => {
    let b = 0;
    document.querySelectorAll("h3").forEach((h) => {
      if (h.textContent.trim() === t) {
        b = Math.round(h.closest(".card").getBoundingClientRect().bottom + window.scrollY);
      }
    });
    return b;
  }, h3text);

for (const [name, start, end, endCardH3] of SHOTS) {
  let y = (await topOf(start)) - (start ? 28 : 0);
  if (y < 0) y = 0;
  const endY = endCardH3 ? (await cardBottom(endCardH3)) + 14 : (await topOf(end)) - 32;
  const h = Math.round(endY - y);
  await page.screenshot({ path: path.join(ASSETS, `${name}.png`), clip: { x: 0, y, width: 1280, height: h } });
  console.log(name, "->", h, "px tall");
}

await browser.close();
