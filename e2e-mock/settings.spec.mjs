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

test('Settings: History summariser accepts a claude-group model and persists it', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await expect(page.getByText('Restore defaults')).toBeVisible();

  // The summariser select now lists every enabled entry across groups
  // (claude/ollama/codex), not just ollama — pick a claude-group option.
  // `getByRole('combobox', {name})`, not `getByLabel` — MUI's Select renders
  // both a hidden native input and the visible combobox against the same
  // label, so `getByLabel` resolves to two elements (the pre-existing
  // strict-mode collision recorded in Phases 2, 3, 6 and 7). Matches the
  // working idiom at editors-settings-responsive.spec.mjs:135.
  const summariser = page.getByRole('combobox', { name: 'History summariser' });
  await summariser.click();
  await page.getByRole('option', { name: 'Best available' }).click();
  await expect(summariser).toHaveText('Best available');

  // Round trip: the PUT landed in the mock's document, not just local draft
  // state — GET /api/models directly. (A page.reload() would reset Mirage's
  // in-memory db, which is not the contract under test here.)
  const doc = await page.evaluate(() => fetch('/api/models').then((r) => r.json()));
  expect(doc.summariserModel).toBe('best');
});

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

test('Settings: dragging an API rate row onto a lower row moves it there', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  const prices = page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });

  // One textbox per base row (the above_200k table's rows follow them).
  const keys = () => prices.getByPlaceholder('e.g. opus');
  const [a, b, c] = [await keys().nth(0).inputValue(), await keys().nth(1).inputValue(), await keys().nth(2).inputValue()];

  // Non-adjacent drop: the row moves to the target slot, it is not swapped
  // with it — so the two rows it passed shift up rather than jumping. Base's
  // order IS match order, so this is the real reorder path (PUT round trip).
  const handle = prices.getByRole('button', { name: 'Reorder' }).nth(0);
  await html5Drag(page, handle, keys().nth(2));

  await expect(keys().nth(0)).toHaveValue(b);
  await expect(keys().nth(1)).toHaveValue(c);
  await expect(keys().nth(2)).toHaveValue(a);
});

test('Settings: dragging an above-threshold rate row reorders and persists it', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  const prices = page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });

  // above_200k seeds a single row, so add a second before there is anything to
  // reorder. The add row is the second "Key"/"Input"… group — base's comes
  // first — and every rate box must be filled or Add stays disabled.
  await prices.getByPlaceholder('Key').nth(1).fill('probe-above');
  for (const col of ['Input', 'Output', 'Cache read', 'Cache write']) {
    await prices.getByPlaceholder(col).nth(1).fill('1');
  }
  await prices.getByRole('button', { name: 'Add', exact: true }).nth(1).click();

  // Base's four rows come first; the above table's two rows follow them.
  const keys = () => prices.getByPlaceholder('e.g. opus');
  const [above0, above1] = [await keys().nth(4).inputValue(), await keys().nth(5).inputValue()];
  const handle = prices.getByRole('button', { name: 'Reorder' }).nth(4);
  await html5Drag(page, handle, keys().nth(5));

  await expect(keys().nth(4)).toHaveValue(above1);
  await expect(keys().nth(5)).toHaveValue(above0);

  // Same whole-doc PUT as the base table — above_200k order round-trips.
  const doc = await page.evaluate(() => fetch('/api/models/prices').then((r) => r.json()));
  expect(Object.keys(doc.above_200k)).toEqual([above1, above0]);
});

test('Settings: deleting the selected fallback chooses next and clears the last row', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  const prices = page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });
  const saved = () => page.evaluate(() => fetch('/api/models/prices').then((r) => r.json()));

  await prices.getByRole('button', { name: 'Delete opus', exact: true }).click();
  await expect.poll(async () => (await saved()).default_key).toBe('sonnet');
  await prices.getByRole('button', { name: 'Delete sonnet' }).click();
  await expect.poll(async () => (await saved()).default_key).toBe('haiku');
  await prices.getByRole('button', { name: 'Delete haiku' }).click();
  await expect.poll(async () => (await saved()).default_key).toBe('opus-5-5');
  await prices.getByRole('button', { name: 'Delete opus-5-5' }).click();
  await expect.poll(async () => (await saved()).default_key).toBe('');
});

test('Settings: deleting the selected last fallback chooses the preceding base row', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  const prices = page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });
  const fallback = prices.getByRole('combobox');
  await fallback.click();
  await page.getByRole('option', { name: 'haiku', exact: true }).click();

  await prices.getByRole('button', { name: 'Delete haiku' }).click();
  await expect.poll(async () => page.evaluate(() => fetch('/api/models/prices').then((r) => r.json())))
    .toMatchObject({ default_key: 'sonnet' });
});

test('Settings: renaming the selected fallback keeps it selected', async ({ page }) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  const prices = page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });
  await prices.getByPlaceholder('e.g. opus').nth(1).fill('opus-renamed');
  await prices.getByPlaceholder('e.g. opus').nth(1).press('Tab');

  await expect.poll(async () => page.evaluate(() => fetch('/api/models/prices').then((r) => r.json())))
    .toMatchObject({ default_key: 'opus-renamed' });
});
