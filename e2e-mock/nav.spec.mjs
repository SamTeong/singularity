import { test, expect } from './fixtures/test.mjs';
import { goto, gotoView, openMenu, visible } from '../e2e/helpers/nav.mjs';

test('Tasks view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('tasks');
  // Verify a task card renders
  await expect(visible(page.getByText('Seeded todo card')).first()).toBeVisible();
});

test('Automation view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('cron');
  // Verify a heading renders
  await expect(visible(page.getByText('Scheduled')).first()).toBeVisible();
});

test('Usage view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('usage');
});

test('Config view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Config');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('config');
  // The tree rail only renders a file leaf after a root is expanded, so assert
  // the view mounted via its stable landmark (the rail search box) rather than
  // a file name that may not be in the DOM yet.
  await expect(page.getByPlaceholder('Search config…')).toBeVisible();
});

test('Hooks view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Hooks');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('hooks');
});

test('Skills view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Skills');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('skills');
  // Verify the skills tree caption renders
  await expect(visible(page.getByText('2 scopes · 2 skills')).first()).toBeVisible();
});

test('Rules view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Rules');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('rules');
});

test('Memory view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Memory');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('memory');
});

test('Transcripts view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Transcripts');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('sessions');
  // Verify the seeded transcript renders
  await expect(visible(page.getByText('Retry backoff cap', { exact: true })).first()).toBeVisible();
});

test('Wiki view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Wiki');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('wiki');
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();
});

test('Appearance view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  // Appearance currently renders its title as a paragraph, while the shared
  // helper's landmark expects a heading. Keep using the shared menu helper and
  // wait on the actual visible title rather than changing the daemon helper.
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('appearance');
});

test('Status view is reachable and renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');
  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('status');
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

  const storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('config');
  await expect(page.getByPlaceholder('Search config…')).toBeVisible();
});

test('view persists across page reload via localStorage', async ({ page }) => {
  // Navigate to a non-default view
  await page.goto('/');
  await goto(page, 'Wiki');

  let storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('wiki');

  // Reloading mock mode re-seeds data, but localStorage remains intact and the
  // Wiki fixture is part of the baseline.
  await page.reload();

  storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('wiki');
  await expect(visible(page.getByText('handbook')).first()).toBeVisible();
});
