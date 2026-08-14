// Provider status view. The mock returns Claude operational with two
// components and OpenAI degraded with one component and one open incident.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

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

test('Refresh triggers GET /status with force=1', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');
  await recordFetchCalls(page);

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => fetchCalls(page)).toContain('GET /status?force=1');
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
