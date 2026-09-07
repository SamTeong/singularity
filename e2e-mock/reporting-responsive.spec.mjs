// Phase 7 of the responsive plan: usage/report, history/day-cards, status,
// appearance, and the process manager's dense table.
//
// Same conventions as the other per-viewport responsive specs
// (editors-settings-responsive, sessions-transcripts-responsive): every test
// sets its own viewport and navigates by URL, so this runs in the default
// `chromium` project rather than the fixed responsive-viewport-matrix projects.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, expectReachableByPaneScroll, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const LANDSCAPE_PHONE = RESPONSIVE_VIEWPORTS.landscapePhone;    // >=600px wide -> icon rail, not the phone drawer
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

// Phase 8 A5 regression: the report pane's flex chain (UsageView.jsx) used to
// pin the iframe at its 240px floor (178px content) at every viewport,
// because the sibling provider-meters section had no bound on its own
// natural height and always outweighed the shrinkable budget before the
// report ever saw a surplus to grow into. The report's flex-basis is now
// proportional (clamp(240px, 55vh, 640px)) instead of the bare floor, so it
// no longer depends on a leftover that never exists.
test('desktop usage: report pane grows beyond its floor when the viewport has surplus room', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());

  const report = page.getByTitle('Usage report');
  await expect(report).toBeVisible();
  const box = await report.boundingBox();
  // The floor alone renders at 178px; real growth clears 190px with margin.
  expect(box.height).toBeGreaterThan(190);
  await expectNoPageOverflow(page);
});

// Phase 8 A5's first shape capped the provider-meters section at 200px with an
// internal scroll, which cut a provider card mid-meter — reported as the Usage
// report panel overlapping the Usage panel. The meters section now takes its
// natural height and the pane's own viewport scrolls instead.
//
// The bar this asserts is "nothing INSIDE the pane cuts a card", not "a whole
// card always fits on screen". The pane is never the viewport — masthead, rail
// and dock eat into it — so at four of the twelve viewport/skin combinations
// the pane is measurably shorter than one 364-368px card (ZAPAC 667x375: 299px;
// Phosphor 320x667 and 375x667: 358px; Phosphor 667x375: 210px; Phosphor
// 1024x768: 329px). No layout inside UsageView can raise those numbers, and the
// card is fully reachable by scrolling the pane — which the second assertion
// proves. Accepted as a vertical-budget constraint, not a clipping defect.
for (const skin of ['ZAPAC', 'Phosphor Console']) {
  for (const [name, viewport] of Object.entries(RESPONSIVE_VIEWPORTS)) {
    test(`usage (${skin} ${name}): no section inside the pane clips a provider card`, async ({ page }) => {
      await seedSkin(page, skin);
      await page.setViewportSize(viewport);
      await gotoReady(page, '/usage', page.getByRole('button', { name: /collapse usage|expand usage/i }).first());

      // Anchored on "Session (5h)" — the full-size ProviderCard's own label. The
      // sidebar rail renders its own Claude/Ollama rows with the short "5h"
      // label, so a provider-name locator would match the rail first and never
      // reach this view at all.
      const clip = await page.evaluate(() => {
        const label = [...document.querySelectorAll('*')].find((e) => !e.children.length && e.textContent === 'Session (5h)');
        let card = label;
        for (let i = 0; i < 6 && card; i++) {
          const cs = getComputedStyle(card);
          if (cs.borderTopWidth !== '0px' && cs.paddingTop !== '0px') break;
          card = card.parentElement;
        }
        // The pane is the scroll viewport that holds BOTH the meters and the
        // report iframe — identified by content, not by "first bounded
        // ancestor", which would make the check circular. Anything bounded
        // between the card and it is a section cutting the card short.
        const report = document.querySelector('[title="Usage report"]');
        const bad = [];
        for (let n = card.parentElement; n && n !== document.body; n = n.parentElement) {
          if (report && n.contains(report)) break;
          const oy = getComputedStyle(n).overflowY;
          if (oy !== 'visible' && n.clientHeight > 0 && n.clientHeight < card.offsetHeight) {
            bad.push({ cardH: card.offsetHeight, sectionH: n.clientHeight, overflowY: oy });
          }
        }
        return { bad, sawReport: !!report };
      });
      expect(clip.sawReport, 'the report iframe anchors the pane boundary').toBe(true);
      expect(clip.bad, `${skin} ${name}: no section between a provider card and the pane may be shorter than the card`).toEqual([]);

      // ...and the far end of the card is reachable by scrolling the pane, not
      // by scrolling the page or an ancestor no finger can move.
      await expectReachableByPaneScroll(page, page.getByText('Weekly (7d)', { exact: true }).first());
      await expectNoPageOverflow(page);
    });
  }
}

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
  await page.setViewportSize(RESPONSIVE_VIEWPORTS.narrowest);
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
  await page.setViewportSize(RESPONSIVE_VIEWPORTS.narrowest);
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

// Phase 8 A6 regression: the per-component grid inside each ProviderCard used
// the theme's `sm` breakpoint (a viewport decision) even though it lives
// inside a variable-width card. At a viewport just under BOTH skins' `sm`
// (ZAPAC 560, Phosphor's default 600) the old code forced a single column
// regardless of how much room the card actually had; auto-fit tracks the
// card's real content width instead.
test('status component grid: two columns below both skins\' `sm`, because the card has room (container-driven, not viewport)', async ({ page }) => {
  for (const skin of ['ZAPAC', 'Phosphor Console']) {
    await seedSkin(page, skin);
    await page.setViewportSize({ width: 500, height: 900 });
    await gotoReady(page, '/status', page.getByText('Provider status', { exact: true }));
    await expect(page.getByText('All Systems Operational')).toBeVisible();

    const geom = await page.evaluate(() => {
      const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent === 'All Systems Operational');
      let card = label;
      for (let i = 0; i < 6 && card; i++) {
        const cs = getComputedStyle(card);
        if (cs.borderTopWidth !== '0px' && cs.paddingTop !== '0px') break;
        card = card.parentElement;
      }
      const grids = [...card.querySelectorAll('div')].filter((d) => getComputedStyle(d).display === 'grid');
      const ig = grids[grids.length - 1];
      const cols = getComputedStyle(ig).gridTemplateColumns.split(' ').filter((c) => parseFloat(c) > 1);
      return { cols: cols.length };
    });
    expect(geom.cols, `${skin} two columns at 500px (card has room)`).toBeGreaterThanOrEqual(2);
    await expectNoPageOverflow(page);
  }
});

test('status at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize(RESPONSIVE_VIEWPORTS.narrowest);
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

  await page.setViewportSize(RESPONSIVE_VIEWPORTS.narrowest);
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

// Phase 8 B3 gap 7: the baseline route sampler (responsive.spec.mjs) already
// loops both skins over all 15 routes, so History and Appearance get Phosphor
// coverage there — but Processes is a dialog, unreachable by a route-only
// sampler, and had no Phosphor case at all.
test('Phosphor Console: the processes dialog mounts and stays overflow-free at desktop and phone', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  for (const [vp, isPhone] of [[DESKTOP, false], [PHONE, true]]) {
    await page.setViewportSize(vp);
    await page.goto('/');
    await openProcesses(page, isPhone);
    await expectNoPageOverflow(page);
  }
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
