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
  await expect.poll(() => fetchCalls(page)).toContain('GET /api/status?force=1');
});

test('the freshness caption renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Status');

  // Per-provider caption "Status page updated <n> min ago" — one per card, so .first().
  await expect(page.getByText(/^Status page updated .+/).first()).toBeVisible();
});

test('a failed initial load shows a retry message and recovers on the next pull', async ({ page }) => {
  // The mock answers /status through Mirage inside the page, so a failing
  // request is injected at the fetch layer (same pattern as transcripts.spec).
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

  await page.goto('/');
  await goto(page, 'Status');

  await expect(page.getByText(/^Couldn't load provider status/)).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toHaveCount(0);

  await page.evaluate(() => window.__recoverStatus());
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  await expect(page.getByText(/^Couldn't load provider status/)).toHaveCount(0);
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
