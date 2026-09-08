// Phase 5 of the responsive plan: the five Rail-based editor panels (Config,
// Hooks, Rules, Memory, Skills) and the Settings tabs (Shortcuts, Models).
//
// Same conventions as the other per-viewport responsive specs
// (sessions-transcripts-responsive, tasks-automation-responsive): every test
// sets its own viewport and navigates by URL, so this runs in the default
// `chromium` project rather than the fixed responsive-viewport-matrix projects.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const LANDSCAPE_PHONE = RESPONSIVE_VIEWPORTS.landscapePhone;    // >=600px wide -> Rail, not the phone switcher
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

// The shared pane switcher (PhonePane.jsx) — one per panel. Its two button
// labels vary per panel (Config/Hooks/Rules keep Files|Editor; Memory/Skills
// use their own list label), so it's located by its group aria-label, not by
// button text.
const switcher = (page) => page.getByRole('group', { name: 'Pane switch' });

async function gotoReady(page, route, ready) {
  await page.goto(route);
  await expect(ready).toBeVisible({ timeout: 15000 });
}

// Opens the workspace config tree and the project settings.json.
const openConfigSettings = async (page) => {
  await page.getByRole('button', { name: /workspace/ }).first().click();
  await page.getByRole('button', { name: /settings\.json/ }).first().click();
  await expect(page.locator('.cm-content').first()).toContainText('Bash(git status)', { timeout: 15000 });
};
// ------------------------------------------------------ phone: pane switchers

test('phone config: one pane at a time; opening a file reveals it at full width', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());

  const sw = switcher(page);
  await expect(sw).toBeVisible();
  await expect(sw.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeDisabled();

  // The tree row spans the pane (before this phase the Rail clamped to its
  // ~200px floor, leaving ~165px for both panes on a 375px phone).
  const row = page.getByRole('button', { name: /workspace/ }).first();
  const rowBox = await row.boundingBox();
  expect(rowBox.width).toBeGreaterThan(300);

  await openConfigSettings(page); // expands the workspace node, opens settings.json
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const cmBox = (await page.locator('.cm-editor').first().boundingBox());
  expect(cmBox.width).toBeGreaterThan(300);
  await expectNoPageOverflow(page);

  // Back to Files shows the tree again, full width, no reload.
  await sw.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('phone rules: opening a rule switches to the editor pane', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/rules', page.getByRole('button', { name: /workspace/ }).first());

  const sw = switcher(page);
  await page.getByRole('button', { name: /style\.md/ }).first().click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-content').first()).toContainText('# Style');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeEnabled();
  await expectNoPageOverflow(page);
});

test('phone hooks: opening a hook file switches to the editor pane', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/hooks', page.getByRole('button', { name: /workspace/ }).first());

  const sw = switcher(page);
  await page.getByRole('button', { name: /pre-commit\.sh/ }).first().click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-content').first()).toContainText('fixture hook');
  await expectNoPageOverflow(page);
});

test('phone memory: opening a memory file switches to the editor pane', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/memory', page.getByRole('button', { name: /MEMORY\.md|deploy-notes/ }).first());

  const sw = switcher(page);
  await page.getByRole('button', { name: /retry-cap/ }).first().click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-content').first()).toContainText('Backoff caps at 30s');
  await expectNoPageOverflow(page);
});

test('phone skills: opening a skill switches to the editor pane', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/skills', page.getByRole('button', { name: /skills/ }).first());

  const sw = switcher(page);
  await page.getByRole('button', { name: 'coding' }).click();
  await page.getByRole('button', { name: /lint-guard/ }).first().click();
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-content').first()).toContainText('# Lint guard');
  await expectNoPageOverflow(page);
});

// --------------------------------------------------------- settings / models

test('phone models: the fixed-width columns keep a labelled horizontal scroll region, right-most control reachable', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoReady(page, '/settings?tab=models', page.getByRole('button', { name: 'Restore defaults' }));

  // Phase 3's narrow representation for dense rows: a labelled, focusable
  // region scrolls in its own bounds instead of crushing the 210/170/96px
  // columns into ~340px.
  const region = page.getByRole('region', { name: 'Model list (scrolls horizontally)' });
  await expect(region).toBeVisible();
  expect(await region.getAttribute('tabindex')).toBe('0');
  const geom = await region.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.clientHeight }));
  expect(geom.sw).toBeGreaterThan(geom.cw); // genuinely scrollable, not clipped
  expect(geom.cw).toBeGreaterThan(300);
  expect(geom.sh).toBeGreaterThanOrEqual(36); // at least one row tall (vertical budget)

  // The far-right control is reachable by scrolling the region, not the page.
  const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
  await del.scrollIntoViewIfNeeded();
  await expect(del).toBeInViewport();
  await expectNoPageOverflow(page);

  // Summariser row (outside the region) is vertically reachable in the page
  // scroller — centering it scrolls that scroller, not the horizontal region.
  // The field, not its floating label: the notched-outline legend clips the
  // label span to ~50% of its box by design, which breaks a ratio assertion.
  const sum = page.getByRole('combobox', { name: 'History summariser' });
  await sum.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(sum).toBeInViewport({ ratio: 0.99 });
});

