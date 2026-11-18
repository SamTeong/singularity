// Provider status view. The mock returns Claude operational with two
// components and OpenAI degraded with one component and one open incident.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';

test('provider cards, components, incident, freshness, outbound links and Refresh', async ({ page }) => {
  await gotoUrl(page, 'Status');

  // The provider label also appears in the sidebar usage pill, hence .first().
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  await expect(page.getByText('OpenAI', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Partially Degraded Service')).toBeVisible();

  // Per-component grid: Claude's two components are both operational.
  await expect(page.getByText('Claude on the web')).toBeVisible();
  expect(await page.getByText(/operational/i).count()).toBeGreaterThanOrEqual(2);

  // Incident row: impact and status share one line: "<impact> · <status>".
  await expect(page.getByText('Elevated error rates')).toBeVisible();
  await expect(page.getByText(/minor\s*·\s*monitoring/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'details' })).toBeVisible();

  // Per-provider caption "Status page updated <n> min ago".
  await expect(page.getByText(/^Status page updated .+/).first()).toBeVisible();

  // One link per provider card, plus the incident's "details" link.
  const links = page.locator('a[target="_blank"]');
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }

  await recordFetchCalls(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => fetchCalls(page)).toContain('GET /api/status?force=1');
});
