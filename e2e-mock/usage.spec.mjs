import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

test('provider meter cards render from populated mock usage', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The meter titles ("5h: 42% · <reset stamp>") are unique to the full-size
  // ProviderCard — the rail's UsagePanel renders the same provider with bare
  // '5h'/'7d' labels, which the anchored regexes never match.
  await expect(page.getByText(/^5h: \d/).first()).toBeVisible();
  await expect(page.getByText(/^7d: \d/).first()).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
});

test('provider usage pages are linked out, never followed', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Wait for the provider cards to render before counting the links.
  await expect(page.getByText(/^5h: \d/).first()).toBeVisible();

  // One jump-out per provider card, each to that provider's own usage page.
  const expected = [
    'https://claude.ai/settings/usage',
    'https://chatgpt.com/#settings/Usage',
    'https://ollama.com/settings',
  ];
  for (const href of expected) {
    const link = page.locator(`a[href="${href}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }
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

  // Collapsed survives the reload, not just the render.
  await page.reload();
  await expect(reportCollapseButton).toHaveAttribute('aria-label', /Expand usage report/);
});

// The card's own last read is a tooltip on a header status dot, not a stamped
// line — same affordance the Automation page uses. Refresh cadence is now
// daemon-owned, so the dot is found by its accessible name (it also carries
// the window-anchor state, window-anchor.spec.mjs).
test('each provider card exposes its last read in a tooltip', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  const dot = page.getByRole('img', { name: /^Claude status — / });
  await expect(dot).toBeVisible();
  await dot.hover();
  await expect(page.getByRole('tooltip')).toContainText('5h/7d usage: ');
});

test('Ollama retains stale usage with an actionable reconnect', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  const ollama = page.getByText('Ollama', { exact: true }).first();
  await expect(ollama).toBeVisible();
  // Request-count model breakdowns no longer render on the card (report only).
  await expect(page.getByText(/: \d+ req$/)).toHaveCount(0);
  await expect(page.getByText(/Last successful usage from/)).toBeVisible();
  await expect(page.getByText(/Ollama sign-in expired. Connect/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
});

test('Ollama reconnect posts the production route and shows verified usage', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByText('Ollama connection verified.')).toBeVisible();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/usage/ollama/connect');
  await expect(page.getByText(/Last successful usage from/)).toHaveCount(0);
  // Fresh data after a successful connect hides the button entirely.
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
});
