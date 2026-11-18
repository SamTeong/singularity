import { test, expect } from './fixtures/test.mjs';
import { gotoUrl, visible } from './helpers/nav.mjs';

// Drives the daemon's SPA fallback (server/index.mjs setNotFoundHandler): none
// of these paths is a registered route, so the shell has to be served —
// through sendShell, with its token/home injection, or every call the shell
// then makes would 401. Client-side routing is covered by e2e-mock/nav.
test('a deep link straight to a view URL loads that view', async ({ page }) => {
  await gotoUrl(page, 'Wiki');
  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();

  // A reload re-requests /wiki from the daemon, not from localStorage.
  await page.reload();
  await expect(page).toHaveURL(/\/wiki(\?|$)/);
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();

  // Assert the address bar, not just the rendered pane: rendering Tasks while
  // leaving /nonsense in the URL is the exact bug the route guard exists to stop.
  await page.goto('/nonsense');
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect(visible(page.getByText('Seeded todo card')).first()).toBeVisible();
});
