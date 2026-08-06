// History page (HistoryView). Sandbox corpus (fixtures/seed.mjs): history.jsonl
// is seeded with 7 days — 6 non-empty (sessions drawn from the fixture
// transcript corpus) and 1 gap (llm.reason:'empty') — so the sandbox daemon
// never backfills (ensureHistory fires on boot + GET /history; an unseeded
// file means live haiku calls per missing day). The fixture transcripts are
// backdated to 2025-06-01, well outside any 7-day window, so scanDays finds
// nothing to summarize even if ensureHistory runs.
import { test, expect } from './fixtures/test.mjs';
import { gotoView, visible } from './helpers/nav.mjs';

// 'history' has no VIEW_LANDMARK entry in nav.mjs — gotoView falls back to a
// short settle, then we wait on the page title directly. The title renders
// before the async fetch lands, so the card assertions below are what actually
// wait for data.
async function openHistory(page) {
  await gotoView(page, 'history');
  await expect(page.getByText('History', { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

test('seeded days render in newest-first order', async ({ page }) => {
  await openHistory(page);

  // 6 non-empty seeded days + today = 7 cards. The gap day (day-2) renders as
  // a GapSegment, not an <article>, so it's excluded from this count.
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(7, { timeout: 15000 });

  // Index 0 is today ("In progress"), index 1 is yesterday, index 2 is day-3
  // (the gap at day-2 is not an article). Asserting their relative positions
  // proves descending-date order, not just "row exists".
  await expect(cards.nth(1)).toContainText('Shipped the history timeline');
  await expect(cards.nth(2)).toContainText('Built the e2e sandbox seed corpus');
});

test('expand a day reveals its session list', async ({ page }) => {
  await openHistory(page);

  // Click the day-1 card's header — the summary text sits inside the clickable
  // MotionBox (role="button", onClick=onToggle).
  const card = page.getByRole('article').nth(1);
  await expect(card).toContainText('Shipped the history timeline');
  await card.getByText('Shipped the history timeline').click();

  // The session list region appears with both seeded sessions.
  const sessions = page.getByRole('region', { name: 'Sessions' });
  await expect(sessions).toBeVisible();
  await expect(sessions.getByText('Retry backoff cap')).toBeVisible();
  await expect(sessions.getByText('Fixture session 901')).toBeVisible();
});

test('deep-link from a session row into Transcripts', async ({ page }) => {
  await openHistory(page);

  // Expand day-1, then click the rich session's row.
  const card = page.getByRole('article').nth(1);
  await card.getByText('Shipped the history timeline').click();
  const sessions = page.getByRole('region', { name: 'Sessions' });
  await expect(sessions).toBeVisible();
  await sessions.getByText('Retry backoff cap').click();

  // View switched to Transcripts — the search box is the view landmark.
  await expect(page.getByPlaceholder('Search transcripts…')).toBeVisible();
  // The transcript auto-opened from the openSession prop (SessionHistory's
  // useEffect at line 142). The deep-link item carries no title (only
  // project/id/cwd/source), so the header shows the raw id, not "title - id".
  // Assert on the transcript content instead — it proves the right session
  // opened, not just that the view switched.
  await expect(visible(page.getByText('Trace the retry path and tell me where the backoff is capped.')).first()).toBeVisible({ timeout: 15000 });
});

test('a gap day renders absence, not a shimmer placeholder', async ({ page }) => {
  await openHistory(page);

  // The gap day (2 days ago) renders as a compressed segment with the
  // "no work" aria-label — absence is information, not an error.
  await expect(page.locator('[aria-label*="no work"]')).toBeVisible({ timeout: 15000 });

  // No shimmer placeholders: every day is seeded, so `pending` is empty and
  // no ShimmerCard (aria-busy="true") should be present.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});