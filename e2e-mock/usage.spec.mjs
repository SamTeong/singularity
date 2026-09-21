import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

test('provider meter cards render from populated mock usage', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The meter labels are unique to the full-size ProviderCard — the sidebar
  // The rail's UsagePanel renders the same provider with '5h'/'7d' labels instead, which is
  // why the provider name alone is ambiguous here.
  await expect(page.getByText('Session (5h)').first()).toBeVisible();
  await expect(page.getByText('Weekly (7d)').first()).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();
});

test('provider usage pages are linked out, never followed', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Wait for the provider cards to render before counting the links.
  await expect(page.getByText('Session (5h)').first()).toBeVisible();

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

// The per-card refresh interval. Each card polls only ITS source (the daemon
// enforces the allowlist), which is the whole point of the control: a fast
// Claude cadence must never launch the Ollama browser scrape alongside it.
test('card refresh interval polls its own source only, and Off stops it', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);
  // Only /api/usage is the app's own doing here — the rail and status views poll
  // their own endpoints on 5s/8s timers, which would drown a total-call count.
  const usageCalls = async (p) => (await fetchCalls(p)).filter((c) => c.startsWith('GET /api/usage'));

  // 15s is the shortest offered cadence, and the only one that keeps this test's
  // real wait to a sane length — it has to actually wait out one interval, since
  // a fake clock would freeze the mock socket the app boots on.
  await page.getByRole('combobox', { name: 'Claude refresh interval' }).click();
  await page.getByRole('option', { name: '15s', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('refresh-claude')).toBe('15s');

  await expect.poll(() => fetchCalls(page), { timeout: 20_000 })
    .toContain('GET /api/usage?source=claude&force=1');

  // Polling one card must not drag the other two along.
  expect((await fetchCalls(page)).filter((c) => /source=(ollama|codex)/.test(c))).toEqual([]);

  // Off tears the timer down. One more interval of silence is the proof, and it
  // is meaningful only because the poll above already showed the timer firing.
  await page.getByRole('combobox', { name: 'Claude refresh interval' }).click();
  await page.getByRole('option', { name: 'Off', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('refresh-claude')).toBe(null);
  const before = (await usageCalls(page)).length;
  await page.waitForTimeout(16_000);
  expect((await usageCalls(page)).length).toBe(before);
});

// The card's own last read is a tooltip on a header info icon, not a stamped
// line — same affordance the Automation page uses.
test('each provider card exposes its last read in a tooltip', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // The icon is the element right after each cadence control (MUI v5 icons carry
  // no data-testid, and the Tooltip adds no wrapper: SvgIcon forwards its ref).
  const icon = (name) => page.getByRole('combobox', { name }).locator('xpath=parent::*[1]/following-sibling::*[1]');
  await expect(icon('Claude refresh interval')).toBeVisible();
  await expect(icon('Codex refresh interval')).toBeVisible();
  await expect(icon('Ollama refresh interval')).toBeVisible();

  await icon('Claude refresh interval').hover();
  await expect(page.getByRole('tooltip')).toContainText('Updated on: ');
});

// The chosen cadence outlives the URL: a bare /usage (sidebar link, rail, deep
// link) reopens on what this browser last picked, because the timer is a browser
// fact. The URL still wins whenever it carries a value — see the case below.
test('a bare visit reopens on the cadence this browser last chose', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await page.getByRole('combobox', { name: 'Claude refresh interval' }).click();
  await page.getByRole('option', { name: '30s', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('refresh-claude')).toBe('30s');

  // Drop every query param, the way a sidebar link would.
  await page.goto('/usage');
  await expect(page.getByRole('button', { name: /collapse usage|expand usage/i }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('combobox', { name: 'Claude refresh interval' })).toHaveText('30s');
  // Off stays the other two cards' answer: the memory is per provider.
  await expect(page.getByRole('combobox', { name: 'Ollama refresh interval' })).toHaveText('Off');
});

test('an unreadable remembered cadence degrades to Off', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('sing:refresh-intervals', '{not json'));
  await page.goto('/usage');
  await expect(page.getByRole('button', { name: /collapse usage|expand usage/i }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('combobox', { name: 'Claude refresh interval' })).toHaveText('Off');
});

// The per-view state convention: an invalid value degrades to the default
// rather than breaking the view.
test('an unknown cadence in the URL degrades to Off', async ({ page }) => {
  await page.goto('/usage?refresh-claude=nonsense');
  await expect(page.getByRole('button', { name: /collapse usage|expand usage/i }).first()).toBeVisible({ timeout: 15000 });

  await expect(page.getByRole('combobox', { name: 'Claude refresh interval' })).toHaveText('Off');
  // ...and the card itself still renders its meters.
  await expect(page.getByText('Session (5h)').first()).toBeVisible();
});
