// Harness smoke test: proves the sandbox rig itself works — the shell loads
// against the isolated daemon, the token round-trips, the WS connects (the task
// board is WS-fed, never fetched), and the seeded corpora are what the panels
// read. Every other spec assumes these hold.
import { test, expect } from './fixtures/test.mjs';
import { goto, visible } from './helpers/nav.mjs';
import { BASE_URL } from './fixtures/paths.mjs';

test('task board renders the seeded cards over the websocket', async ({ page }) => {
  await page.goto('/');
  // The daemon served the built shell and accepted the seeded token cookie.
  await expect(page.getByRole('img', { name: 'Singularity' })).toBeVisible();
  await goto(page, 'Tasks');
  // Cards expose the task title as their accessible name.
  await expect(page.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card' })).toBeVisible();
});

test('panels read the seeded corpora, not the real dotfiles', async ({ page }) => {
  await page.goto('/');

  await goto(page, 'Wiki');
  await expect(visible(page.getByText('handbook', { exact: true })).first()).toBeVisible();

  await goto(page, 'Skills');
  // Tree starts collapsed — the root row + its caption is what proves the root
  // resolved to the corpus.
  await expect(visible(page.getByText('2 scopes · 2 skills')).first()).toBeVisible();

  await goto(page, 'Transcripts');
  await expect(visible(page.getByText('Retry backoff cap', { exact: true })).first()).toBeVisible();
});

// SING_TOKEN gating: without the sing_token cookie the daemon refuses both the
// API and the shell (the shell would otherwise hand out window.__SING_TOKEN__).
test('without the token cookie the daemon refuses /api and the shell', async ({ playwright }) => {
  // Explicit empty storageState: Playwright Test applies the config's `use`
  // (including the seeded sing_token cookie) to request contexts too.
  const anon = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    expect((await anon.get('/api/tasks')).status()).toBe(401);
    expect((await anon.get('/')).status()).toBe(401);
  } finally {
    await anon.dispose();
  }
});
