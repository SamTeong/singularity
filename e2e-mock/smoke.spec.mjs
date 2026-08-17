// Harness smoke test: proves the production-mode mock bundle loads, its
// WebSocket populates live state, and panels read the in-memory fixture corpus.
import { test, expect } from './fixtures/test.mjs';
import { goto, visible } from '../e2e/helpers/nav.mjs';

test('shell loads against the mock backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'Singularity' })).toBeVisible();
  await expect(page.locator('aside').getByText('Tasks', { exact: true })).toBeVisible();
});

test('task board renders the seeded cards over the mock websocket', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');
  // Cards expose the task title as their accessible name.
  await expect(page.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card' })).toBeVisible();
});

test('panels read the mock seeded corpora', async ({ page }) => {
  await page.goto('/');

  await goto(page, 'Wiki');
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();

  await goto(page, 'Skills');
  // Tree starts collapsed — the root row + its caption proves the mock root
  // resolved to the seeded corpus. Expansion is covered by the skills spec.
  await expect(visible(page.getByText('2 scopes · 2 skills')).first()).toBeVisible();

  await goto(page, 'Transcripts');
  await expect(visible(page.getByText('Retry backoff cap', { exact: true })).first()).toBeVisible();
});
