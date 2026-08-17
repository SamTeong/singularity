// Appearance settings spec: validates the theme skin selector and colour mode
// toggle, and ensures the respawn dialog appears only when sessions are live.
import { test, expect } from './fixtures/test.mjs';
import { gotoMenu, setSkin, SKINS } from '../e2e/helpers/nav.mjs';

test('theme skin radiogroup selects each skin', async ({ page }) => {
  await page.goto('/');
  await gotoMenu(page, 'Appearance');

  // Walk each skin: select it, verify it's marked checked.
  for (const skin of SKINS) {
    const radio = page.getByRole('radio').filter({ hasText: skin });
    await radio.click();

    // Shell remounts on skin change — toHaveAttribute retries until the new
    // instance of this radio (found fresh each poll) reports checked, so this
    // survives the remount without a fixed sleep.
    await expect(radio).toHaveAttribute('aria-checked', 'true');
  }
});

test('colour mode toggle switches between light and dark', async ({ page }) => {
  await page.goto('/');
  await gotoMenu(page, 'Appearance');

  // The group should have two buttons: Light mode and Dark mode.
  const lightBtn = page.getByRole('button', { name: 'Light mode' });
  const darkBtn = page.getByRole('button', { name: 'Dark mode' });

  await expect(lightBtn).toBeVisible();
  await expect(darkBtn).toBeVisible();

  // Clicking flips which toggle reports pressed — MUI's ToggleButtonGroup sets
  // aria-pressed on the selected button, so wait on that instead of a fixed
  // sleep (and get a real assertion the toggle took effect, which this test
  // was missing before).
  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute('aria-pressed', 'true');

  await darkBtn.click();
  await expect(darkBtn).toHaveAttribute('aria-pressed', 'true');
});

test('respawn dialog does not appear with no live sessions', async ({ page }) => {
  // The mock seeds no agents, so there are no live sessions.
  // The respawn dialog only opens when respawnCount > 0, which is set only
  // if agents.filter(isLive).length > 0. Thus the dialog must NOT appear.

  await page.goto('/');
  await gotoMenu(page, 'Appearance');

  // Attempt to toggle the colour mode — this is what would trigger respawnCount.
  const darkBtn = page.getByRole('button', { name: 'Dark mode' });
  await darkBtn.click();
  // Asserting a dialog never appears has no positive landmark to wait on —
  // `.not.toBeVisible()` right after the click could pass vacuously before a
  // buggy delayed open. Give it a moment to have shown up if it were going to.
  await page.waitForTimeout(400);

  // The dialog title is "Restart sessions to match the new theme?" — it must
  // not be visible because there are no live sessions.
  const dialog = page.getByRole('heading', { name: 'Restart sessions to match the new theme?' });
  await expect(dialog).not.toBeVisible();
});

// ── Phosphor-specific Appearance coverage ───────────────────────────────────
// The mock starts with no live agents. These tests therefore cover the safe
// negative respawn case; they never accept a respawn confirmation.

test('selecting Phosphor Console applies the dark-only console and persists across reload', async ({ page }) => {
  await page.goto('/');
  await setSkin(page, 'Phosphor Console');

  const radio = page.getByRole('radio').filter({ hasText: 'Phosphor Console' });
  await expect(radio).toHaveAttribute('aria-checked', 'true');

  // Phosphor is dark-only (`PHOSPHOR_META.supportsColorMode: false`) — no
  // Light/Dark toggle is offered, only the "is dark-only" caption.
  await expect(page.getByRole('button', { name: 'Light mode' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Dark mode' })).not.toBeVisible();
  await expect(page.getByText('Phosphor Console is dark-only.')).toBeVisible();

  // Reload: the skin is persisted under a different key ('sing-skin') than the
  // view ('sing-view'), and both survive a reload independently — the shell
  // should land back on Appearance still showing the Phosphor console.
  await page.reload();
  await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible();

  const radioAfterReload = page.getByRole('radio').filter({ hasText: 'Phosphor Console' });
  await expect(radioAfterReload).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Light mode' })).not.toBeVisible();
  await expect(page.getByText('Phosphor Console is dark-only.')).toBeVisible();
});

test('switching skin with no live sessions applies immediately without a respawn prompt', async ({ page }) => {
  // Mirrors the existing colour-mode version of this assertion above, but
  // drives the actual skin switch (`onSelectSkin`) rather than the colour-mode
  // toggle (`onToggleTheme`) — both gate the same respawn dialog independently
  // in AppShell.jsx, so both need their own "no live sessions" coverage.
  await page.goto('/');
  await gotoMenu(page, 'Appearance');

  await setSkin(page, 'Phosphor Console');
  await page.waitForTimeout(400); // give a buggy delayed open a chance to appear

  const dialog = page.getByRole('heading', { name: 'Restart sessions to match the new theme?' });
  await expect(dialog).not.toBeVisible();
});

test('switching from Phosphor back to ZAPAC restores unchanged light/dark controls', async ({ page }) => {
  await page.goto('/');
  await setSkin(page, 'Phosphor Console');
  await expect(page.getByText('Phosphor Console is dark-only.')).toBeVisible();

  await setSkin(page, 'ZAPAC');

  const zapacRadio = page.getByRole('radio').filter({ hasText: 'ZAPAC' });
  await expect(zapacRadio).toHaveAttribute('aria-checked', 'true');

  // The dark-only caption is gone; the light/dark toggle group is back and
  // works exactly as it does under a clean ZAPAC session (same assertions as
  // the "colour mode toggle switches between light and dark" test above).
  await expect(page.getByText('Phosphor Console is dark-only.')).not.toBeVisible();
  const lightBtn = page.getByRole('button', { name: 'Light mode' });
  const darkBtn = page.getByRole('button', { name: 'Dark mode' });
  await expect(lightBtn).toBeVisible();
  await expect(darkBtn).toBeVisible();

  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute('aria-pressed', 'true');
  await darkBtn.click();
  await expect(darkBtn).toHaveAttribute('aria-pressed', 'true');
});
