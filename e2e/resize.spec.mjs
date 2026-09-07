// Pins the ResizeHandle contract (useResizable.jsx): a focusable, labelled
// role="separator" with live value semantics (aria-valuenow/min/max), whose
// arrow-key nudge both updates the DOM attribute and persists the new size to
// localStorage — the same persisted-width mechanism the drag handle commits
// through. The session-list handle (always present on the default Tasks view,
// no fixture setup needed) stands in for the whole family (dock/list/rail/
// report-list/transcript-panel handles all share this same component).
import { test, expect } from './fixtures/test.mjs';
import { setSkin } from './helpers/nav.mjs';

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
  // aria-orientation flips, and (Phase 2's acceptance criterion: clamp
  // effective saved dimensions to available viewport/container geometry) the
  // ceiling is a *dynamic* clamp against the main pane's own container height
  // (useResizable's `effMax`), not the static configured `max` (2000). The two
  // skins produce different ceilings (their chrome above the dock differs), so
  // this asserts the invariant the clamp guarantees — bounded, and tracking
  // the viewport — rather than pinning either skin's magic number.
  await page.goto('/');

  const handle = page.getByRole('separator', { name: 'Resize terminal dock' });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(handle).toHaveAttribute('aria-valuenow', '300'); // default height, sing-dock-h unset
  await expect(handle).toHaveAttribute('aria-valuemin', '140');

  const readMax = async () => Number(await handle.getAttribute('aria-valuemax'));
  const initialMax = await readMax();
  expect(initialMax).toBeGreaterThan(140);
  expect(initialMax).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));

  // Shrinking the viewport must shrink the ceiling — proves it's a live
  // container measurement, not a fixed number.
  await page.setViewportSize({ width: 1600, height: 500 });
  await expect.poll(readMax).toBeLessThan(initialMax);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(readMax).toBe(initialMax);

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

    // Same dynamic-ceiling invariant as the ZAPAC test above — Phosphor's
    // chrome above the dock differs, so its ceiling (measured 759px) is a
    // different number from ZAPAC's (860px), not a shared magic constant.
    const readMax = async () => Number(await handle.getAttribute('aria-valuemax'));
    const initialMax = await readMax();
    expect(initialMax).toBeGreaterThan(140);
    expect(initialMax).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    await page.setViewportSize({ width: 1600, height: 500 });
    await expect.poll(readMax).toBeLessThan(initialMax);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect.poll(readMax).toBe(initialMax);

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
