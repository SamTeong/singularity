import { test, expect } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

test('dock header is a role=button with dynamic title based on minimize state', async ({ page }) => {
  await page.goto('/');

  // The dock header is a div with role="button" that contains "Sessions" text
  // It's the Stack at the top of SessionDock
  const dockHeader = page.locator('[role="button"]').filter({ has: page.getByText('Sessions') });

  // Initially expanded: title should be "Minimize"
  await expect(dockHeader).toHaveAttribute('title', 'Minimize');

  // Click the header to minimize
  await dockHeader.click();

  // After minimize, title should be "Restore"
  await expect(dockHeader).toHaveAttribute('title', 'Restore');

  // Click again to restore
  await dockHeader.click();

  await expect(dockHeader).toHaveAttribute('title', 'Minimize');
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

  const dockHeader = page.locator('[role="button"]').filter({ has: page.getByText('Sessions') });
  await expect(dockHeader).toBeVisible();
  await expect(dockHeader).toHaveAttribute('title', 'Minimize');

  // Walk a few views (rail + more-menu) and confirm the dock header — and its
  // expanded title — survives every switch, since it lives outside the routed
  // view area in AppShell and must never remount alongside it.
  for (const view of ['Automation', 'Usage', 'Wiki', 'Tasks']) {
    await goto(page, view);
    await expect(dockHeader).toBeVisible();
    await expect(dockHeader).toHaveAttribute('title', 'Minimize');
  }
});
