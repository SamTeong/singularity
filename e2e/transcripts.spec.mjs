// Transcripts view (SessionHistory + TranscriptView) against the daemon's real
// JSONL listing and parse. Sandbox corpus (fixtures/seed.mjs): workspace-alpha
// has 30 backdated sessions ("Fixture session 0".."Fixture session 29"),
// workspace-beta has one plain session ("Fixture session 901") and the rich
// multi-tool transcript RICH_SESSION, titled "Retry backoff cap". Search,
// paging, Resume and the Phosphor palette are covered by e2e-mock/transcripts.
//
// Deliberately NOT exercised: the Chat tab's Send button (real model call, see
// e2e/README.md) and the Resume dialog (real claude spawn + writes the user's
// real ~/.claude.json).
import { test, expect } from './fixtures/test.mjs';
import { gotoView, visible } from './helpers/nav.mjs';
import { RICH_SESSION, SESSION_COUNT_A } from './fixtures/paths.mjs';

const TOTAL_SESSIONS = SESSION_COUNT_A + 2; // 30 alpha + the rich session + "Fixture session 901"

test('opening the rich transcript renders the name-id header, the token/cost line, and every message kind', async ({ page }) => {
  await gotoView(page, 'Transcripts');
  // SessionHistory doesn't list until GET /transcripts/root resolves; wait for
  // the (async) fetch of the seeded list to land.
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible({ timeout: 15000 });

  // mtimes are backdated a minute apart (fixtures/seed.mjs backdate()): the
  // rich session is stamped latest, then "Fixture session 901", then alpha's
  // 29 down to 0. getByRole(...).all() returns matches in DOM/visual order,
  // so this proves descending-mtime order end to end, not just "row exists".
  const rows = await page.getByRole('button', { name: /^Fixture session \d+|Retry backoff cap/ }).all();
  expect(rows.length).toBe(TOTAL_SESSIONS);
  await expect(rows[0]).toHaveText(/Retry backoff cap/);
  await expect(rows[1]).toHaveText(/Fixture session 901\b/);
  await expect(rows[rows.length - 1]).toHaveText(/Fixture session 0\b/);

  await page.getByRole('button', { name: /Retry backoff cap/ }).click();

  // "<name> - <id>" header, built from the row's ai-title, not the raw id.
  await expect(visible(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).first()).toBeVisible();

  // Token/cost line: no usage blocks on the fixture's assistant events, so
  // every bucket reads 0 and no cost suffix is appended — still a concrete,
  // falsifiable render (a broken stats fetch would leave this text missing).
  await expect(page.getByText('0 sent · 0 received · 0 reused from cache · 0 saved to cache')).toBeVisible();

  // One message of each TranscriptView kind: user text, assistant text,
  // thinking, tool_use, tool_result.
  await expect(page.getByText('Trace the retry path and tell me where the backoff is capped.')).toBeVisible();
  await expect(page.getByText('Look for the backoff constant first.')).toBeVisible();
  await expect(page.getByText('tool: Grep')).toBeVisible();
  await expect(page.getByText('tool result')).toBeVisible();
  await expect(page.getByText(/MAX_BACKOFF_MS/)).toBeVisible();
  await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();
});