test('desktop models: no scroll region wrapper, columns render as before', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/settings?tab=models', page.getByRole('button', { name: 'Restore defaults' }));

  await expect(page.getByRole('region', { name: 'Model list (scrolls horizontally)' })).toHaveCount(0);
  await expect(page.getByText('Model id', { exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
});

// The crash itself: Phosphor reads a glass token through getTokens() now, so
// the settings route mounts under that skin (root cause of the baseline
// sampler's tracked exception — fixed, not suppressed).
test('Phosphor Console: the settings route mounts instead of crashing, at desktop and phone', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  for (const vp of [DESKTOP, PHONE]) {
    await page.setViewportSize(vp);
    await page.goto('/settings');
    await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('tab', { name: 'Shortcuts' })).toBeVisible();
    await page.getByRole('tab', { name: 'Shortcuts' }).click();
    await expect(page.getByRole('button', { name: 'Reset all' })).toBeInViewport();
    await expectNoPageOverflow(page);
  }
});

// --------------------------------------------------- tablet / compact / desktop

test('tablet, compact and desktop config: two panes, no phone switcher', async ({ page }) => {
  for (const vp of [TABLET, COMPACT, DESKTOP]) {
    await page.setViewportSize(vp);
    await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());
    await expect(switcher(page)).toHaveCount(0);
    await openConfigSettings(page);
    await expect(page.locator('.cm-editor').first()).toBeVisible();
    const cmBox = await page.locator('.cm-editor').first().boundingBox();
    expect(cmBox.width).toBeGreaterThan(200);
    await expectNoPageOverflow(page);
  }
});

// Landscape phone (667x375) is tablet-by-width: the side-by-side Rail layout
// is the landscape-friendly shape; check its vertical budget instead.
test('landscape phone config: Rail and editor side by side, Save reachable at 375px height', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());

  await expect(switcher(page)).toHaveCount(0);
  await openConfigSettings(page);
  await expect(page.locator('.cm-editor').first()).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expectNoPageOverflow(page);
});

// ------------------------------------------------------------------ 320x667

test('config at 320px: no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize(RESPONSIVE_VIEWPORTS.narrowest);
  await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());
  await expectNoPageOverflow(page);
});

// ------------------------------------------------- desktop -> phone crossing

test('desktop -> phone with a file open lands on the editor, content and node preserved', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());
  await openConfigSettings(page);

  // Tag the mounted CodeMirror node so the assertion proves no remount (and
  // therefore no reload) across the crossing.
  await page.locator('.cm-editor').first().evaluate((el) => { el.dataset.keep = 'yes'; });

  // Unsaved edit before the crossing.
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n/* unsaved */');

  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const cm = page.locator('.cm-editor').first();
  await expect(cm).toBeVisible();
  expect(await cm.getAttribute('data-keep')).toBe('yes');
  await expect(page.locator('.cm-content').first()).toContainText('unsaved');
  await expectNoPageOverflow(page);
});

test('desktop -> phone with nothing open stays on the file list', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoReady(page, '/config', page.getByRole('button', { name: /workspace/ }).first());

  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeDisabled();
});

// Phase 8 B3 gap 5: the crossing above only covered Config; Memory and Hooks
// set their pane through non-identical paths (Memory synchronously, Hooks
// inside a fetch .then), so the shared PhonePane crossing half needed proof
// across all five panels, each with its own phone -> desktop return.
const PHONE_PANE_PANELS = [
  {
    route: '/config', ready: (p) => p.getByRole('button', { name: /workspace/ }).first(),
    open: (p) => openConfigSettings(p), content: 'Bash(git status)',
  },
  {
    route: '/hooks', ready: (p) => p.getByRole('button', { name: /workspace/ }).first(),
    open: (p) => p.getByRole('button', { name: /pre-commit\.sh/ }).first().click(), content: 'fixture hook',
  },
  {
    route: '/rules', ready: (p) => p.getByRole('button', { name: /workspace/ }).first(),
    open: (p) => p.getByRole('button', { name: /style\.md/ }).first().click(), content: '# Style',
  },
  {
    route: '/memory', ready: (p) => p.getByRole('button', { name: /MEMORY\.md|deploy-notes/ }).first(),
    open: (p) => p.getByRole('button', { name: /retry-cap/ }).first().click(), content: 'Backoff caps at 30s',
  },
  {
    route: '/skills', ready: (p) => p.getByRole('button', { name: /skills/ }).first(),
    open: async (p) => { await p.getByRole('button', { name: 'coding' }).click(); await p.getByRole('button', { name: /lint-guard/ }).first().click(); },
    content: '# Lint guard',
  },
];

for (const { route, ready, open, content } of PHONE_PANE_PANELS) {
  test(`desktop -> phone -> desktop crossing for ${route}: pane follows, node and content preserved`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoReady(page, route, ready(page));
    await open(page);
    await expect(page.locator('.cm-content').first()).toContainText(content);
    await page.locator('.cm-editor').first().evaluate((el) => { el.dataset.keep = 'yes'; });

    await page.setViewportSize(PHONE);
    const sw = switcher(page);
    await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const cm = page.locator('.cm-editor').first();
    await expect(cm).toBeVisible();
    expect(await cm.getAttribute('data-keep')).toBe('yes');
    await expectNoPageOverflow(page);

    await page.setViewportSize(DESKTOP);
    await expect(switcher(page)).toHaveCount(0);
    const cm2 = page.locator('.cm-editor').first();
    expect(await cm2.getAttribute('data-keep')).toBe('yes');
    await expect(cm2).toContainText(content);
  });
}