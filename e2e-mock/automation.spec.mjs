// Automation view (mock port of e2e/automation.spec.mjs): Scheduled (cron)
// jobs (top) + Background quota-soak jobs (below). The mock seeds two of each
// (web/src/mock/fixtures.js) — all disabled, with far-future cron/window
// settings, so flipping a Switch on never makes one due.
//
// Mirage JS patches window.fetch inside the page, so app requests NEVER reach
// Playwright's network layer — page.waitForResponse(...) hangs. Instead, every
// mutating mock handler (web/src/mock/routes/automation.js) broadcasts the
// matching 'crons'/'background' WS frame, so the UI converges from the socket:
// assertions wait on the DOM, then check a shared fetch recorder (method +
// path + query, never the body) to prove the RIGHT endpoint+method was hit.
//
// Never driven here: "Run now" on either section — both start a real agent
// run (see e2e/README.md "Never drive these").
import { test, expect, onceConfirm, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { sessionId } from '../web/src/mock/fixtures.js';

const CRON_1_ID = sessionId(2001); // 'Nightly fixture sweep'
const CRON_TITLE = 'E2E scheduled job';
const CRON_EXPR = '0 0 1 1 *'; // valid — every Jan 1st at midnight UTC

const BGJOB_1_ID = sessionId(3001); // 'Fixture backlog groomer'
const BGJOB_TITLE = 'E2E background job';

// Playwright's dragTo()/mouse.down+move+up did not reliably fire React's
// onDragStart/onDragOver/onDrop for these HTML5-draggable elements under
// headless Chromium (no real OS-level drag). Dispatching the drag events
// directly with a shared DataTransfer — Playwright's documented recipe for
// HTML5 DnD — does.
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

test('scheduled: live cron validation, POST, Edit prefilled, Delete; seeded enable Switch POSTs', async ({ page }) => {
  await gotoUrl(page, 'Automation');
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
  await editDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editDialog).toHaveCount(0);

  // Delete confirms then DELETE /crons/:id (created id unknown, so regex).
  const confirmMsg = onceConfirm(page, true);
  await row.getByRole('button', { name: 'Delete' }).click();
  expect(await confirmMsg).toMatch(/delete scheduled job/i);
  await expect(row).not.toBeVisible();
  expect(await fetchCalls(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE \/api\/crons\/[^/]+$/)]));

  const sw = page.locator('tr').filter({ hasText: 'Nightly fixture sweep' }).getByRole('switch');
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  expect(await fetchCalls(page)).toContain('POST /api/crons/' + CRON_1_ID);
});

test('scheduled: seeded last run shows end reason and duration; its output tail expands and collapses', async ({ page }) => {
  await gotoUrl(page, 'Automation');
  const row = page.locator('tr').filter({ hasText: 'Weekly fixture digest' });
  await expect(row.getByText(/went idle .* · ran 2m 0s/)).toBeVisible();
  const tail = page.locator('pre').filter({ hasText: 'Please run /login' });
  await expect(tail).toHaveCount(0);
  await row.getByRole('button', { name: 'Show output' }).click();
  await expect(tail).toBeVisible();
  await row.getByRole('button', { name: 'Hide output' }).click();
  await expect(tail).toHaveCount(0);
});

test('background: create, Edit PATCH, Delete; enable Switch; drag reorder; Jobs/Reports toggle', async ({ page }) => {
  await gotoUrl(page, 'Automation');
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

  const rowA = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
  const sw = rowA.getByRole('switch');
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  expect(await fetchCalls(page)).toContain('PATCH /api/background/jobs/' + BGJOB_1_ID);

  // The drag handle is its own draggable element inside the row — dispatching
  // drag events on the <tr> itself wouldn't reach its handler.
  const rowB = page.locator('tr').filter({ hasText: 'Fixture dependency check' });
  await html5Drag(page, rowA.locator('[aria-label*="Drag to change the order"]'), rowB);
  await expect.poll(() => fetchCalls(page)).toContain('PATCH /api/background/reorder');

  // No background run has ever executed (Run now is never clicked), so
  // Reports is always empty; the Background job button only renders on Jobs.
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Background job' })).not.toBeVisible();
  await expect(page.getByText('No reports yet')).toBeVisible();
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Background job' })).toBeVisible();
});
