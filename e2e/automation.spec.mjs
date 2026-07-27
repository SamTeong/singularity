// Automation view: Scheduled (cron) jobs (top) + Background quota-soak jobs
// (below). Sandbox seeds two of each (fixtures/seed.mjs) — all **disabled**,
// with far-future cron/window settings, so flipping a Switch on never makes
// one due.
//
// Never driven here: "Run now" on either section (per-row on Scheduled, the
// section-level button on Background) — both start a real agent run (see
// e2e/README.md "Never drive these").
//
// This file creates its own scheduled + background job (rather than mutating
// only the seeded rows) so its Edit/Delete flows don't depend on tasks.spec.mjs
// leaving the seeded records alone — the two files share one daemon boot.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';
import { sessionId } from './fixtures/paths.mjs';

// See tasks.spec.mjs for why: this machine runs several agent sessions (and
// their own Playwright suites) concurrently, so the default 30s/test budget
// is tight under shared-CPU contention even though every interaction here is
// normally sub-second in isolation.
test.describe.configure({ timeout: 60_000 });

const CRON_1_ID = sessionId(2001); // 'Nightly fixture sweep'
const CRON_TITLE = 'E2E scheduled job';
const CRON_EXPR = '0 0 1 1 *'; // valid — every Jan 1st at midnight UTC

const BGJOB_1_ID = sessionId(3001); // 'Fixture backlog groomer'
const BGJOB_TITLE = 'E2E background job';

test('scheduled: create validates the cron expression live then POSTs /crons, Edit reopens it prefilled, Delete confirms then DELETEs', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

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

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/crons') && r.request().method() === 'POST'),
    createBtn.click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.cron.title).toBe(CRON_TITLE);
  // The id comes straight off the create response — kept local (not module
  // state) so this test stands alone under --grep/.only/a single re-run.
  const cronId = body.cron.id;

  const row = page.locator('tr').filter({ hasText: CRON_TITLE });
  await expect(row).toBeVisible();

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

  // Delete confirms then DELETE /crons/:id.
  const confirmMsg = onceConfirm(page, true);
  const [delResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/crons/${cronId}`) && r.request().method() === 'DELETE'),
    row.getByRole('button', { name: 'Delete' }).click(),
  ]);
  expect(await confirmMsg).toMatch(/delete scheduled job/i);
  const delBody = await delResp.json();
  expect(delBody.ok).toBe(true);
  await expect(row).not.toBeVisible();
});

test('scheduled: the enable Switch on a seeded (disabled) row flips via POST /crons/:id', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

  const row = page.locator('tr').filter({ hasText: 'Nightly fixture sweep' });
  const sw = row.getByRole('switch');
  await expect(sw).not.toBeChecked();

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/crons/${CRON_1_ID}`) && r.request().method() === 'POST'),
    sw.click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.cron.enabled).toBe(true);
  await expect(sw).toBeChecked();
});

test('background: create POSTs /background/jobs, Edit PATCHes the title, Delete confirms then DELETEs', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

  await page.getByRole('button', { name: 'Background job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New background job' })).toBeVisible();

  await dialog.getByLabel('title').fill(BGJOB_TITLE);
  await dialog.getByLabel('description').fill('e2e fixture description');

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/background/jobs') && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Create' }).click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.job.title).toBe(BGJOB_TITLE);
  // Local, not module state — see the scheduled lifecycle test above for why.
  const bgJobId = body.job.id;

  const row = page.locator('tr').filter({ hasText: BGJOB_TITLE });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByRole('heading', { name: 'Edit background job' })).toBeVisible();
  await expect(editDialog.getByLabel('title')).toHaveValue(BGJOB_TITLE);

  const editedTitle = `${BGJOB_TITLE} (edited)`;
  await editDialog.getByLabel('title').fill(editedTitle);
  const [editResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/background/jobs/${bgJobId}`) && r.request().method() === 'PATCH'),
    editDialog.getByRole('button', { name: 'Save' }).click(),
  ]);
  const editBody = await editResp.json();
  expect(editBody.ok).toBe(true);
  expect(editBody.job.title).toBe(editedTitle);

  const editedRow = page.locator('tr').filter({ hasText: editedTitle });
  await expect(editedRow).toBeVisible();

  const confirmMsg = onceConfirm(page, true);
  const [delResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/background/jobs/${bgJobId}`) && r.request().method() === 'DELETE'),
    editedRow.getByRole('button', { name: 'Delete' }).click(),
  ]);
  expect(await confirmMsg).toMatch(/delete background job/i);
  const delBody = await delResp.json();
  expect(delBody.ok).toBe(true);
  await expect(editedRow).not.toBeVisible();
});

test('background: the enable Switch on a seeded (disabled) row flips via PATCH /background/jobs/:id', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

  const row = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
  const sw = row.getByRole('switch');
  await expect(sw).not.toBeChecked();

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/background/jobs/${BGJOB_1_ID}`) && r.request().method() === 'PATCH'),
    sw.click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.job.enabled).toBe(true);
  await expect(sw).toBeChecked();
});

test('background: dragging one seeded row onto another PATCHes /background/reorder', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Automation');

  const rowA = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
  const rowB = page.locator('tr').filter({ hasText: 'Fixture dependency check' });
  // The drag handle is its own draggable element inside the row (a Tooltip'd
  // grip icon) — dispatching drag events on the <tr> itself wouldn't reach the
  // handler bound to that inner element.
  const handle = rowA.locator('[aria-label*="Drag to change the order"]');

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await handle.dispatchEvent('dragstart', { dataTransfer });
  await rowB.dispatchEvent('dragover', { dataTransfer });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/background/reorder') && r.request().method() === 'PATCH'),
    rowB.dispatchEvent('drop', { dataTransfer }),
  ]);
  await handle.dispatchEvent('dragend', { dataTransfer });

  const body = await resp.json();
  expect(body.ok).toBe(true);
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
