import { test, expect } from './fixtures/test.mjs';
import { goto, gotoView, visible } from './helpers/nav.mjs';

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
  await expect(visible(page.getByText('settings.json')).first()).toBeVisible();
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
  await goto(page, 'Appearance');
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
  await expect(visible(page.getByText('settings.json')).first()).toBeVisible();
});

test('view persists across page reload via localStorage', async ({ page }) => {
  // Navigate to a non-default view
  await page.goto('/');
  await goto(page, 'Wiki');

  let storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('wiki');

  // Reload the page
  await page.reload();

  // Should still be on Wiki. No fixed sleep needed: localStorage is readable as
  // soon as reload() resolves, and the handbook assertion below is web-first —
  // it already retries until the Wiki panel (re-)mounts.
  storedView = await page.evaluate(() => window.localStorage.getItem('sing-view'));
  expect(storedView).toBe('wiki');
  await expect(visible(page.getByText('handbook')).first()).toBeVisible();
});
