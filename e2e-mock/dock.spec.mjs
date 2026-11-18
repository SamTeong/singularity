import { test, expect } from './fixtures/test.mjs';

test('dock empty state; minimize and session-list header both collapse, Restore round-trips', async ({ page }) => {
  await page.goto('/');

  // The mock seeds no agents, so the dock shows its empty state.
  await expect(page.getByText('No agent selected', { exact: true })).toBeVisible();
  await expect(page.getByText('Create an agent to begin.')).toBeVisible();

  // Two controls collapse the expanded dock: the term-bar minimize button and
  // the `.dock-list-head` row (its own accessible name). Collapsed, the whole
  // dock shrinks to one clickable strip, unmounted while expanded.
  const minimize = page.getByRole('button', { name: 'Minimize dock' });
  const header = page.getByRole('button', { name: 'Collapse sessions dock' })
    .filter({ has: page.getByRole('heading', { name: 'Sessions' }) });
  const restore = page.locator('[role="button"][title="Restore"]');
  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);

  await minimize.click();
  await expect(restore).toBeVisible();
  await expect(restore).toContainText('Sessions');
  // Body stays mounted (display:none) so terminals keep scrollback.
  await expect(minimize).toBeHidden();
  await restore.click();
  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);

  await header.click();
  await expect(restore).toBeVisible();
  await expect(header).toBeHidden();
  await restore.click();
  await expect(header).toBeVisible();
  await expect(restore).toHaveCount(0);
});
