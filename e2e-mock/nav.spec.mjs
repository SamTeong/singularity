import { test, expect } from './fixtures/test.mjs';
import { goto, gotoUrl, gotoView, visible } from '../e2e/helpers/nav.mjs';
import { PROJECT_B, RICH_SESSION } from '../web/src/mock/fixtures.js';

test('Tasks view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  // Verify a task card renders
  await expect(visible(page.getByText('Seeded todo card')).first()).toBeVisible();
});

test('Automation view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await expect(page).toHaveURL(/\/cron(\?|$)/);
  // Verify a heading renders
  await expect(visible(page.getByText('Scheduled')).first()).toBeVisible();
});

test('Usage view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await expect(page).toHaveURL(/\/usage(\?|$)/);
});

test('Config view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Config');
  await expect(page).toHaveURL(/\/config(\?|$)/);
  // The tree rail only renders a file leaf after a root is expanded, so assert
  // the view mounted via its stable landmark (the rail search box) rather than
  // a file name that may not be in the DOM yet.
  await expect(page.getByPlaceholder('Search config…')).toBeVisible();
});

test('Hooks view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Hooks');
  await expect(page).toHaveURL(/\/hooks(\?|$)/);
});

test('Skills view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Skills');
  await expect(page).toHaveURL(/\/skills(\?|$)/);
  // Verify the skills tree caption renders
  await expect(visible(page.getByText('2 scopes · 2 skills')).first()).toBeVisible();
});

test('Rules view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Rules');
  await expect(page).toHaveURL(/\/rules(\?|$)/);
});

test('Memory view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Memory');
  await expect(page).toHaveURL(/\/memory(\?|$)/);
});

test('Transcripts view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Transcripts');
  await expect(page).toHaveURL(/\/transcripts(\?|$)/);
  // Verify the seeded transcript renders
  await expect(visible(page.getByText('Retry backoff cap', { exact: true })).first()).toBeVisible();
});

test('Wiki view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Wiki');
  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();
});

test('Appearance view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  // Via the shared helper, whose landmark is the view's heading. An unscoped
  // getByText('Appearance') here matched the closing More-menu item instead and
  // resolved before the view had mounted at all.
  await goto(page, 'Appearance');
  await expect(page).toHaveURL(/\/appearance(\?|$)/);
});

test('Status view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');
  await expect(page).toHaveURL(/\/status(\?|$)/);
});

test('clicking an already-active rail item toggles the sidebar collapsed state', async ({ page }) => {
  await page.goto('/');

  const sidebar = page.locator('aside');

  // Initial state: sidebar expanded (width > 64px)
  let sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox.width).toBeGreaterThan(64);

  // Click Tasks again (it's already active) to collapse. The width change is a
  // CSS transition, not a state flip with its own locator to wait on — poll the
  // boundingBox itself (a real web-first wait on the thing under test) instead
  // of guessing how long the transition takes with a fixed sleep.
  await sidebar.getByText('Tasks', { exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeLessThanOrEqual(64);

  // Now expand by clicking the Tasks ListItemButton again. The button is still clickable,
  // we just find it by its role and position in the sidebar.
  // The first ListItemButton after the "New session" button is Tasks.
  const navButtons = sidebar.getByRole('button', { name: /tasks|automation|usage/i });
  const tasksNav = navButtons.first();
  await tasksNav.click();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeGreaterThan(64);
});

test('deep-link via gotoView lands on the correct view', async ({ page }) => {
  // Use gotoView to jump to Config
  await gotoView(page, 'Config');

  await expect(page).toHaveURL(/\/config(\?|$)/);
  await expect(page.getByPlaceholder('Search config…')).toBeVisible();
});

test('view survives a page reload because it is in the URL', async ({ page }) => {
  // Navigate to a non-default view
  await page.goto('/');
  await goto(page, 'Wiki');
  await expect(page).toHaveURL(/\/wiki(\?|$)/);

  // Reloading mock mode re-seeds data, but the Wiki fixture is part of the
  // baseline — and the view now comes back off the URL, not localStorage.
  await page.reload();

  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await expect(visible(page.getByText('handbook')).first()).toBeVisible();
});

// Assert the address bar, not just the rendered pane: rendering Tasks while
// leaving /nonsense in the URL is the exact bug the route guard exists to stop,
// and a render-only assertion passes straight through it.
test('an unknown view id redirects to Tasks', async ({ page }) => {
  await page.goto('/nonsense');
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect(visible(page.getByText('Seeded todo card')).first()).toBeVisible();
});

test('back and forward walk the views visited', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Wiki');
  await goto(page, 'Skills');

  await page.goBack();
  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await page.goForward();
  await expect(page).toHaveURL(/\/skills(\?|$)/);
});

test('a filtered Tasks URL restores its filters on a cold load', async ({ page }) => {
  // Straight page.goto, not gotoUrl: ?history=1 replaces the board columns with
  // the history table, so the Tasks landmark gotoUrl waits on isn't rendered.
  await page.goto('/tasks?tag=fixture&history=1');

  // ?history=1 selects the History segment, ?tag= activates the tag filter (the
  // "Clear all" chip only renders with at least one tag active).
  await expect(page.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page.getByText('Clear all', { exact: true })).first()).toBeVisible();
});

// Cold load, not a click: the click path opens a transcript long after
// GET /transcripts/root has settled, so it cannot reproduce the race a URL-derived
// project/session hits on first mount.
test('a transcript URL opens that transcript on a cold load', async ({ page }) => {
  await gotoUrl(page, 'Transcripts', { project: PROJECT_B, session: RICH_SESSION });

  await expect(visible(page.getByText('Backoff is capped at 30s', { exact: false })).first()).toBeVisible();
});
