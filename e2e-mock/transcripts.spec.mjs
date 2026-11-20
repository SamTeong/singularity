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
import { PROJECT_A, PROJECT_B, RICH_SESSION, ROOTS, SESSION_COUNT_A, sessionId } from '../web/src/mock/fixtures.js';

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

// VERIFY: transcripts-root-switch-reset
test('a root switch drops old-root rows and shows loading until the new root lands', async ({ page }) => {
  // Hold every list request for a root other than the seeded corpus root.
  await page.addInitScript((corpusRoot) => {
    window.__releaseTranscriptList = null;
    const wrap = (originalFetch) => (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, location.origin);
      if (url.pathname === '/api/transcripts' && url.searchParams.get('root') !== corpusRoot) {
        return new Promise((resolve) => {
          window.__releaseTranscriptList = () => resolve(new Response(JSON.stringify({ sessions: [] }), { headers: { 'content-type': 'application/json' } }));
        });
      }
      return originalFetch(input, init);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  }, ROOTS.projects);

  await openTranscripts(page);
  const oldRow = page.getByRole('button', { name: /Fixture session 0\b/ });
  await expect(oldRow).toBeVisible();

  await page.getByRole('button', { name: 'Browse' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: PROJECT_A }).click();
  // The picker's path only moves after /fs/browse lands; Select would otherwise
  // re-pick the corpus root.
  await expect(dialog.getByRole('textbox')).toHaveValue(`~/projects/${PROJECT_A}`);
  await dialog.getByRole('button', { name: 'Select' }).click();

  // New-root list still held: old rows must be gone, cold-scan loading visible.
  await expect(oldRow).toHaveCount(0);
  await expect(visible(page.getByText('Loading transcripts…', { exact: true })).first()).toBeVisible();
  await expect(page.getByText('No transcripts.', { exact: true })).not.toBeVisible();

  await page.waitForFunction(() => typeof window.__releaseTranscriptList === 'function');
  await page.evaluate(() => window.__releaseTranscriptList());
  await expect(visible(page.getByText('No transcripts.', { exact: true })).first()).toBeVisible();
  await expect(oldRow).toHaveCount(0);
});

