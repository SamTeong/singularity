// Automation view (mock port of e2e/automation.spec.mjs): Scheduled (cron)
// jobs (top) + Background quota-soak jobs (below). The mock seeds two of each
// (web/src/mock/fixtures.js) — all disabled, with far-future cron/window
// settings, so flipping a Switch on never makes one due.
//
// Mirage JS patches window.fetch inside the page, so app requests NEVER reach
// Playwright's network layer — page.waitForResponse(...) hangs. The daemon
// spec relies on waitForResponse to assert HTTP method+url+body; none of that
// works here. Instead, every mutating mock handler (web/src/mock/routes/
// automation.js) broadcasts the matching 'crons'/'background' WS frame, so the
// UI converges from the socket: assertions wait on the DOM (row appears/
// disappears, Switch toBeChecked, edited title text, Jobs/Reports toggle).
//
// To still prove the RIGHT endpoint+method was hit without testing the mock's
// response body (which would just be testing the mock), a shared fetch
// recorder captures method + path + query, never the body. Paths are
// port-independent, so
// 'POST /crons', 'DELETE /crons/<id>', 'PATCH /background/reorder' etc. are
// stable. After an action, wait for the DOM to converge (which implies the
// fetch completed), then assert against the recorded calls.
//
// Never driven here: "Run now" on either section (per-row on Scheduled, the
// section-level button on Background) — both start a real agent run (see
// e2e/README.md "Never drive these").
//
// This file creates its own scheduled + background job (rather than mutating
// only the seeded rows) so its Edit/Delete flows don't depend on another spec
// leaving the seeded records alone — every mock test gets a fresh page-local
// store.
import { test, expect, onceConfirm, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';
import { sessionId } from '../web/src/mock/fixtures.js';

// See tasks.spec.mjs for why: this machine runs several agent sessions (and
// their own Playwright suites) concurrently, so the default 30s/test budget is
// tight under shared-CPU contention even though every interaction here is
// normally sub-second in isolation.
test.describe.configure({ timeout: 60_000 });

const CRON_1_ID = sessionId(2001); // 'Nightly fixture sweep'
const CRON_TITLE = 'E2E scheduled job';
const CRON_EXPR = '0 0 1 1 *'; // valid — every Jan 1st at midnight UTC

const BGJOB_1_ID = sessionId(3001); // 'Fixture backlog groomer'
const BGJOB_TITLE = 'E2E background job';

// The shared fetch recorder is installed after navigation in each test so the
// initial WS/REST bootstrap is excluded from the assertions.
// Playwright's dragTo()/mouse.down+move+up did not reliably fire React's
// onDragStart/onDragOver/onDrop for these HTML5-draggable elements under
// headless Chromium (no real OS-level drag). Dispatching the drag events
// directly with a shared DataTransfer — Playwright's documented recipe for
// HTML5 DnD — does. (Copied verbatim from e2e-mock/tasks.spec.mjs.)
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

test('scheduled: create validates the cron expression live then POSTs /crons, Edit reopens it prefilled, Delete confirms then DELETEs', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await recordFetchCalls(page);

  await page.getByRole('button', { name: 'Scheduled job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New scheduled job' })).toBeVisible();

  await dialog.getByLabel('title').fill(CRON_TITLE);
  await dialog.getByLabel('description').fill('e2e fixture description');
  const createBtn = dialog.getByRole('button', { name: 'Create' });
  const cronField = dialog.getByLabel('schedule (cron format, UTC)');

  // Invalid expression: live validation text + disabled Create.
  await cronField.fill('not a cron expression');
  await expect(dialog.getByText(/Not a valid schedule:/)).toBeVisible();
  await expect(createBtn).toBeDisabled();

  // Valid expression: live cronstrue description + next-fire text, Create enabled.
  await cronField.fill(CRON_EXPR);
  await expect(dialog.getByText(/January/)).toBeVisible();
  await expect(dialog.getByText(/next /)).toBeVisible();
  await expect(createBtn).toBeEnabled();

  await createBtn.click();
  // The id is unknown from a response body (Mirage intercepts fetch), so the
  // DELETE pathname is asserted with a regex below.
  const row = page.locator('tr').filter({ hasText: CRON_TITLE });
  await expect(row).toBeVisible();
  expect(await fetchCalls(page)).toContain('POST /api/crons');

  // Edit reopens the dialog prefilled with the job's fields, then Cancel — no mutation.
  await row.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByRole('heading', { name: 'Edit scheduled job' })).toBeVisible();
  await expect(editDialog.getByLabel('title')).toHaveValue(CRON_TITLE);
  await expect(editDialog.getByLabel('description')).toHaveValue('e2e fixture description');
  await expect(editDialog.getByLabel('schedule (cron format, UTC)')).toHaveValue(CRON_EXPR);
  await expect(editDialog.getByRole('button', { name: 'Save' })).toBeVisible();
  await editDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editDialog).toHaveCount(0);

  // Delete confirms then DELETE /crons/:id. The created id is unknown (no
  // response body to read), so assert the DELETE pathname with a regex.
  const confirmMsg = onceConfirm(page, true);
  await row.getByRole('button', { name: 'Delete' }).click();
  expect(await confirmMsg).toMatch(/delete scheduled job/i);
  await expect(row).not.toBeVisible();
  expect(await fetchCalls(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE \/api\/crons\/[^/]+$/)]));
});

