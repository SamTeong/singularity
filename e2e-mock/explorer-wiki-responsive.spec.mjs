// Phase 6 of the responsive plan: Explorer (file tree / TabStrip / CodeMirror
// editor) and Wiki (page list / reader / cytoscape link graph).
//
// Same conventions as the other per-viewport responsive specs
// (editors-settings-responsive, sessions-transcripts-responsive): every test
// sets its own viewport and navigates by URL, so this runs in the default
// `chromium` project rather than the fixed responsive-viewport-matrix projects.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';
import { WIKI_NAME } from '../web/src/mock/fixtures.js';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const LANDSCAPE_PHONE = { width: 667, height: 375 };    // >=600px wide -> Rail, not the phone switcher
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

// The shared Files | Editor switcher (PhonePane.jsx) — one per panel.
const switcher = (page) => page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Files', exact: true }) });
const cmContent = (page) => page.locator('.cm-content').first();
// Wiki's Hub button carries its aria-label on the wrapping span (Tooltip), not
// the button — same shape the desktop wiki.spec.mjs resolves through.
const hub = (page) => page.locator('span[aria-label*="pages link together"] button');

async function gotoReady(page, route, ready) {
  await page.goto(route);
  await expect(ready).toBeVisible({ timeout: 15000 });
}

const explorerReady = (page) => page.getByRole('button', { name: 'notes.md', exact: true }).first();
// Wiki loads in two hops (GET /wiki/root then /wiki/files); the RailHeader
// caption is the ready signal the desktop wiki spec also waits on.
const wikiReady = (page) => page.getByText(/1 wiki\b.*4 pages/).first();

// The mock corpus' wiki tree starts collapsed; expand it and open a page.
async function openWikiPage(page, file) {
  await page.getByRole('button', { name: WIKI_NAME, exact: false }).first().click();
  await page.getByRole('button', { name: file, exact: true }).click();
}

// --------------------------------------------------- phone: explorer panes

test('phone explorer: one pane at a time; opening a file reveals it at full width', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/explorer', explorerReady(page));

  const sw = switcher(page);
  await expect(sw).toBeVisible();
  await expect(sw.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeDisabled();

  // The tree row spans the pane (before this phase the Rail clamped to its
  // ~200px floor, leaving ~165px for both panes on a 375px phone).
  const row = explorerReady(page);
  const rowBox = await row.boundingBox();
  expect(rowBox.width).toBeGreaterThan(300);

  await row.click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');
  expect((await page.locator('.cm-editor').first().boundingBox()).width).toBeGreaterThan(300);
  await expectNoPageOverflow(page);

  // Back to Files shows the tree again, full width, no reload.
  await sw.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row).toBeInViewport();
  await expectNoPageOverflow(page);
});

test.describe('phone explorer touch flows', () => {
  test.use({ hasTouch: true });

  test('browse, edit and save — every control reachable by tap', async ({ page }) => {
    await page.setViewportSize(PHONE);
  await gotoReady(page, '/explorer', explorerReady(page));

  // Real touch input, not a mouse click: expand, then open the nested file.
  await page.getByRole('button', { name: 'subdir', exact: true }).tap();
  await page.getByRole('button', { name: 'nested.txt', exact: true }).tap();
  await expect(cmContent(page)).toContainText('Nested file content.');

  await cmContent(page).tap();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' touch edit');
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await save.tap();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // Back to the list and re-open: the edit survives the pane switch.
  await switcher(page).getByRole('button', { name: 'Files', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'nested.txt', exact: true }).tap();
  await expect(cmContent(page)).toContainText('touch edit');
    await expectNoPageOverflow(page);
  });
});

// --------------------------------------------------------------- TabStrip

test('phone explorer: tabs stay in their own horizontal scroll region, close buttons reachable', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/explorer', explorerReady(page));

  const sw = switcher(page);
  await explorerReady(page).click();                       // notes.md
  await sw.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
  await sw.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'subdir', exact: true }).click();
  await page.getByRole('button', { name: 'nested.txt', exact: true }).click();

  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.filter({ hasText: 'nested.txt' })).toHaveAttribute('aria-selected', 'true');

  // The strip scrolls in its own bounds — never the page.
  const strip = page.getByRole('tablist', { name: 'Editor tabs' });
  const geom = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(geom.cw).toBeGreaterThan(300); // spans the full-width detail pane
  await expectNoPageOverflow(page);

  const last = tabs.nth(2);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const close = last.getByRole('button');
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();

  // Tapping a tab switches the editor back.
  await tabs.filter({ hasText: 'notes.md' }).click();
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');
});

// ------------------------------------------------------ explorer crossings

test('desktop -> phone with an open editor keeps the node and unsaved text', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/explorer', explorerReady(page));
  await explorerReady(page).click();
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');

  // Tag the mounted CodeMirror node so the assertion proves no remount (and
  // therefore no content loss) across the crossing.
  await page.locator('.cm-editor').first().evaluate((el) => { el.dataset.keep = 'yes'; });
  await cmContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/* unsaved */');

  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const cmNode = page.locator('.cm-editor').first();
  await expect(cmNode).toBeVisible();
  expect(await cmNode.getAttribute('data-keep')).toBe('yes');
  await expect(cmContent(page)).toContainText('unsaved');
  await expectNoPageOverflow(page);
});

