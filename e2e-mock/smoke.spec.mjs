// Harness smoke test: proves the production-mode mock bundle loads and its
// WebSocket populates the task board with the seeded cards.
import { test, expect } from './fixtures/test.mjs';

test('shell loads and the task board renders the seeded cards over the mock websocket', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'Singularity' })).toBeVisible();
  await expect(page.locator('aside').getByText('Tasks', { exact: true })).toBeVisible();

  for (const col of ['To-Do (1)', 'In Progress (1)', 'In Review (1)', 'Done (1)']) {
    await expect(page.getByText(col, { exact: true })).toBeVisible();
  }
  // Cards expose the task title as their accessible name.
  await expect(page.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card' })).toBeVisible();
});
