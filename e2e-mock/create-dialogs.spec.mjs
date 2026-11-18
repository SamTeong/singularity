// Dialog mechanics only — cancel-only, never submitted. Every test ends on
// Escape or Cancel; the New task test fills the form to a submit-ready state
// first, so the "no POST" guard actually proves something.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { ROOTS, sessionId } from '../web/src/mock/fixtures.js';

const VALID_UUID = sessionId(500);

test('New session dialog: fields, folder browser, session-id validation flips Create → Resume, Escape closes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();

  const title = dialog.getByLabel('title (optional)');
  await title.fill('Fixture-only resume check');
  await expect(title).toHaveValue('Fixture-only resume check');

  const model = dialog.getByLabel('model', { exact: true });
  await model.fill('sonnet');
  await expect(model).toHaveValue('sonnet');
  await page.keyboard.press('Escape'); // close ModelSelect's option popper

  // Mock mode seeds both scope groups, so ScopeSelect must populate.
  await dialog.getByLabel('skill-scopes').click();
  await expect(page.getByRole('option').filter({ hasText: 'coding' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: 'design' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Browse: the mock starts at its fake-home root, whose seeded `projects`
  // directory is a deterministic child.
  const cwdField = dialog.getByLabel('working directory');
  await expect(cwdField).toHaveValue('~');
  await dialog.getByRole('button', { name: 'Browse' }).click();
  const dirPicker = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Go' }) });
  await dirPicker.getByRole('button', { name: 'projects', exact: true }).click();
  await dirPicker.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(dirPicker).toHaveCount(0);
  await expect(cwdField).toHaveValue(ROOTS.projects);

  // Any non-empty text flips the label to Resume, but an invalid id disables
  // the button and shows the helper text — validity gates submittability.
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
  const sessionIdField = dialog.getByLabel(/session id/i);
  await sessionIdField.fill('not-a-uuid');
  await expect(dialog.getByText('Not a valid session id')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  await sessionIdField.fill(VALID_UUID);
  await expect(dialog.getByText('Not a valid session id')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New task dialog: derived models, tags + checkboxes, required-field gating, Escape/Cancel never POST', async ({ page }) => {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });
  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  const description = dialog.getByLabel('description', { exact: true });

  // The orchestrator field opens prefilled with the store's defaultModel;
  // impl/reviewer keep their hardcoded claude sonnet/opus split.
  const orch = dialog.getByLabel('orchestrator model');
  const impl = dialog.getByLabel('implementor model');
  const rev = dialog.getByLabel('reviewer model');
  await expect(orch).toHaveValue('claude');
  await expect(impl).toHaveValue('sonnet');
  await expect(rev).toHaveValue('opus');
  const turnLimits = dialog.getByLabel('turn limit');
  await expect(turnLimits).toHaveCount(3);
  await turnLimits.nth(1).fill('12');
  await expect(turnLimits.nth(1)).toHaveValue('12');

  const tagsInput = dialog.getByLabel('tags (optional)');
  await tagsInput.fill('regression');
  await tagsInput.press('Enter');
  await expect(dialog.getByText('regression', { exact: true })).toBeVisible();
  const planCheckbox = dialog.getByRole('checkbox', { name: /draft a plan/i });
  const mergeCheckbox = dialog.getByRole('checkbox', { name: /Automatically merge/i });
  await expect(planCheckbox).not.toBeChecked();
  await planCheckbox.check();
  await mergeCheckbox.check();
  await expect(planCheckbox).toBeChecked();
  await expect(mergeCheckbox).toBeChecked();

  // Create stays disabled until title + description + a model are filled.
  await expect(create).toBeDisabled();
  await dialog.getByLabel('title', { exact: true }).fill('Fixture-only task');
  await expect(create).toBeDisabled();
  await description.fill('Never actually submitted.');
  await expect(create).toBeEnabled();
  await orch.fill('');
  await expect(create).toBeDisabled();

  // A non-claude orchestrator model mirrors onto impl + reviewer.
  await orch.fill('glm-5.2:cloud');
  await expect(impl).toHaveValue('glm-5.2:cloud');
  await expect(rev).toHaveValue('glm-5.2:cloud');
  await expect(create).toBeEnabled();

  // Submit-ready: Escape and Cancel must both close without POST /tasks.
  await recordFetchCalls(page);
  // Move focus off ModelSelect so Escape belongs to the dialog, not its popper.
  await description.click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  // Reopening keeps the filled fields (Escape doesn't reset local state).
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(create).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await fetchCalls(page)).filter((c) => c.startsWith('POST /api/tasks'))).toEqual([]);
});
