/**
 * Runtime console/crash scanner. Walks every view × every theme in a real
 * browser and fails on any console error/warning or uncaught exception — the
 * only way to catch render-time React "unknown prop" warnings, MUI deprecation
 * warnings, and theme-specific throws (e.g. a skin missing a token a component
 * reads) that no static lint sees.
 *
 * Prereq: the daemon serving the built UI on :4317 (`pnpm start`), and a local
 * Chrome (uses channel:'chrome' — playwright-core ships no browser binary).
 *
 * Run:  node scripts/scan-console.mjs [http://127.0.0.1:4317]
 * Exit: 0 clean, 1 if anything was logged.
 */
import { chromium } from 'playwright-core';

const URL = process.argv[2] || 'http://127.0.0.1:4317';
const SETTLE = 500; // ms to let a view render + effects fire before snapshotting

// Views reachable from the sidebar rail (label text, scoped to <aside>).
const RAIL = ['Tasks', 'Automation', 'Usage'];
// Views behind the More menu (menuitem accessible name).
const MENU = ['Config', 'Hooks', 'Skills', 'Rules', 'Memory', 'Transcripts', 'Wiki', 'Appearance'];
// Skins to walk every view under (radio accessible name in Appearance).
const SKINS = ['ZAPAC', 'Phosphor Console'];

const logs = []; // { theme, view, kind, text }
let ctx = { theme: '(boot)', view: '(load)' };
const record = (kind, text) => logs.push({ ...ctx, kind, text });

// Escape first: a lingering menu backdrop (e.g. after a skin remount) otherwise
// intercepts the click and the next open times out.
const openMenu = async (page) => {
  await page.keyboard.press('Escape');
  await page.locator('aside button:has([data-testid="MoreVertIcon"])').first().click();
};

// Navigate to a menu view: open the More menu, click the item, wait to settle.
async function gotoMenu(page, name) {
  await openMenu(page);
  await page.getByRole('menuitem', { name, exact: true }).click();
  await page.waitForTimeout(SETTLE);
}

// Switch skin via Appearance → radio. Remounts the whole shell (key=skin.id),
// so re-wait afterwards. Idempotent: clicking the active skin is a no-op.
async function setSkin(page, skin) {
  await gotoMenu(page, 'Appearance');
  // Radio's accessible name is label + description, so match by hasText, not exact.
  await page.getByRole('radio').filter({ hasText: skin }).click();
  await page.waitForTimeout(SETTLE);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') record(t, m.text());
});
page.on('pageerror', (e) => record('pageerror', e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(SETTLE);

for (const skin of SKINS) {
  ctx = { theme: skin, view: 'switch-skin' };
  await setSkin(page, skin);
  for (const view of RAIL) {
    ctx = { theme: skin, view };
    try {
      await page.locator('aside').getByText(view, { exact: true }).click();
      await page.waitForTimeout(SETTLE);
    } catch (e) { record('nav-fail', `${view}: ${e.message}`); }
  }
  for (const view of MENU) {
    ctx = { theme: skin, view };
    try { await gotoMenu(page, view); }
    catch (e) { record('nav-fail', `${view}: ${e.message}`); }
  }
}

await browser.close();

if (!logs.length) {
  console.log('clean — no console errors/warnings or exceptions across', SKINS.length, 'themes ×', RAIL.length + MENU.length, 'views');
  process.exit(0);
}
console.log(`${logs.length} issue(s):\n`);
for (const l of logs) console.log(`  [${l.theme} · ${l.view}] ${l.kind}: ${l.text.replace(/\s+/g, ' ').slice(0, 200)}`);
process.exit(1);
