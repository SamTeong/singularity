// History page (HistoryView). The mock returns seven days: six populated days
// and one `llm.reason: 'empty'` gap, so no history regeneration is needed.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl, visible } from '../e2e/helpers/nav.mjs';

test('seeded days newest-first, expand a day, deep-link a session into Transcripts', async ({ page }) => {
  await gotoUrl(page, 'history');

  // 6 non-empty seeded days + today = 7 cards. The gap day renders as a
  // GapSegment, not an <article>, so it's excluded from this count.
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(7);

  // Comparing vertical positions proves descending-date order, not just "row exists".
  const yOf = async (text) => (await cards.filter({ hasText: text }).first().boundingBox()).y;
  expect(await yOf('Shipped the history timeline')).toBeLessThan(await yOf('Built the e2e sandbox seed corpus'));

  // The project card's header block is the toggle and expands the whole row.
  const card = cards.filter({ hasText: 'Shipped the history timeline' }).first();
  await card.getByRole('button').first().click();
  const sessions = page.getByRole('region', { name: /^Sessions/ });
  await expect(sessions.getByText('Fixture session 901')).toBeVisible();
  await sessions.getByText('Retry backoff cap').click();

  // View switched to Transcripts and the rich session auto-opened; assert on
  // its content, which proves the right session opened.
  await expect(page.getByPlaceholder('Search transcripts…')).toBeVisible();
  await expect(visible(page.getByText('Trace the retry path and tell me where the backoff is capped.')).first()).toBeVisible();
});
