import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

test('provider meter cards render from populated mock usage', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The meter labels are unique to the full-size ProviderCard — the sidebar
  // UsagePill renders the same provider with '5h'/'7d' labels instead, which is
  // why the provider name alone is ambiguous here.
  await expect(page.getByText('Session (5h)').first()).toBeVisible();
  await expect(page.getByText('Weekly (7d)').first()).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
});

test('Ollama renders populated usage meters', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  const ollama = page.getByText('Ollama', { exact: true }).first();
  await expect(ollama).toBeVisible();
  await expect(page.getByText('deepseek-v4-flash:cloud: 34 req')).toBeVisible();
  await expect(page.getByText('deepseek-v4-flash:cloud: 210 req')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('collapse/expand toggle flips aria-label', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  const collapseButton = page.getByRole('button', { name: /collapse usage|expand usage/i }).first();

  // Initially should say "Collapse usage"
  await expect(collapseButton).toHaveAttribute('aria-label', 'Collapse usage');

  // Click to collapse
  await collapseButton.click();

  // Should now say "Expand usage"
  await expect(collapseButton).toHaveAttribute('aria-label', 'Expand usage');

  // Click to expand again
  await collapseButton.click();

  // Should be back to "Collapse usage"
  await expect(collapseButton).toHaveAttribute('aria-label', 'Collapse usage');
});

test('usage Refresh triggers GET /usage with force=1', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true }).first();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => fetchCalls(page)).toContain('GET /api/usage?force=1');
});

test('usage report loads the mock report document', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Verify both the user-visible iframe and the document served inside it.
  const report = page.getByTitle('Usage report');
  await expect(report).toBeVisible();
  await expect.poll(async () => (await report.boundingBox())?.height || 0).toBeGreaterThan(0);
  const frame = report.contentFrame();
  await expect(frame.getByRole('heading', { name: 'Mock usage report' })).toBeVisible();
});

test('usage report collapse/expand button exists', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Find the usage report collapse button (separate from usage section button)
  const reportCollapseButton = page
    .locator('button[aria-label*="usage report"]')
    .first();

  await expect(reportCollapseButton).toBeVisible();

  // Should initially be in expanded state
  await expect(reportCollapseButton).toHaveAttribute('aria-label', /Collapse usage report/);

  // Click to collapse
  await reportCollapseButton.click();

  // Should now say "Expand usage report"
  await expect(reportCollapseButton).toHaveAttribute('aria-label', /Expand usage report/);
});