test('scheduled: the enable Switch on a seeded (disabled) row flips via POST /crons/:id', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await recordFetchCalls(page);

  const row = page.locator('tr').filter({ hasText: 'Nightly fixture sweep' });
  const sw = row.getByRole('switch');
  await expect(sw).not.toBeChecked();

  await sw.click();
  await expect(sw).toBeChecked();
  expect(await fetchCalls(page)).toContain('POST /api/crons/' + CRON_1_ID);
});

test('background: create POSTs /background/jobs, Edit PATCHes the title, Delete confirms then DELETEs', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await recordFetchCalls(page);

  await page.getByRole('button', { name: 'Background job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New background job' })).toBeVisible();

  await dialog.getByLabel('title').fill(BGJOB_TITLE);
  await dialog.getByLabel('description').fill('e2e fixture description');
  await dialog.getByRole('button', { name: 'Create' }).click();

  const row = page.locator('tr').filter({ hasText: BGJOB_TITLE });
  await expect(row).toBeVisible();
  expect(await fetchCalls(page)).toContain('POST /api/background/jobs');

  await row.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByRole('heading', { name: 'Edit background job' })).toBeVisible();
  await expect(editDialog.getByLabel('title')).toHaveValue(BGJOB_TITLE);

  const editedTitle = `${BGJOB_TITLE} (edited)`;
  await editDialog.getByLabel('title').fill(editedTitle);
  await editDialog.getByRole('button', { name: 'Save' }).click();

  const editedRow = page.locator('tr').filter({ hasText: editedTitle });
  await expect(editedRow).toBeVisible();
  expect(await fetchCalls(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^PATCH \/api\/background\/jobs\/[^/]+$/)]));

  const confirmMsg = onceConfirm(page, true);
  await editedRow.getByRole('button', { name: 'Delete' }).click();
  expect(await confirmMsg).toMatch(/delete background job/i);
  await expect(editedRow).not.toBeVisible();
  expect(await fetchCalls(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE \/api\/background\/jobs\/[^/]+$/)]));
});

test('background: the enable Switch on a seeded (disabled) row flips via PATCH /background/jobs/:id', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await recordFetchCalls(page);

  const row = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
  const sw = row.getByRole('switch');
  await expect(sw).not.toBeChecked();

  await sw.click();
  await expect(sw).toBeChecked();
  expect(await fetchCalls(page)).toContain('PATCH /api/background/jobs/' + BGJOB_1_ID);
});

test('background: dragging one seeded row onto another PATCHes /background/reorder', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');
  await recordFetchCalls(page);

  const rowA = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
  const rowB = page.locator('tr').filter({ hasText: 'Fixture dependency check' });
  // The drag handle is its own draggable element inside the row (a Tooltip'd
  // grip icon) — dispatching drag events on the <tr> itself wouldn't reach the
  // handler bound to that inner element.
  const handle = rowA.locator('[aria-label*="Drag to change the order"]');

  await html5Drag(page, handle, rowB);
  expect(await fetchCalls(page)).toContain('PATCH /api/background/reorder');
});

test('background: Jobs<->Reports toggle switches view; Reports shows the empty state', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

  // Jobs view first — the per-row Background job affordances are only rendered
  // there (a real assertion: it'd still be visible if the toggle didn't switch).
  await expect(page.getByRole('button', { name: 'Background job' })).toBeVisible();

  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Background job' })).not.toBeVisible();
  // No background run has ever executed in this sandbox (Run now is never
  // clicked), so Reports is always empty.
  await expect(page.getByText('No reports yet')).toBeVisible();

  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Background job' })).toBeVisible();
});
