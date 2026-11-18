// History page (HistoryView). Sandbox corpus (fixtures/seed.mjs): history.jsonl
// is seeded with 7 days — 6 non-empty (sessions drawn from the fixture
// transcript corpus) and 1 gap (llm.reason:'empty') — so the sandbox daemon
// never backfills (ensureHistory fires on boot + GET /history; an unseeded
// file means live haiku calls per missing day). The fixture transcripts are
// backdated to 2025-06-01, well outside any 7-day window, so scanDays finds
// nothing to summarize even if ensureHistory runs.
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';

test('seeded days render in newest-first order', async ({ page }) => {
  await gotoView(page, 'history');
  // The title renders before the async fetch lands, so the card assertions
  // below are what actually wait for data.
  await expect(page.getByText('History', { exact: true }).first()).toBeVisible({ timeout: 15000 });

  // Articles are project cards, not day headers: the 6 non-empty seeded days
  // each contribute one. The gap day and today's zero-session live header
  // contribute no <article> nodes.
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(6, { timeout: 15000 });

  // The day's narrative is per-project bullets inside the cards, so the cards
  // carry the seeded text. Comparing their vertical positions proves
  // descending-date order, not just "row exists".
  const yOf = async (text) => (await cards.filter({ hasText: text }).first().boundingBox()).y;
  expect(await yOf('Shipped the history timeline')).toBeLessThan(await yOf('Built the e2e sandbox seed corpus'));
  // Second bullet of the same day's project renders too (up to 3 per project).
  await expect(cards.filter({ hasText: 'Shipped the history timeline' }).first()).toContainText('Fixed a concurrent backfill bug');

  // The gap day (2 days ago) renders as a compressed segment with the
  // "no work" aria-label — absence is information, not an error.
  await expect(page.locator('[aria-label*="no work"]')).toBeVisible();
  // No shimmer placeholders: every day is seeded, so `pending` is empty and
  // no ShimmerCard (aria-busy="true") should be present.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
