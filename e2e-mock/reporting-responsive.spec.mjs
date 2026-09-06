// Phase 7 of the responsive plan: usage/report, history/day-cards, status,
// appearance, and the process manager's dense table.
//
// Same conventions as the other per-viewport responsive specs
// (editors-settings-responsive, sessions-transcripts-responsive): every test
// sets its own viewport and navigates by URL, so this runs in the default
// `chromium` project rather than the fixed responsive-viewport-matrix projects.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const LANDSCAPE_PHONE = { width: 667, height: 375 };    // >=600px wide -> icon rail, not the phone drawer
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

async function gotoReady(page, route, ready) {
  await page.goto(route);
  await expect(ready).toBeVisible({ timeout: 15000 });
}

// Opens the Processes dialog. Phone has no rail/More menu (Phase 1) — its
// destinations live in the drawer instead; tablet/desktop keep the rail's
// More menu (processes.spec.mjs's existing path).
async function openProcesses(page, isPhone) {
  if (isPhone) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Processes' }).click();
  } else {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Processes' }).click();
  }
  await expect(page.getByText('Running Processes')).toBeVisible();
}

// ------------------------------------------------------------------- usage

test('phone usage: single-column provider grid, report iframe explicitly sized, no overflow', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());

  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
  const claudeBox = await page.getByText('Claude', { exact: true }).first().boundingBox();
  const ollamaBox = await page.getByText('Ollama', { exact: true }).first().boundingBox();
  // Auto-fit minmax(300px,1fr) collapses to one column once the pane is
  // narrower than 2*300px — the phone case this grid was written for.
  expect(Math.abs(claudeBox.x - ollamaBox.x)).toBeLessThan(2);

  const report = page.getByTitle('Usage report');
  await expect(report).toBeVisible();
  const box = await report.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  // Explicit, not viewport-unbounded: the iframe never exceeds its pane.
  expect(box.width).toBeLessThanOrEqual(PHONE.width);

  await expectNoPageOverflow(page);
});

test('desktop usage: provider cards run side by side, report iframe still explicitly sized', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());

  // "Session (5h)" is the full-size ProviderCard's own label — the sidebar
  // rail's UsagePanel mini-bars use the short "5h"/"7d" labels instead, so this
  // text is unambiguous and unaffected by the rail also rendering at desktop.
  // Codex has no session window (push-only data), so the two matches are
  // Claude then Ollama in DOM order.
  const sessionLabels = page.getByText('Session (5h)', { exact: true });
  const claudeBox = await sessionLabels.nth(0).boundingBox();
  const ollamaBox = await sessionLabels.nth(1).boundingBox();
  expect(Math.abs(claudeBox.x - ollamaBox.x)).toBeGreaterThan(200);

  const report = page.getByTitle('Usage report');
  await expect(report).toBeVisible();
  const box = await report.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await expectNoPageOverflow(page);
});

test('landscape phone usage: report iframe keeps a real height at 375px viewport height', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());

  const report = page.getByTitle('Usage report');
  await expect(report).toBeVisible();
  const box = await report.boundingBox();
  expect(box.height).toBeGreaterThan(0);
  await expectNoPageOverflow(page);
});

test('usage at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());
  await expectNoPageOverflow(page);
});

// ----------------------------------------------------------------- history

test('phone history: a day\'s project row is a labelled, keyboard-focusable scroll region, card reachable', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/history', page.getByText('History', { exact: true }).first());

  const region = page.getByRole('region', { name: /^Projects for/ }).first();
  await expect(region).toBeVisible();
  expect(await region.getAttribute('tabindex')).toBe('0');
  const geom = await region.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ch: el.clientHeight }));
  // The 300px fixed card width does not fit the phone's ~240px content pane
  // (375 - 56px spine - padding), so the region is genuinely scrollable, not
  // just labelled.
  expect(geom.sw).toBeGreaterThan(geom.cw);
  expect(geom.ch).toBeGreaterThan(60); // at least one card tall, not squashed

  // The card itself (300px, fixed) is wider than the region's ~269px clientWidth
  // on a 375px phone, so it can never be 99% in viewport in one frame — that's
  // the point of scrolling. The far-right control analog here is the card's own
  // right-aligned "N session(s)" label: prove *that* is reachable, not the whole
  // card's decorative bounding box (mirrors TableScroller's "Delete" reachability
  // check rather than the whole row's).
  const card = region.getByRole('article').first();
  const sessionsLabel = card.getByText(/^\d+ sessions?$/);
  await sessionsLabel.scrollIntoViewIfNeeded();
  await expect(sessionsLabel).toBeInViewport({ ratio: 0.99 });
  await expectNoPageOverflow(page);
});

test('desktop history: day cards render inline, no forced scroll', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/history', page.getByText('History', { exact: true }).first());

  const region = page.getByRole('region', { name: /^Projects for/ }).first();
  await expect(region).toBeVisible();
  const geom = await region.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(geom.sw).toBeLessThanOrEqual(geom.cw + 1);
  await expectNoPageOverflow(page);
});

test('tablet history: filter popover opens and the timeframe tab is usable', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await gotoReady(page, '/history', page.getByText('History', { exact: true }).first());

  await page.getByRole('button', { name: 'Filter history' }).click();
  await expect(page.getByRole('tab', { name: 'Timeframe' })).toBeVisible();
  await page.getByRole('button', { name: '30d' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('preset')).toBe('30');
  await expectNoPageOverflow(page);
});

