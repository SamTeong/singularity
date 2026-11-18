import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';

test('provider meter cards, outbound usage links, report iframe and Refresh', async ({ page }) => {
  await gotoUrl(page, 'Usage');

  // The meter titles ("5h: 42% · <reset stamp>") are unique to the full-size
  // ProviderCard — the rail's UsagePanel renders the same provider with bare
  // '5h'/'7d' labels, which the anchored regexes never match.
  await expect(page.getByText(/^5h: \d/).first()).toBeVisible();
  await expect(page.getByText(/^7d: \d/).first()).toBeVisible();
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible();

  // One jump-out per provider card, each to that provider's own usage page.
  for (const href of ['https://claude.ai/settings/usage', 'https://chatgpt.com/#settings/Usage', 'https://ollama.com/settings']) {
    const link = page.locator(`a[href="${href}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }

  // Both the user-visible iframe and the document served inside it.
  const report = page.getByTitle('Usage report');
  await expect.poll(async () => (await report.boundingBox())?.height || 0).toBeGreaterThan(0);
  await expect(report.contentFrame().getByRole('heading', { name: 'Mock usage report' })).toBeVisible();

  await recordFetchCalls(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  await expect.poll(() => fetchCalls(page)).toContain('GET /api/usage?force=1');
});

test('Ollama stale usage reconnects; window Anchor pokes and converges from the socket', async ({ page }) => {
  await gotoUrl(page, 'Usage');
  await recordFetchCalls(page);

  // Stale Ollama keeps its last read with an actionable reconnect.
  await expect(page.getByText(/Last successful usage from/)).toBeVisible();
  await expect(page.getByText(/Ollama sign-in expired. Connect/)).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Ollama connection verified.')).toBeVisible();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/usage/ollama/connect');
  await expect(page.getByText(/Last successful usage from/)).toHaveCount(0);
  // Fresh data after a successful connect hides the button entirely.
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);

  // Claude's 5h window already carries usage, so its reset is pinned and the
  // button is gone; Codex has never anchored, so it keeps the only Anchor
  // button. The poke response carries only its outcome; the broadcast frame's
  // fresh lastAnchorAt is what retires the button.
  await expect(page.getByRole('button', { name: 'Anchor' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Anchor' }).click();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/window-anchor/poke');
  await expect(page.getByRole('button', { name: 'Anchor' })).toHaveCount(0);
});
