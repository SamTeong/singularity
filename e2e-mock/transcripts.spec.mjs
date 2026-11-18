// Transcripts view (SessionHistory + TranscriptView). Sandbox corpus
// (fixtures/seed.mjs): workspace-alpha has 30 backdated sessions ("Fixture
// session 0".."Fixture session 29"), workspace-beta has one plain session
// ("Fixture session 901") and the rich multi-tool transcript RICH_SESSION,
// titled "Retry backoff cap" — thinking, a Grep tool_use, and its tool_result
// all mention "backoff", which this file leans on for search assertions.
//
// Deliberately NOT exercised: the Chat tab's Send button and submitting the
// Resume dialog. Resume is opened and only ever Cancelled.
import { test, expect } from './fixtures/test.mjs';
import { gotoView, visible } from '../e2e/helpers/nav.mjs';
import { PROJECT_B, RICH_SESSION, SESSION_COUNT_A } from '../web/src/mock/fixtures.js';

const TOTAL_SESSIONS = SESSION_COUNT_A + 2; // 30 alpha + the rich session + "Fixture session 901"

// SessionHistory doesn't list until GET /transcripts/root resolves; this waits
// for the (async) fetch of the seeded list to land.
async function openTranscripts(page) {
  await gotoView(page, 'Transcripts');
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible();
}

test('search narrows cross-session, keeps the query on open, and scopes to "This transcript"', async ({ page }) => {
  await openTranscripts(page);
  const search = page.getByPlaceholder('Search transcripts…');
  const thisTx = page.getByRole('button', { name: 'This transcript', exact: true });
  await expect(thisTx).toBeDisabled();

  // "MAX_BACKOFF_MS" only appears in the rich transcript's tool_result body —
  // a single hit, so the count proves the search actually scoped down.
  await search.fill('MAX_BACKOFF_MS');
  await expect(visible(page.getByText('1 matches', { exact: true })).first()).toBeVisible();
  await page.getByRole('button', { name: /MAX_BACKOFF_MS/ }).click();
  // Search-result rows carry no title/blurb (mock shape), so the header falls
  // back to the bare session id — still proof the rich transcript opened.
  await expect(visible(page.getByText(RICH_SESSION, { exact: true })).first()).toBeVisible();
  await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();
  await expect(search).toHaveValue('MAX_BACKOFF_MS');
  await expect(visible(page.getByText('1 matches', { exact: true })).first()).toBeVisible();

  // "backoff" hits all 5 messages in the rich transcript — scope 'one' filters
  // the open transcript's own message list, not the left rail.
  await expect(thisTx).toBeEnabled();
  await thisTx.click();
  await search.fill('backoff');
  await expect(page.getByText('5 matches in this transcript', { exact: true })).toBeVisible();
  await expect(visible(page.getByText(/^\d+ transcripts$/)).first()).toBeVisible();

  // Back to "All": the same query runs cross-session.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(visible(page.getByText('5 matches', { exact: true })).first()).toBeVisible();

  await search.fill('');
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible();
});

test('list order, rich transcript render, URL write + cold reload, and Resume prefill', async ({ page }) => {
  await openTranscripts(page);

  // mtimes are backdated a minute apart: the rich session is latest, then
  // "Fixture session 901", then alpha's 29 down to 0 (DOM order = visual order).
  const rows = await page.getByRole('button', { name: /^Fixture session \d+|Retry backoff cap/ }).all();
  expect(rows.length).toBe(TOTAL_SESSIONS);
  await expect(rows[0]).toHaveText(/Retry backoff cap/);
  await expect(rows[1]).toHaveText(/Fixture session 901\b/);
  await expect(rows[rows.length - 1]).toHaveText(/Fixture session 0\b/);

  await page.getByRole('button', { name: /Retry backoff cap/ }).click();

  // "<name> - <id>" header, built from the row's ai-title, not the raw id.
  await expect(visible(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).first()).toBeVisible();
  // Token/cost line: no usage blocks on the fixture, so every bucket reads 0.
  await expect(page.getByText('0 sent · 0 received · 0 reused from cache · 0 saved to cache')).toBeVisible();
  // One message of each TranscriptView kind: user text, assistant text,
  // thinking, tool_use, tool_result.
  await expect(page.getByText('Trace the retry path and tell me where the backoff is capped.')).toBeVisible();
  await expect(page.getByText('Look for the backoff constant first.')).toBeVisible();
  await expect(page.getByText('tool: Grep')).toBeVisible();
  await expect(page.getByText('tool result')).toBeVisible();
  await expect(page.getByText(/MAX_BACKOFF_MS/)).toBeVisible();
  await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();

  // The click WRITES the URL; a reload is a cold load that READS it back
  // (the URL-derived project/session must survive the first-mount root race).
  await expect(page).toHaveURL(new RegExp(`project=${PROJECT_B}&.*session=${RICH_SESSION}`));
  await page.reload();
  await expect(visible(page.getByText('Backoff is capped at 30s', { exact: false })).first()).toBeVisible();

  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog.getByLabel(/session id/i)).toHaveValue(RICH_SESSION);
  // A prefilled (valid) session id flips the submit label to Resume.
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  // Never submit — mock coverage remains cancel-only for session creation.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a successful empty poll clears the prior transcript list error', async ({ page }) => {
  await page.addInitScript(() => {
    window.__recoverTranscriptList = false;
    const wrap = (originalFetch) => (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, location.origin);
      if (url.pathname === '/api/transcripts') {
        if (!window.__recoverTranscriptList) return Promise.resolve(new Response('', { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { headers: { 'content-type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });
  await gotoView(page, 'Transcripts');
  await expect(visible(page.getByText('Failed to load transcripts.', { exact: true })).first()).toBeVisible();

  await page.evaluate(() => { window.__recoverTranscriptList = true; });
  // Changing this filter restarts the list effect and triggers its recovery poll.
  await page.getByRole('checkbox', { name: 'Hide automated reviews' }).click();
  await expect(visible(page.getByText('No transcripts.', { exact: true })).first()).toBeVisible();
  await expect(page.getByText('Failed to load transcripts.', { exact: true })).not.toBeVisible();
});
