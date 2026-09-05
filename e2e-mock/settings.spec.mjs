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

test('Settings: the drag handle reorders a model with the keyboard', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();

  // Two textboxes per row (id, label) — the add row's pair comes after them.
  const boxes = () => page.getByRole('textbox');
  const first = await boxes().nth(0).inputValue();
  const second = await boxes().nth(2).inputValue();
  expect(first).not.toBe(second);

  // Drag-and-drop is the primary gesture; the handle's ArrowUp/ArrowDown is the
  // keyboard path over the same reorder(), so this covers both.
  await page.getByRole('button', { name: 'Reorder' }).nth(0).focus();
  await page.keyboard.press('ArrowDown');

  await expect(boxes().nth(0)).toHaveValue(second);
  await expect(boxes().nth(2)).toHaveValue(first);
});

// Playwright's dragTo()/mouse.down+move+up does not reliably fire React's
// onDragStart/onDragOver/onDrop under headless Chromium (no real OS-level
// drag). Dispatching the events with a shared DataTransfer does. (Copied
// verbatim from e2e-mock/automation.spec.mjs.)
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

test('Settings: dragging a model onto a lower row moves it there', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();

  const boxes = () => page.getByRole('textbox');
  const [a, b, c] = [await boxes().nth(0).inputValue(), await boxes().nth(2).inputValue(), await boxes().nth(4).inputValue()];

  // Non-adjacent drop: the row moves to the target slot, it is not swapped
  // with it — so the two rows it passed shift up rather than jumping.
  const handle = page.getByRole('button', { name: 'Reorder' }).nth(0);
  await html5Drag(page, handle, boxes().nth(4));

  await expect(boxes().nth(0)).toHaveValue(b);
  await expect(boxes().nth(2)).toHaveValue(c);
  await expect(boxes().nth(4)).toHaveValue(a);
});
