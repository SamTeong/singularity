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

test('a failed initial load shows a retry message and recovers on the next pull', async ({ page }) => {
  // The mock answers /status through Mirage inside the page, so a failing
  // request is injected at the fetch layer.
  await page.addInitScript(() => {
    let failing = true;
    window.__recoverStatus = () => { failing = false; };
    const wrap = (originalFetch) => (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, location.origin);
      if (url.pathname === '/api/status' && failing) return Promise.resolve(new Response('', { status: 503 }));
      return originalFetch(input, init);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });

  await gotoUrl(page, 'Status');
  await expect(page.getByText(/^Couldn't load provider status/)).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toHaveCount(0);

  await page.evaluate(() => window.__recoverStatus());
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  await expect(page.getByText(/^Couldn't load provider status/)).toHaveCount(0);
});
