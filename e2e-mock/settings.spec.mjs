// Settings view (mock suite only): the tab lives in the URL (?tab=models), and
// the Models editor is wired to the picker — an entry added here shows up in
// the New session dropdown without a reload. Mirage owns /api/models
// (db.ui.models), so the round trip exercises the same "no restart" contract
// the daemon gives.
import { test, expect } from './fixtures/test.mjs';

test('Settings: tab switching via URL — ?tab=models deep-links, unknown degrades to shortcuts', async ({ page }) => {
  // The per-tab action button is the panel landmark (the tab title moved into
  // the shared Settings header in phase 3, so there is no "Keyboard shortcuts"
  // text to assert on).
  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();
  await expect(page.getByText('Reset all')).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByText('Reset all')).toBeVisible();
  await expect(page.getByText('Restore defaults')).toHaveCount(0);

  // An unknown tab degrades to the default rather than rendering an empty view.
  await page.goto('/settings?tab=bogus');
  await expect(page.getByText('Reset all')).toBeVisible();
});

test('Settings: an added model appears in the New session dropdown without a reload', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();

  // Add row: id only (no label — the dropdown renders the id bare).
  await page.getByPlaceholder('id — e.g. sonnet[1m]').fill('probe-model');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Round trip: the document the editor PUT now feeds the picker — no reload.
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  const model = dialog.getByLabel('model', { exact: true });
  await model.click();
  await page.keyboard.press('ArrowDown'); // open the option popper
  await expect(page.getByRole('option', { name: /probe-model/ })).toBeVisible();

  await page.keyboard.press('Escape'); // close the popper, then the dialog
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
