// Pins the ResizeHandle contract (useResizable.jsx): a focusable, labelled
// role="separator" with live value semantics (aria-valuenow/min/max), whose
// arrow-key nudge both updates the DOM attribute and persists the new size to
// localStorage — the same persisted-width mechanism the drag handle commits
// through. The session-list handle (always present on the default Tasks view,
// no fixture setup needed) stands in for the whole family (dock/list/rail/
// report-list/transcript-panel handles all share this same component).
import { test, expect } from './fixtures/test.mjs';
import { setSkin } from '../e2e/helpers/nav.mjs';

test('Resize session list: arrow key nudges the width and persists it', async ({ page }) => {
  await page.goto('/');

  const handle = page.getByRole('separator', { name: 'Resize session list' });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuenow', '260'); // default width, sing-list-w unset
  await expect(handle).toHaveAttribute('aria-valuemin', '160');
  await expect(handle).toHaveAttribute('aria-valuemax', '640');

  await handle.focus();
  await page.keyboard.press('ArrowRight'); // useResizable's 16px arrow-key step

  await expect(handle).toHaveAttribute('aria-valuenow', '276');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('276');

  // ArrowLeft nudges back the other way — proves the value isn't one-directional.
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '260');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('260');
});

test('Resize terminal dock: same contract on the axis:"y" handle', async ({ page }) => {
  // The dock handle (axis:'y') exercises the other half of the contract —
  // aria-orientation flips, and the ceiling is the static configured `max`
  // (2000) rather than a per-render container measurement (useResizable
  // deliberately keeps that measurement inside the drag/keyboard handlers,
  // not the render-time return, per react-hooks/refs).
  await page.goto('/');

  const handle = page.getByRole('separator', { name: 'Resize terminal dock' });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(handle).toHaveAttribute('aria-valuenow', '300'); // default height, sing-dock-h unset
  await expect(handle).toHaveAttribute('aria-valuemin', '140');
  await expect(handle).toHaveAttribute('aria-valuemax', '2000');

  await handle.focus();
  await page.keyboard.press('ArrowUp'); // axis:'y' grows *upward* on ArrowUp

  await expect(handle).toHaveAttribute('aria-valuenow', '316');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sing-dock-h'))).toBe('316');
});

// ---------------------------------------------------------------------------
// Phosphor Console (openspec/changes/implement-phosphor-theme, task 8.4):
// persisted resize/minimize mechanics are unchanged under Phosphor —
// ResizeHandle is a single skin-agnostic component (design.md D1: only true
// structural signatures branch on skinId), so this is a regression pass on
// the exact same aria/localStorage contract proven above, plus a reload
// round-trip to confirm the persisted dimension AND the persisted skin both
// survive independently (they're stored under different keys — 'sing-list-w'
// / 'sing-dock-h' vs 'sing-skin').
test.describe('Resize handles — Phosphor Console', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSkin(page, 'Phosphor Console');
  });

  test('Resize session list keeps its aria contract and persists under Phosphor', async ({ page }) => {
    const handle = page.getByRole('separator', { name: 'Resize session list' });
    await expect(handle).toBeVisible();
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    await expect(handle).toHaveAttribute('aria-valuenow', '260');
    await expect(handle).toHaveAttribute('aria-valuemin', '160');
    await expect(handle).toHaveAttribute('aria-valuemax', '640');

    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '276');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('276');
  });

  test('Resize terminal dock keeps its aria contract and persists under Phosphor', async ({ page }) => {
    const handle = page.getByRole('separator', { name: 'Resize terminal dock' });
    await expect(handle).toBeVisible();
    await expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(handle).toHaveAttribute('aria-valuenow', '300');
    await expect(handle).toHaveAttribute('aria-valuemin', '140');
    await expect(handle).toHaveAttribute('aria-valuemax', '2000');

    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect(handle).toHaveAttribute('aria-valuenow', '316');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sing-dock-h'))).toBe('316');
  });

  test('a resized dimension and the Phosphor skin both survive a reload, independently', async ({ page }) => {
    const handle = page.getByRole('separator', { name: 'Resize session list' });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '276');

    await page.reload();

    const reloadedHandle = page.getByRole('separator', { name: 'Resize session list' });
    await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '276');
    // Phosphor is still active post-reload (persisted 'sing-skin') — the
    // masthead only renders under that skin (e2e/phosphor.spec.mjs).
    await expect(page.getByRole('banner').getByText('SINGULARITY')).toBeVisible();
  });
});
