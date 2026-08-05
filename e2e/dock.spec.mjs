import { test, expect } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

test('dock minimize round-trips between the term-bar button and the collapsed strip', async ({ page }) => {
  await page.goto('/');

  // Two different controls, one per state. Expanded, the only toggle is the
  // `.term-tools` icon-btn on the right of the term-bar; the "Sessions" label
  // beside it is `.dock-list-head` — plain text, deliberately not clickable.
  const minimize = page.getByRole('button', { name: 'Minimize dock' });
  // Collapsed, the whole dock shrinks to one clickable strip (unmounted while
  // expanded, so its absence is the assertion that the dock is open).
  const restore = page.locator('[role="button"][title="Restore"]');

  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);

  await minimize.click();

  await expect(restore).toBeVisible();
  await expect(restore).toContainText('Sessions');
  // Body stays mounted (display:none) so terminals keep scrollback — the
  // minimize button is still in the DOM, just not reachable.
  await expect(minimize).toBeHidden();

  await restore.click();

  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);
});

test('dock empty state shows "No agent selected" when no session is active', async ({ page }) => {
  await page.goto('/');

  // With no agents in the sandbox, the dock should show empty state.
  // The empty state is inside the dock (full width when expanded).
  // Check for the specific text in the empty state
  const emptyStateDesc = page.getByText('Create an agent to begin.');

  await expect(emptyStateDesc).toBeVisible({ timeout: 10000 });
});

test('dock header survives across view switches', async ({ page }) => {
  await page.goto('/');

  const listHead = page.getByRole('heading', { name: 'Sessions' });
  const minimize = page.getByRole('button', { name: 'Minimize dock' });
  await expect(listHead).toBeVisible();
  await expect(minimize).toBeVisible();

  // Walk a few views (rail + more-menu) and confirm the dock header — and its
  // expanded state — survives every switch, since it lives outside the routed
  // view area in AppShell and must never remount alongside it.
  for (const view of ['Automation', 'Usage', 'Wiki', 'Tasks']) {
    await goto(page, view);
    await expect(listHead).toBeVisible();
    await expect(minimize).toBeVisible();
  }
});
