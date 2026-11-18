// Settings view (mock suite only): the tab lives in the URL (?tab=models), and
// the Models editor is wired to the picker — an entry added here shows up in
// the New session dropdown without a reload. Mirage owns /api/models
// (db.ui.models), so the round trip exercises the same "no restart" contract
// the daemon gives. Fallback-key delete/rename rules: pricesDraft.test.mjs.
import { test, expect } from './fixtures/test.mjs';

test('Settings: tab via URL, keyboard reorder, and an added model reaches the New session dropdown', async ({ page }) => {
  // The per-tab action button is the panel landmark.
  await page.goto('/settings');
  await expect(page.getByText('Reset all')).toBeVisible();
  await expect(page.getByText('Restore defaults')).toHaveCount(0);
  // An unknown tab degrades to the default rather than rendering an empty view.
  await page.goto('/settings?tab=bogus');
  await expect(page.getByText('Reset all')).toBeVisible();

  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();
  await expect(page.getByText('Reset all')).toHaveCount(0);

  // Two textboxes per row (id, label); the handle's ArrowDown is the keyboard
  // path over the same reorder() drag-and-drop uses.
  const boxes = () => page.getByRole('textbox');
  const first = await boxes().nth(0).inputValue();
  const second = await boxes().nth(2).inputValue();
  expect(first).not.toBe(second);
  await page.getByRole('button', { name: 'Reorder' }).nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(boxes().nth(0)).toHaveValue(second);
  await expect(boxes().nth(2)).toHaveValue(first);

  // Add row: id only (no label — the dropdown renders the id bare).
  await page.getByPlaceholder('id — e.g. sonnet[1m]').fill('probe-model');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Round trip: the document the editor PUT now feeds the picker — no reload.
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('model', { exact: true }).click();
  await page.keyboard.press('ArrowDown'); // open the option popper
  await expect(page.getByRole('option', { name: /probe-model/ })).toBeVisible();
  await page.keyboard.press('Escape'); // close the popper, then the dialog
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
