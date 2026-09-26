// The unified reorder contract: at desktop (>=900px) a surface reorders by
// dragging its grip; below 900px (phone||tablet) an HTML5 drag is not operable
// by touch, so each card/row/tab gets the compact stacked Move buttons instead —
// the CronJobs reference idiom (vertical Stack, IconButton size="small"
// sx={{ p: 0.25 }}, Tooltip disableInteractive, boundary-disabled).
//
// Every test sets its own viewport, so this runs in the default `chromium`
// project like the other per-viewport responsive specs.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const SETTINGS_PATH = `${ROOTS.workspace}/.claude/settings.json`;
const LOCAL_PATH = `${ROOTS.workspace}/.claude/settings.local.json`;

const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

// ------------------------------------------------------------- project cards

// Cards are ordered by DOM position; the first <p> in the card is its repoName.
const cardTitles = (page) => page.locator('[data-testid="project-card"]').evaluateAll((els) => els.map((el) => el.querySelector('p')?.textContent || ''));

test('live 899/900 crossing swaps a project card between the drag grip and Move up/down buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/projects');

  // The card itself never drags — only its grip handle does.
  const card = page.getByTestId('project-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('[draggable="true"]')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Move up' })).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(card.locator('[draggable="true"]')).toHaveCount(0);
  const second = page.getByTestId('project-card').nth(1);
  // The mock seeds three projects, so the swapped pair is only the first two
  // titles — the tail must survive the move untouched.
  const titles = await cardTitles(page);
  const [firstName, secondName] = titles;
  const tail = titles.slice(2);
  await expect(second.getByRole('button', { name: `Move ${secondName} up` })).toBeVisible();
  await expectNoPageOverflow(page);

  // A tap runs moveCard — adjacent swap, then PUT /api/projects/order with the
  // whole path list. Mirage patches fetch inside the page, so app requests
  // never reach Playwright's network layer (automation.spec.mjs:6-9) and
  // waitForRequest would hang; read the persisted order back through the same
  // in-page fetch instead (the settings.spec.mjs:97 idiom).
  await second.getByRole('button', { name: `Move ${secondName} up` }).click();
  await expect.poll(() => cardTitles(page)).toEqual([secondName, firstName, ...tail]);
  const persisted = await page.evaluate(() => fetch('/api/projects').then((r) => r.json()));
  // Same basename rule as repoName in web/src/lib/paths.js.
  expect(persisted.projects.map((p) => p.split(/[\\/]/).pop())).toEqual([secondName, firstName, ...tail]);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(card.locator('[draggable="true"]')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Move up' })).toHaveCount(0);
});

// ----------------------------------------------------------------- dock rows

// Same create flow the dock responsive spec uses (mock mode has no seeded
// sessions, and the reorder seam needs a real ws round trip to be observable).
async function createSession(page, title) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('title (optional)').fill(title);
  await dialog.getByLabel('model', { exact: true }).fill('sonnet');
  await page.keyboard.press('Escape'); // close ModelSelect's option popper
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
}

// A row is a `[role="button"]` ListItemButton carrying an h6 heading with the
// session title. The `:has(h6)` anchor matters: the terminal dock's header is
// ALSO a role="button" Stack whose text is "<title> · model · cwd", so reading
// bare `[role="button"]` text counts that header as a third row.
const dockRows = (page) => page.locator('[role="button"]:has(h6)');

const fixtureOrder = (page) => dockRows(page).evaluateAll((els) => els
  .map((el) => el.textContent || '')
  .filter((t) => t.includes('Fixture crossing'))
  .map((t) => (t.includes('Fixture crossing A') ? 'A' : 'B')));

test('live 899/900 crossing swaps a dock row between the whole-row drag and Move up/down buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await createSession(page, 'Fixture crossing A');
  await createSession(page, 'Fixture crossing B');
  await expect.poll(() => fixtureOrder(page)).toEqual(['A', 'B']);

  const row = (title) => dockRows(page).filter({ hasText: title });
  await expect(row('Fixture crossing A')).toHaveAttribute('draggable', 'true');
  await expect(page.getByRole('button', { name: 'Move Fixture crossing A up' })).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(row('Fixture crossing A')).not.toHaveAttribute('draggable', 'true');
  const up = page.getByRole('button', { name: 'Move Fixture crossing B up' });
  await expect(up).toBeVisible();
  await expectNoPageOverflow(page);

  // A tap moves the row one slot — the adjacent swap through reorderAgents.
  await up.click();
  await expect.poll(() => fixtureOrder(page)).toEqual(['B', 'A']);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(row('Fixture crossing A')).toHaveAttribute('draggable', 'true');
  await expect(up).toHaveCount(0);
});

// --------------------------------------------------------------- editor tabs

// Same setup as config.spec.mjs's desktop tab-drag test: expand the workspace
// root, then open two files to get two tabs.
async function twoTabs(page) {
  await gotoView(page, 'Config');
  const root = page.getByRole('button', { name: '~/workspace', exact: false });
  const group = page.getByText('.claude', { exact: true });
  if (!(await group.isVisible().catch(() => false))) await root.click();
  await expect(group).toBeVisible();
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
}

// Each tab Stack carries `title=<full path>` and role="tab"; DOM order is the
// on-screen order.
const tabTitles = (page) => page.locator('[role="tab"]').evaluateAll((els) => els.map((el) => el.title));

test('live 899/900 crossing swaps a tab strip between whole-tab drag and Move left/right buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await twoTabs(page);
  await expect.poll(() => tabTitles(page)).toEqual([SETTINGS_PATH, LOCAL_PATH]);

  const firstTab = page.locator('[role="tab"]').first();
  await expect(firstTab).toHaveAttribute('draggable', 'true');
  await expect(page.getByRole('button', { name: 'Move settings.json left' })).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(firstTab).not.toHaveAttribute('draggable', 'true');
  const moveLocalLeft = page.getByRole('button', { name: 'Move settings.local.json left' });
  await expect(moveLocalLeft).toBeVisible();

  // A tap reorders through the same onReorder seam the drag uses; the active
  // tab is untouched.
  await moveLocalLeft.click();
  await expect.poll(() => tabTitles(page)).toEqual([LOCAL_PATH, SETTINGS_PATH]);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(page.locator('[role="tab"]').first()).toHaveAttribute('draggable', 'true');
  await expect(moveLocalLeft).toHaveCount(0);
});