test('history at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await gotoReady(page, '/history', page.getByText('History', { exact: true }).first());
  await expectNoPageOverflow(page);
});

// ------------------------------------------------------------------ status

test('phone status: provider cards stack single-column, incident link reachable', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/status', page.getByText('Provider status', { exact: true }));

  await expect(page.getByText('All Systems Operational')).toBeVisible();
  // Descriptions are unique to the main StatusView cards — unlike the bare
  // provider name, which the sidebar rail's usage panel also renders.
  const claudeBox = await page.getByText('All Systems Operational').boundingBox();
  const openaiBox = await page.getByText('Partially Degraded Service').boundingBox();
  expect(Math.abs(claudeBox.x - openaiBox.x)).toBeLessThan(2);

  const link = page.getByRole('link', { name: 'details' });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('tablet/desktop status: provider cards run two per row', async ({ page }) => {
  for (const vp of [TABLET, COMPACT, DESKTOP]) {
    await page.setViewportSize(vp);
    await gotoReady(page, '/status', page.getByText('Provider status', { exact: true }));
    await expect(page.getByText('All Systems Operational')).toBeVisible();
    const claudeBox = await page.getByText('All Systems Operational').boundingBox();
    const openaiBox = await page.getByText('Partially Degraded Service').boundingBox();
    expect(Math.abs(claudeBox.x - openaiBox.x)).toBeGreaterThan(100);
    await expectNoPageOverflow(page);
  }
});

test('tablet status: two per row in BOTH skins (grid is skin-independent)', async ({ page }) => {
  // Regression for the review's MEDIUM finding: the grid used the theme's `md`,
  // which ZAPAC redefines to 720px and Phosphor leaves at 900px, so 768px showed
  // two columns in one skin and one column in the other.
  for (const skin of ['ZAPAC', 'Phosphor Console']) {
    await seedSkin(page, skin);
    await page.setViewportSize(TABLET);
    await gotoReady(page, '/status', page.getByText('Provider status', { exact: true }));
    const claudeBox = await page.getByText('All Systems Operational').boundingBox();
    const openaiBox = await page.getByText('Partially Degraded Service').boundingBox();
    expect(Math.abs(claudeBox.x - openaiBox.x), `two columns under ${skin}`).toBeGreaterThan(100);
    await expectNoPageOverflow(page);
  }
});

test('status at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await gotoReady(page, '/status', page.getByText('Provider status', { exact: true }));
  await expectNoPageOverflow(page);
});

// -------------------------------------------------------------- appearance

test('phone appearance: skin cards wrap, color-mode toggle reachable, no overflow at 320px', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/appearance', page.getByRole('heading', { name: 'Appearance' }));

  const zapac = page.getByRole('radio').filter({ hasText: 'ZAPAC' });
  const phosphor = page.getByRole('radio').filter({ hasText: 'Phosphor Console' });
  await expect(zapac).toBeVisible();
  await expect(phosphor).toBeVisible();
  const zapacBox = await zapac.boundingBox();
  const phosphorBox = await phosphor.boundingBox();
  // Two 240px-wide cards don't fit a 375px pane — flexWrap puts the second below the first.
  expect(phosphorBox.y).toBeGreaterThan(zapacBox.y);

  const darkBtn = page.getByRole('button', { name: 'Dark mode' });
  await darkBtn.scrollIntoViewIfNeeded();
  await expect(darkBtn).toBeInViewport();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 320, height: 667 });
  await expectNoPageOverflow(page);
});

// ----------------------------------------------------------------- processes

test('phone processes: dense table keeps a labelled scroll region, Stop reachable', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await openProcesses(page, true);

  const region = page.getByRole('region', { name: 'Running processes (scrolls horizontally)' });
  await expect(region).toBeVisible();
  expect(await region.getAttribute('tabindex')).toBe('0');
  const geom = await region.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ch: el.clientHeight }));
  expect(geom.sw).toBeGreaterThan(geom.cw);
  expect(geom.ch).toBeGreaterThanOrEqual(36);

  const stop = page.getByRole('button', { name: 'Close' }).first();
  await stop.scrollIntoViewIfNeeded();
  await expect(stop).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('tablet processes: dense table also scrolls (narrow applies below 900px)', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await page.goto('/');
  await openProcesses(page, false);

  const region = page.getByRole('region', { name: 'Running processes (scrolls horizontally)' });
  await expect(region).toBeVisible();
  await expectNoPageOverflow(page);
});

test('desktop processes: no scroll region wrapper, table renders as before', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await openProcesses(page, false);

  await expect(page.getByRole('region', { name: 'Running processes (scrolls horizontally)' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Process ID' })).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('landscape phone processes: dialog stays usable at 375px height', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/');
  await openProcesses(page, false); // landscape phone is >=600px wide -> the rail's More menu, not the drawer

  const closeBtn = page.getByRole('button', { name: 'Close', exact: true }).last();
  await closeBtn.scrollIntoViewIfNeeded();
  await expect(closeBtn).toBeInViewport();
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------------- Phosphor skin

// permanent Phosphor case (editors-settings-responsive.spec.mjs:153's shape):
// verifies these routes mount and stay overflow-free under the other skin,
// not just ZAPAC.
test('Phosphor Console: usage and status mount and stay overflow-free at desktop and phone', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  for (const vp of [DESKTOP, PHONE]) {
    await page.setViewportSize(vp);
    await page.goto('/usage');
    await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto('/status');
    await expect(page.getByText('Provider status', { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
