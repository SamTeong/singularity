import { test, expect } from './fixtures/test.mjs';
import { goto, gotoView, visible, RAIL_VIEWS, MENU_VIEWS, VIEW_IDS } from '../e2e/helpers/nav.mjs';

test('every rail and More-menu view is reachable by click; active rail item toggles collapse', async ({ page }) => {
  test.slow();
  // Start off-rail: clicking the already-active Tasks item would collapse the sidebar.
  await page.goto('/config');

  // goto() waits on each view's own landmark, so each step proves the mount.
  for (const label of [...RAIL_VIEWS, ...MENU_VIEWS]) {
    await test.step(label, async () => {
      await goto(page, label);
      await expect(page).toHaveURL(new RegExp(`/${VIEW_IDS[label]}(\\?|$)`));
    });
  }

  // Clicking the already-active rail item collapses the sidebar; clicking it
  // again expands it. The width change is a CSS transition, so poll the box.
  await goto(page, 'Tasks');
  const sidebar = page.locator('aside');
  expect((await sidebar.boundingBox()).width).toBeGreaterThan(64);
  await sidebar.getByText('Tasks', { exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeLessThanOrEqual(64);
  await sidebar.getByRole('button', { name: /tasks|automation|usage/i }).first().click();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeGreaterThan(64);
});

test('URL routing: bare-root redirect, reload, back/forward, unknown id, filtered cold load', async ({ page }) => {
  // '/' redirects to the remembered `sing-view`.
  await gotoView(page, 'Config');
  await expect(page).toHaveURL(/\/config(\?|$)/);

  await goto(page, 'Wiki');
  await goto(page, 'Skills');
  await page.goBack();
  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await page.goForward();
  await expect(page).toHaveURL(/\/skills(\?|$)/);

  // The view comes back off the URL, not localStorage.
  await page.reload();
  await expect(page).toHaveURL(/\/skills(\?|$)/);
  await expect(page.getByPlaceholder('Search skills…')).toBeVisible();

  // Assert the address bar, not just the rendered pane: rendering Tasks while
  // leaving /nonsense in the URL is the exact bug the route guard exists to stop.
  await page.goto('/nonsense');
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect(visible(page.getByText('Seeded todo card')).first()).toBeVisible();

  // ?history=1 selects the History segment, ?tag= activates the tag filter (the
  // "Clear all" chip only renders with at least one tag active).
  await page.goto('/tasks?tag=fixture&history=1');
  await expect(page.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page.getByText('Clear all', { exact: true })).first()).toBeVisible();
});
