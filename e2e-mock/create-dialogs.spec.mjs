// Dialog mechanics only — cancel-only, never submitted. Every test ends on
// Escape or Cancel, and the two dedicated "no request" tests fill the form to
// a submit-ready state first, so the guard actually proves something.
import { test, expect } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';
import { ROOTS, sessionId } from '../web/src/mock/fixtures.js';

const VALID_UUID = sessionId(500);

// ---------------------------------------------------------------- New session

test('New session dialog: title, model select, and session-id UUID validation flip Create → Resume', async ({ page }) => {
  test.slow();
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
  const scopeSelect = dialog.getByLabel('skill-scopes');
  await expect(scopeSelect).toBeVisible();
  await scopeSelect.click();
  await expect(page.getByRole('option').filter({ hasText: 'coding' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: 'design' })).toBeVisible();
  await page.keyboard.press('Escape');

  const submit = dialog.getByRole('button', { name: 'Create', exact: true });
  const sessionIdField = dialog.getByLabel(/session id/i);
  await expect(submit).toBeVisible();

  // Any non-empty text flips the label to Resume, but an invalid id disables
  // the button and shows the helper text — validity gates submittability, not
  // the label.
  await sessionIdField.fill('not-a-uuid');
  await expect(dialog.getByText('Not a valid session id')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();

  await sessionIdField.fill(VALID_UUID);
  await expect(dialog.getByText('Not a valid session id')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New session dialog: Browse opens the folder browser; picking a directory updates the cwd field', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });

  const cwdField = dialog.getByLabel('working directory');
  await expect(cwdField).toHaveValue('~'); // default cwd

  await dialog.getByRole('button', { name: 'Browse' }).click();
  const dirPicker = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Go' }) });
  await expect(dirPicker).toBeVisible();

  // The mock starts at its fake-home root, whose seeded `projects` directory
  // is a deterministic child. Pick it rather than assuming a real parent.
  await dirPicker.getByRole('button', { name: 'projects', exact: true }).click();
  await dirPicker.getByRole('button', { name: 'Select', exact: true }).click();

  await expect(page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Go' }) })).toHaveCount(0);
  await expect(cwdField).toHaveValue(ROOTS.projects);

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New session dialog: Escape closes it', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

// ------------------------------------------------------------------- New task

test('New task dialog: Create stays disabled until title + description are filled', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await goto(page, 'Tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });
  const create = dialog.getByRole('button', { name: 'Create', exact: true });

  await expect(create).toBeDisabled(); // cwd defaults to '~', but title + description are empty

  await dialog.getByLabel('title', { exact: true }).fill('Fixture-only task');
  await expect(create).toBeDisabled(); // description still empty

  await dialog.getByLabel('description', { exact: true }).fill('Never actually submitted.');
  await expect(create).toBeDisabled(); // orchestrator model still empty — now required

  await dialog.getByLabel('orchestrator model').fill('sonnet');
  await expect(create).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('New task dialog: three ModelSelects derive from the orchestrator model, plus turn-limit fields', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await goto(page, 'Tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });

  const orch = dialog.getByLabel('orchestrator model');
  const impl = dialog.getByLabel('implementor model');
  const rev = dialog.getByLabel('reviewer model');
  await expect(orch).toHaveValue('');
  await expect(impl).toHaveValue('sonnet');
  await expect(rev).toHaveValue('opus');

  const turnLimits = dialog.getByLabel('turn limit');
  await expect(turnLimits).toHaveCount(3);
  await turnLimits.nth(1).fill('12');
  await expect(turnLimits.nth(1)).toHaveValue('12');

  // A non-claude orchestrator model mirrors onto impl + reviewer instead of
  // the claude sonnet/opus split.
  await orch.fill('glm-5.2:cloud');
  await expect(impl).toHaveValue('glm-5.2:cloud');
  await expect(rev).toHaveValue('glm-5.2:cloud');

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New task dialog: tags Autocomplete adds a free-solo tag; both checkboxes toggle', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await goto(page, 'Tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });

  const tagsInput = dialog.getByLabel('tags (optional)');
  await tagsInput.fill('regression');
  await tagsInput.press('Enter');
  await expect(dialog.getByText('regression', { exact: true })).toBeVisible();

  const planCheckbox = dialog.getByRole('checkbox', { name: /draft a plan/i });
  const mergeCheckbox = dialog.getByRole('checkbox', { name: /Automatically merge/i });
  await expect(planCheckbox).not.toBeChecked();
  await expect(mergeCheckbox).not.toBeChecked();

  await planCheckbox.check();
  await mergeCheckbox.check();
  await expect(planCheckbox).toBeChecked();
  await expect(mergeCheckbox).toBeChecked();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('New task dialog: Escape and Cancel close it without POST /tasks, even submit-ready', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await goto(page, 'Tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });

  await dialog.getByLabel('title', { exact: true }).fill('Escape/Cancel guard');
  await dialog.getByLabel('description', { exact: true }).fill('Should never reach the server.');
  await dialog.getByLabel('orchestrator model').fill('sonnet');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();

  let posted = false;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/tasks')) posted = true; });

  // Move focus away from ModelSelect so Escape belongs to the dialog rather
  // than its option popper.
  await dialog.getByLabel('description', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();

  // Reopening keeps the filled fields (Escape doesn't reset local state) —
  // still submit-ready, so Cancel is the real test here, not an empty form.
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  expect(posted).toBe(false);
});
