import { test, expect } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

test('provider meter cards render from usage stub', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The meter labels are unique to the full-size ProviderCard — the sidebar
  // UsagePill renders the same provider with '5h'/'7d' labels instead, which is
  // why the provider name alone is ambiguous here.
  await expect(page.getByText('Session (5h)')).toBeVisible();
  await expect(page.getByText('Weekly (7d)')).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
});

test('ollama auth error alert renders', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Ollama also appears in the sidebar pill, hence .first().
  await expect(page.getByText('Ollama', { exact: true }).first()).toBeVisible();

  // needsAuth renders the provider's auth-help text in an Alert.
  const alert = page.getByRole('alert').first();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/sign.?in/i);
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

test('refresh button triggers GET /usage with force=1', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/usage?force=1') && response.status() === 200
  );

  await page.getByRole('button', { name: 'Refresh' }).click();

  const response = await responsePromise;
  expect(response.ok()).toBe(true);
});

test('usage report shows unavailable state when skill not configured', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // SING_USAGE_SKILL is unset in the sandbox, so the report degrades to its
  // not-configured empty state. ('Usage report' itself is not a usable locator —
  // it matches the section subtitle, the iframe title and this empty state.)
  await expect(page.getByText(/usage report not set up yet/i)).toBeVisible();

  // The button reads "Generate" until a report exists, and is disabled while the
  // skill is unavailable. Never clicked — it spawns the report skill for real.
  const generateButton = page.getByRole('button', { name: 'Generate' });
  await expect(generateButton).toBeVisible();
  await expect(generateButton).toBeDisabled();
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
