// Tasks board (kanban + history). The board is fed over the websocket — it
// never fetches /tasks itself — so every assertion here waits on the DOM to
// reflect a pushed 'tasks' frame rather than polling REST.
// Column counts: smoke.spec.mjs. Tag filter + history sort rules:
// web/src/features/tasks/historySort.test.mjs.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';

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

test('card opens the detail panel; "View transcript" hands off to the transcript sheet', async ({ page }) => {
  await gotoUrl(page, 'Tasks');

  const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
  await card.click();

  const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(dialog).toBeVisible();
  // By role: the description contains the title as a substring.
  await expect(dialog.getByRole('heading', { name: 'Seeded review card' })).toBeVisible();
  await expect(dialog.getByText('Cost', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Seeded review card — seeded fixture card.')).toBeVisible();
  await expect(dialog.getByText('Activity', { exact: true })).toBeVisible();
  await expect(dialog.getByText('In Review', { exact: true })).toBeVisible();
  // No sessionId on the seeded card, so "Open session" is disabled.
  await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(dialog).not.toBeVisible();
  const tx = page.getByRole('dialog', { name: 'Transcript', exact: true });
  await expect(tx).toBeVisible();
  await expect(tx.getByText('No transcript found for this task.')).toBeVisible();
  await tx.getByRole('button', { name: 'Close' }).click();
  await expect(tx).not.toBeVisible();
});

test('drag a card into Done, then abandon another via its hover flag', async ({ page }) => {
  await gotoUrl(page, 'Tasks');

  const card = page.getByRole('button', { name: 'Seeded todo card' });
  const doneColumn = page.getByText(/^Done \(\d+\)$/).locator('xpath=..');
  await html5Drag(page, card, doneColumn);
  await expect(doneColumn.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByText('Done (2)', { exact: true })).toBeVisible();
  await expect(page.getByText('To-Do (0)', { exact: true })).toBeVisible();

  const inProgress = page.getByRole('button', { name: 'Seeded in-progress card' });
  await inProgress.hover();
  const confirmMsg = onceConfirm(page, true);
  await inProgress.getByRole('button', { name: /Abandon task/ }).click();
  expect(await confirmMsg).toMatch(/abandon/i);
  await expect(inProgress).not.toBeVisible();
  await expect(page.getByText('In Progress (0)', { exact: true })).toBeVisible();
});

test('history view: toggle, sort a header, and delete a row', async ({ page }) => {
  await gotoUrl(page, 'Tasks');

  // exact: the Done card's "Remove (moves to history)" button also matches 'History'.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Board' })).toBeVisible();

  const concludedRow = page.locator('tr').filter({ hasText: 'Concluded fixture run' });
  const abandonedRow = page.locator('tr').filter({ hasText: 'Abandoned fixture run' });
  await expect(concludedRow).toBeVisible();
  await expect(abandonedRow).toBeVisible();

  // Enter, not a click: wide columns put the label text past the sort-label hit target.
  const col = page.locator('thead th').first();
  const label = col.getByText('Title', { exact: true });
  await label.press('Enter');
  await expect(col).toHaveAttribute('aria-sort', 'ascending');
  await label.press('Enter');
  await expect(col).toHaveAttribute('aria-sort', 'descending');

  const confirmMsg = onceConfirm(page, true);
  await abandonedRow.getByRole('button', { name: 'Delete permanently' }).click();
  expect(await confirmMsg).toMatch(/permanently delete/i);
  await expect(abandonedRow).not.toBeVisible();
  await expect(concludedRow).toBeVisible();
});
