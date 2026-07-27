// Provider status view. /status is intercepted by the stubNetwork fixture
// (STATUS_STUB in fixtures/test.mjs) — the real route fetches Atlassian
// Statuspage over the internet. The stub has Claude operational with two
// components, and OpenAI degraded with one component and one open incident.
import { test, expect } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

test('provider cards render with indicator and description', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  // The provider label also appears in the sidebar usage pill, hence .first().
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toBeVisible();

  await expect(page.getByText('OpenAI', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Partially Degraded Service')).toBeVisible();
});

test('per-component grid renders for each provider', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  await expect(page.getByText('Claude on the web')).toBeVisible();
  // Claude's two components are both operational.
  expect(await page.getByText(/operational/i).count()).toBeGreaterThanOrEqual(2);
});

test('incident row renders for a degraded provider', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  await expect(page.getByText('Elevated error rates')).toBeVisible();
  // impact and status share one line: "<impact> · <status>".
  await expect(page.getByText(/minor\s*·\s*monitoring/)).toBeVisible();
  // The incident's shortlink renders as a "details" link.
  await expect(page.getByRole('link', { name: 'details' })).toBeVisible();
});

test('Refresh re-fetches /status', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  const refetched = page.waitForResponse((r) => r.url().includes('/status') && r.ok());
  await page.getByRole('button', { name: 'Refresh' }).click();
  expect((await refetched).ok()).toBe(true);
});

test('the freshness caption renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  // "updated <n> min ago" / "updated just now", from the newest fetchedAt.
  await expect(page.getByText(/^updated .+/)).toBeVisible();
});

test('provider status pages are linked out, never followed', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  // Wait for the provider cards to render before counting — under load the
  // stubbed /status fetch + render lands after the assertion otherwise.
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  // One per provider card, plus the incident's "details" link.
  const links = page.locator('a[target="_blank"]');
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }
});
