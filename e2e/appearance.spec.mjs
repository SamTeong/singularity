// Appearance settings spec: validates the theme skin selector and colour mode
// toggle, and ensures the respawn dialog appears only when sessions are live.
import { test, expect } from './fixtures/test.mjs';
import { gotoMenu, SKINS } from './helpers/nav.mjs';

// Appearance navigation can be slow. Raise the timeout.
test.setTimeout(60000);

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
  // The sandbox has no seeded sessions, so there are no live agents.
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
