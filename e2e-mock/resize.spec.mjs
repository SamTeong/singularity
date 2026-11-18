// Pins the ResizeHandle contract (useResizable.jsx): a focusable, labelled
// role="separator" with live value semantics (aria-valuenow/min/max), whose
// arrow-key nudge both updates the DOM attribute and persists the new size to
// localStorage. The session-list (axis x) and terminal-dock (axis y) handles
// stand in for the whole family (dock/list/rail/report-list/transcript-panel
// handles all share this same component).
import { test, expect } from './fixtures/test.mjs';

test('session list and terminal dock handles: aria contract, arrow-key nudge, persisted across reload', async ({ page }) => {
  await page.goto('/');
  const stored = (key) => page.evaluate((k) => localStorage.getItem(k), key);

  const list = page.getByRole('separator', { name: 'Resize session list' });
  await expect(list).toHaveAttribute('aria-orientation', 'vertical');
  await expect(list).toHaveAttribute('aria-valuenow', '260'); // default width, sing-list-w unset
  await expect(list).toHaveAttribute('aria-valuemin', '160');
  await expect(list).toHaveAttribute('aria-valuemax', '640');
  await list.focus();
  await page.keyboard.press('ArrowRight'); // useResizable's 16px arrow-key step
  await expect(list).toHaveAttribute('aria-valuenow', '276');
  await expect.poll(() => stored('sing-list-w')).toBe('276');
  await page.keyboard.press('ArrowLeft');
  await expect(list).toHaveAttribute('aria-valuenow', '260');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => stored('sing-list-w')).toBe('276');

  // axis:'y' — the ceiling is a container-height measurement, not the raw
  // configured `max` (2000): a saved dock height can never swallow the view.
  const dock = page.getByRole('separator', { name: 'Resize terminal dock' });
  await expect(dock).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(dock).toHaveAttribute('aria-valuenow', '300'); // default height, sing-dock-h unset
  await expect(dock).toHaveAttribute('aria-valuemin', '140');
  const maxNow = Number(await dock.getAttribute('aria-valuemax'));
  expect(maxNow).toBeGreaterThan(300);
  expect(maxNow).toBeLessThan(2000);
  await dock.focus();
  await page.keyboard.press('ArrowUp'); // axis:'y' grows *upward* on ArrowUp
  await expect(dock).toHaveAttribute('aria-valuenow', '316');
  await expect.poll(() => stored('sing-dock-h')).toBe('316');

  await page.reload();
  await expect(list).toHaveAttribute('aria-valuenow', '276');
  await expect(dock).toHaveAttribute('aria-valuenow', '316');
});
