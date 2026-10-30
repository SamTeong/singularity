import { test, expect } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

test('provider meter cards render from usage stub', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The full-size provider card renders the meter label inside <strong>
  // ("5h: 42% · …"); the sidebar rail's compact meters render a bare
  // "5h"/"7d" (Sidebar.jsx), so anchor on the <strong> label instead of a
  // bare text match, which is ambiguous in the rail.
  // VERIFY: wave15-e2e-1
  await expect(page.locator('strong', { hasText: /^5h$/ })).toBeVisible();
  await expect(page.locator('strong', { hasText: /^7d$/ })).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
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

  // The state outlives the page, not just the component: reload and it is still
  // collapsed. This is the only assertion a reload can distinguish from the
  // in-memory useState default.
  await page.reload();
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

test('usage report is always available and shows the empty state when none exists', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The report is always available; with no report in the sandbox the view
  // shows the empty state and an enabled Generate button. ('Usage report'
  // itself is not a usable locator — it matches the section subtitle and the
  // iframe title.)
  await expect(page.getByText(/no report yet/i)).toBeVisible();

  // The button reads "Generate" until a report exists. Never clicked — it
  // spawns real generation.
  const generateButton = page.getByRole('button', { name: 'Generate' });
  await expect(generateButton).toBeVisible();
  await expect(generateButton).toBeEnabled();
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

  // Collapsed survives the reload, not just the render.
  await page.reload();
  await expect(reportCollapseButton).toHaveAttribute('aria-label', /Expand usage report/);
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