// Selecting the root already loaded is a no-op, not a root switch: the [root]
// effect would not re-run, so clearing the corpus would strand the list on
// "Loading transcripts…" until the next poll and drop the open transcript.
// VERIFY: transcripts-root-same-noop
test('re-selecting the current root keeps the loaded corpus and open transcript', async ({ page }) => {
  await openTranscripts(page);
  await page.getByRole('button', { name: /Retry backoff cap/ }).click();
  await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();

  await page.getByRole('button', { name: 'Browse' }).click();
  const dialog = page.getByRole('dialog');
  // The picker opens at the persisted root, so Select re-picks that same path.
  await expect(dialog.getByRole('textbox')).toHaveValue('~/projects');
  await dialog.getByRole('button', { name: 'Select' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The buggy pick clears the corpus and flags loading, yet the unchanged root
  // never re-runs the list effect, so it sits on "Loading…" until the next 15s
  // poll. Assert immediately (short timeout) that neither symptom appeared.
  await expect(page.getByText('Loading transcripts…', { exact: true })).toHaveCount(0, { timeout: 2000 });
  await expect(visible(page.getByText(`${TOTAL_SESSIONS} transcripts`, { exact: true })).first()).toBeVisible({ timeout: 2000 });
  await expect(visible(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).first()).toBeVisible();
  await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();
});

test('a pending first transcript list shows loading, not an empty list', async ({ page }) => {
  await page.addInitScript(() => {
    window.__releaseTranscriptList = null;
    const wrap = (originalFetch) => (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl, location.origin);
      if (url.pathname === '/api/transcripts') {
        return new Promise((resolve) => {
          window.__releaseTranscriptList = () => resolve(new Response(JSON.stringify({ sessions: [] }), { headers: { 'content-type': 'application/json' } }));
        });
      }
      return originalFetch(input, init);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });
  await gotoView(page, 'Transcripts');
  await expect(visible(page.getByText('Loading transcripts…', { exact: true })).first()).toBeVisible();
  await expect(page.getByText('No transcripts.', { exact: true })).not.toBeVisible();
  await page.waitForFunction(() => typeof window.__releaseTranscriptList === 'function');
  await page.evaluate(() => window.__releaseTranscriptList());
  await expect(visible(page.getByText('No transcripts.', { exact: true })).first()).toBeVisible();
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

// VERIFY: transcript-request-ownership
// A late /api/transcript response belongs to the request that issued it: two
// opens in quick succession must not let the older request paint its transcript
// (or clear the newer request's loading flag) under the selection now shown.
// Holds the first request's response and releases it after the second selection.
const LATE_CASES = [
  { title: 'late success', mode: 'success', holdNext: false },
  { title: 'late 404', mode: 'notfound', holdNext: false },
  { title: 'late settle while the next transcript is still loading', mode: 'success', holdNext: true },
];

for (const c of LATE_CASES) {
  test(`a stale transcript request cannot overwrite the current one (${c.title})`, async ({ page }) => {
    const STALE_TX = sessionId(0);
    await page.addInitScript(() => {
      window.__holdTranscriptIds = [];
      window.__releaseTranscript = {};
      window.__transcriptSettled = {};
      const wrap = (originalFetch) => (input, init) => {
        const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        const url = new URL(rawUrl, location.origin);
        const id = url.pathname === '/api/transcript' ? url.searchParams.get('id') : null;
        if (!id || !window.__holdTranscriptIds.includes(id)) return originalFetch(input, init);
        // Fetch eagerly so the release withholds only the app's continuation,
        // and flag the moment the component reads the body — the spec waits on
        // that instead of sleeping.
        const pending = originalFetch(input, init);
        return new Promise((resolve) => {
          window.__releaseTranscript[id] = async (mode) => {
            if (mode === 'notfound') {
              resolve({ status: 404, json: async () => { window.__transcriptSettled[id] = true; return { ok: false, error: 'not found' }; } });
              return;
            }
            const res = await pending;
            const body = await res.json();
            resolve({ status: res.status, json: async () => { window.__transcriptSettled[id] = true; return body; } });
          };
        });
      };
      let current = wrap(window.fetch);
      Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
    });

    await openTranscripts(page);
    await page.evaluate((id) => { window.__holdTranscriptIds.push(id); }, STALE_TX);
    if (c.holdNext) await page.evaluate((id) => { window.__holdTranscriptIds.push(id); }, RICH_SESSION);

    // Open A: its transcript response is held, so the detail pane shows loading.
    await page.getByRole('button', { name: /Fixture session 0\b/ }).click();
    await expect(visible(page.getByText('Loading…', { exact: true })).first()).toBeVisible();

    // Open B before A settles.
    await page.getByRole('button', { name: /Retry backoff cap/ }).click();
    if (c.holdNext) {
      await page.waitForFunction((id) => typeof window.__releaseTranscript?.[id] === 'function', RICH_SESSION);
    } else {
      await expect(page.getByText(/Backoff is capped at 30s/)).toBeVisible();
    }

    // Release the stale A response and wait until the component has read it.
    await page.evaluate(([id, mode]) => window.__releaseTranscript[id](mode), [STALE_TX, c.mode]);
    await page.waitForFunction((id) => window.__transcriptSettled?.[id] === true, STALE_TX);
    // One paint after the read: a fixed component must not have rendered A.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    await expect(page.getByText(/Fixture request 0: summarize the module\./)).toHaveCount(0);
    await expect(page.getByText(/Transcript not found\./)).toHaveCount(0);
    if (c.holdNext) {
      // A must not clear B's loading flag either.
      await expect(visible(page.getByText('Loading…', { exact: true })).first()).toBeVisible();
      await page.evaluate((id) => window.__releaseTranscript[id]('success'), RICH_SESSION);
      await page.waitForFunction((id) => window.__transcriptSettled?.[id] === true, RICH_SESSION);
    }
    await expect(visible(page.getByText(/Backoff is capped at 30s/)).first()).toBeVisible();
    await expect(visible(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).first()).toBeVisible();
  });
}
