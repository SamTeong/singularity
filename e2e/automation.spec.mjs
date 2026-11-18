// Automation view: Scheduled (cron) jobs (top) + Background quota-soak jobs
// (below). Proves the real /crons and /background/jobs route wiring and
// response shapes; switches, reorder and the Reports toggle are covered by
// e2e-mock/automation.
//
// Never driven here: "Run now" on either section (per-row on Scheduled, the
// section-level button on Background) — both start a real agent run (see
// e2e/README.md "Never drive these").
//
// This file creates its own scheduled + background job (rather than mutating
// the seeded rows) so its Edit/Delete flows don't depend on other specs
// leaving the seeded records alone — every spec shares one daemon boot.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';

const CRON_TITLE = 'E2E scheduled job';
const CRON_EXPR = '0 0 1 1 *'; // valid — every Jan 1st at midnight UTC
const BGJOB_TITLE = 'E2E background job';

// Two CRUD lifecycles in one test: double the default per-test budget.
test.describe.configure({ timeout: 120_000 });

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

  // Background jobs: create POSTs /background/jobs, Edit PATCHes the title,
  // Delete confirms then DELETEs.
  await page.getByRole('button', { name: 'Background job' }).click();
  const bgDialog = page.getByRole('dialog');
  await expect(bgDialog.getByRole('heading', { name: 'New background job' })).toBeVisible();

  await bgDialog.getByLabel('title').fill(BGJOB_TITLE);
  await bgDialog.getByLabel('description').fill('e2e fixture description');

  const [bgResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/background/jobs') && r.request().method() === 'POST'),
    bgDialog.getByRole('button', { name: 'Create' }).click(),
  ]);
  const bgBody = await bgResp.json();
  expect(bgBody.ok).toBe(true);
  expect(bgBody.job.title).toBe(BGJOB_TITLE);
  const bgJobId = bgBody.job.id;

  const bgRow = page.locator('tr').filter({ hasText: BGJOB_TITLE });
  await expect(bgRow).toBeVisible();

  await bgRow.getByRole('button', { name: 'Edit' }).click();
  const bgEditDialog = page.getByRole('dialog');
  await expect(bgEditDialog.getByRole('heading', { name: 'Edit background job' })).toBeVisible();
  await expect(bgEditDialog.getByLabel('title')).toHaveValue(BGJOB_TITLE);

  const editedTitle = `${BGJOB_TITLE} (edited)`;
  await bgEditDialog.getByLabel('title').fill(editedTitle);
  const [editResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/background/jobs/${bgJobId}`) && r.request().method() === 'PATCH'),
    bgEditDialog.getByRole('button', { name: 'Save' }).click(),
  ]);
  const editBody = await editResp.json();
  expect(editBody.ok).toBe(true);
  expect(editBody.job.title).toBe(editedTitle);

  const editedRow = page.locator('tr').filter({ hasText: editedTitle });
  await expect(editedRow).toBeVisible();

  const bgConfirmMsg = onceConfirm(page, true);
  const [bgDelResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/background/jobs/${bgJobId}`) && r.request().method() === 'DELETE'),
    editedRow.getByRole('button', { name: 'Delete' }).click(),
  ]);
  expect(await bgConfirmMsg).toMatch(/delete background job/i);
  const bgDelBody = await bgDelResp.json();
  expect(bgDelBody.ok).toBe(true);
  await expect(editedRow).not.toBeVisible();
});
