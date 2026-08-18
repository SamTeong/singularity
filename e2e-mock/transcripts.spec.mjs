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
import { gotoView, gotoMenu, setSkin, visible } from '../e2e/helpers/nav.mjs';
import { RICH_SESSION, SESSION_COUNT_A } from '../web/src/mock/fixtures.js';

const TOTAL_SESSIONS = SESSION_COUNT_A + 2; // 30 alpha + the rich session + "Fixture session 901"

// SessionHistory doesn't list until GET /transcripts/root resolves, so there's
// no root race to wait out here — this just waits for the (async) fetch of
// the seeded list to land before a test starts asserting against it.
async function openTranscripts(page) {
  await gotoView(page, 'Transcripts');
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible({ timeout: 15000 });
}

test('the session list renders every seeded transcript, reverse-chronological', async ({ page }) => {
  await openTranscripts(page);

  // mtimes are backdated a minute apart (fixtures/seed.mjs backdate()): the
  // rich session is stamped latest, then "Fixture session 901", then alpha's
  // 29 down to 0. getByRole(...).all() returns matches in DOM/visual order,
  // so this proves descending-mtime order end to end, not just "row exists".
  const rows = await page.getByRole('button', { name: /^Fixture session \d+|Retry backoff cap/ }).all();
  expect(rows.length).toBe(TOTAL_SESSIONS);
  await expect(rows[0]).toHaveText(/Retry backoff cap/);
  await expect(rows[1]).toHaveText(/Fixture session 901\b/);
  await expect(rows[rows.length - 1]).toHaveText(/Fixture session 0\b/);
});

test('search narrows the list to cross-session matches; clearing restores it', async ({ page }) => {
  await openTranscripts(page);

  // "MAX_BACKOFF_MS" only appears in the rich transcript's tool_result body —
  // a single hit, so the count itself proves the search actually scoped down
  // rather than just re-listing everything.
  await page.getByPlaceholder('Search transcripts…').fill('MAX_BACKOFF_MS');
  await expect(visible(page.getByText('1 matches', { exact: true })).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /MAX_BACKOFF_MS/ })).toBeVisible();

  await page.getByPlaceholder('Search transcripts…').fill('');
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible();
});

test('"This transcript" is disabled with nothing selected, then scopes search to the open transcript', async ({ page }) => {
  await openTranscripts(page);

  const thisTx = page.getByRole('button', { name: 'This transcript', exact: true });
  await expect(thisTx).toBeDisabled();

  await page.getByRole('button', { name: /Retry backoff cap/ }).click();
  await expect(thisTx).toBeEnabled();
  await thisTx.click();

  // "backoff" hits all 5 messages in the rich transcript (user ask, thinking,
  // the Grep tool_use, its tool_result, and the final answer) — scope 'one'
  // filters the open transcript's own message list, not the left rail.
  await page.getByPlaceholder('Search transcripts…').fill('backoff');
  await expect(page.getByText('5 matches in this transcript', { exact: true })).toBeVisible();
  // Left rail is untouched by scope 'one' — still the plain session count, not "N matches".
  await expect(visible(page.getByText(/^\d+ transcripts$/)).first()).toBeVisible();

  // Flipping back to "All" re-runs the same query cross-session and the rail
  // caption switches to the "matches" form.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(visible(page.getByText('5 matches', { exact: true })).first()).toBeVisible();
});

test('the page-size Select offers 25/50/100 and the prev/next buttons paginate', async ({ page }) => {
  await openTranscripts(page);

  const sizeSelect = page.getByRole('combobox');
  await sizeSelect.click();
  for (const n of ['25', '50', '100']) await expect(page.getByRole('option', { name: n, exact: true })).toBeVisible();
  await page.getByRole('option', { name: '25', exact: true }).click();

  // 32 sessions / 25 per page = 2 pages. The prev/next IconButtons carry no
  // Tooltip/aria-label (icon-only, no accessible name at all — README rule 2
  // covers the testid-stripped case, this is the further degenerate case of
  // no name whatsoever), so they're reached structurally off the "n/n" label
  // they flank, the same xpath-sibling technique tasks.spec.mjs uses for the
  // unlabelled column header.
  const pageLabel = page.getByText(/^\d+\/\d+$/);
  await expect(pageLabel).toHaveText('1/2');
  const pageBox = pageLabel.locator('xpath=..');
  const prevBtn = pageBox.locator('xpath=preceding-sibling::button[1]');
  const nextBtn = pageBox.locator('xpath=following-sibling::button[1]');

  await expect(prevBtn).toBeDisabled();
  await expect(nextBtn).toBeEnabled();

  await nextBtn.click();
  await expect(pageLabel).toHaveText('2/2');
  await expect(nextBtn).toBeDisabled();

  await prevBtn.click();
  await expect(pageLabel).toHaveText('1/2');
  await expect(prevBtn).toBeDisabled();
});

test('opening the rich transcript renders the name-id header, the token/cost line, and every message kind', async ({ page }) => {
  await openTranscripts(page);
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

test('Resume opens the New-session dialog prefilled with the session id, then Cancel', async ({ page }) => {
  await openTranscripts(page);
  await page.getByRole('button', { name: /Retry backoff cap/ }).click();

  await page.getByRole('button', { name: 'Resume', exact: true }).click();

  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/session id/i)).toHaveValue(RICH_SESSION);
  // A prefilled (valid) session id flips the submit label to Resume.
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();

  // Never submit — mock coverage remains cancel-only for session creation.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Phosphor Console (openspec/changes/implement-phosphor-theme, task 8.4):
// transcript ANSI palette parity — TranscriptView.jsx resolves the same
// `getTerminalTheme(skinId, resolvedMode)` used by the live terminal. The
// mock's fixed corpus keeps the transcript list deterministic, so this block
// can use the same rich fixture as the rest of the file.
test.describe('Transcript view — Phosphor Console', () => {
  test("the read-only transcript mimics the live terminal's void/amber/mint/blue/rust ANSI palette", async ({ page }) => {
    await page.goto('/');
    await setSkin(page, 'Phosphor Console');
    await gotoMenu(page, 'Transcripts');
    await page.getByRole('button', { name: /Retry backoff cap/ }).click();

    // Role/kind label header colors — term-theme.js's ROLE_KEY lookup table
    // (PHOSPHOR_TERM_THEME hex values, converted to the browser's rgb() form).
    await expect(page.getByText('user', { exact: true })).toHaveCSS('color', 'rgb(80, 144, 208)'); // brightBlue
    await expect(page.getByText('thinking', { exact: true })).toHaveCSS('color', 'rgb(198, 122, 90)'); // brightBlack (dim rust)
    await expect(page.getByText('tool: Grep', { exact: true })).toHaveCSS('color', 'rgb(82, 242, 154)'); // green -> mint
    await expect(page.getByText('tool result', { exact: true })).toHaveCSS('color', 'rgb(244, 159, 9)'); // yellow -> amber

    // Message BODY text is always `pal.foreground` regardless of role/kind
    // (TranscriptView.jsx) — the console's primary amber, on the void background.
    const body = page.getByText('Trace the retry path and tell me where the backoff is capped.');
    await expect(body).toBeVisible();
    await expect(body).toHaveCSS('color', 'rgb(244, 159, 9)');

    // Container background is the console void — walk up from the message
    // until a non-transparent background is found (the Stack TranscriptView paints).
    const bg = await body.evaluate((el) => {
      let n = el;
      while (n && getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)') n = n.parentElement;
      return n ? getComputedStyle(n).backgroundColor : null;
    });
    expect(bg).toBe('rgb(10, 10, 10)');
  });
});