test('phone -> desktop keeps the node and unsaved text', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/explorer', explorerReady(page));
  await explorerReady(page).click();
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');

  await page.locator('.cm-editor').first().evaluate((el) => { el.dataset.keep = 'yes'; });
  await cmContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/* unsaved */');

  await page.setViewportSize(DESKTOP);
  await expect(switcher(page)).toHaveCount(0);
  const cmNode = page.locator('.cm-editor').first();
  await expect(cmNode).toBeVisible();
  expect(await cmNode.getAttribute('data-keep')).toBe('yes');
  await expect(cmContent(page)).toContainText('unsaved');
  await expectNoPageOverflow(page);
});

// -------------------------------------------------------- phone: wiki

test('phone wiki: page list/reader switcher; the graph opens full width via the Hub', async ({ page, consoleGuard }) => {
  // FINDING (app, not test): WikiGraph's non-default wheelSensitivity logs a
  // console warning once per cytoscape mount — allowed here, tracked in the
  // desktop wiki spec.
  consoleGuard.allow(/custom wheel sensitivity/i);
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/wiki', wikiReady(page));

  const sw = switcher(page);
  await expect(sw).toBeVisible();
  await expect(sw.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeDisabled();

  await openWikiPage(page, 'index.md');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await expectNoPageOverflow(page);

  // The Hub lives in the list pane header; on phone it opens the graph in the
  // full-width editor pane (the dock has no height to spare inside the list).
  await sw.getByRole('button', { name: 'Files', exact: true }).click();
  await hub(page).click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`${WIKI_NAME} · how pages link together`).first()).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await expectNoPageOverflow(page);

  // Closing returns to the reader with the selection preserved.
  const close = page.getByRole('button', { name: 'Close graph' });
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  await close.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
});

test('phone wiki: re-tapping the already-selected page reveals the reader', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/wiki', wikiReady(page));
  await openWikiPage(page, 'index.md');
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();

  // Back to the list, then re-tap the selection — the reader must come back
  // (the sel?.path early-return must not swallow the pane switch).
  await switcher(page).getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'index.md', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
});

test('phone wiki: a desktop docked graph crossing down falls back to the list pane, controls reachable', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/custom wheel sensitivity/i);
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/wiki', wikiReady(page));
  await openWikiPage(page, 'index.md');
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Expand to main pane' })).toBeVisible();

  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  // The selection is detail, so the reader pane is up; the docked graph hides
  // with the list pane until the switcher surfaces it again.
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sw.getByRole('button', { name: 'Files', exact: true }).click();

  // Declared fallback: the dock renders under the list at reduced height, and
  // its controls are reachable, not clipped by an ancestor.
  const expand = page.getByRole('button', { name: 'Expand to main pane' });
  await expand.scrollIntoViewIfNeeded();
  await expect(expand).toBeInViewport();
  await expand.click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('canvas').first()).toBeVisible();
  await expectNoPageOverflow(page);
});

test('phone -> desktop with the graph open keeps it mounted', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/custom wheel sensitivity/i);
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/wiki', wikiReady(page));
  await openWikiPage(page, 'index.md');
  // The Hub lives in the list pane header — surface the list pane first.
  await switcher(page).getByRole('button', { name: 'Files', exact: true }).click();
  await hub(page).click();
  await expect(page.getByText(`${WIKI_NAME} · how pages link together`).first()).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();

  // Tag the graph container: if the crossing remounted WikiGraph, the attribute
  // would vanish with the node (and the fcose layout would re-run).
  await page.locator('canvas').first().evaluate((el) => { el.parentElement.dataset.keep = 'yes'; });

  await page.setViewportSize(DESKTOP);
  await expect(switcher(page)).toHaveCount(0);
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(await page.locator('canvas').first().evaluate((el) => el.parentElement.getAttribute('data-keep'))).toBe('yes');
  await expectNoPageOverflow(page);
});

// ------------------------------------------------- landscape phone / narrow

test('landscape phone explorer: Rail and editor side by side, Save reachable at 375px height', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await gotoReady(page, '/explorer', explorerReady(page));

  await expect(switcher(page)).toHaveCount(0);
  await explorerReady(page).click();
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');
  await cmContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('x');
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------- tablet / desktop

test('tablet, compact and desktop explorer: two panes, no phone switcher', async ({ page }) => {
  for (const vp of [TABLET, COMPACT, DESKTOP]) {
    await page.setViewportSize(vp);
    await gotoReady(page, '/explorer', explorerReady(page));
    await expect(switcher(page)).toHaveCount(0);
    await explorerReady(page).click();
    await expect(page.locator('.cm-editor').first()).toBeVisible();
    const box = await page.locator('.cm-editor').first().boundingBox();
    expect(box.width).toBeGreaterThan(200);
    await expectNoPageOverflow(page);
  }
});

test('desktop wiki: two panes and the docked graph cycle still work at 1440x900', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/custom wheel sensitivity/i);
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/wiki', wikiReady(page));
  await expect(switcher(page)).toHaveCount(0);

  await openWikiPage(page, 'index.md');
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Expand to main pane' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand to main pane' }).click();
  await expect(page.getByRole('button', { name: 'Dock to sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Close graph' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------------------- 320x667

test('explorer and wiki at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await gotoReady(page, '/explorer', explorerReady(page));
  await expectNoPageOverflow(page);
  await page.goto('/wiki');
  await expect(wikiReady(page)).toBeVisible({ timeout: 15000 });
  await expectNoPageOverflow(page);
});