// Phone header/drawer: the one mobile-drawer smoke. Touch-input drawer
// navigation is covered by webkit-mobile.spec.mjs. Sets its own viewport, so it
// runs in the default project rather than the responsive viewport matrix.
import { test, expect } from './fixtures/test.mjs';
import { VIEW_IDS } from '../e2e/helpers/nav.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone; // 375x667

test('phone drawer replaces the rail, traps focus, closes on Escape, and reaches every view', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(trigger).toBeVisible();
  await expect(page.locator('aside')).toHaveCount(0);

  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const focusable = drawer.locator('[tabindex="0"]');
  await focusable.first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(focusable.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator('.MuiBackdrop-root:not(.MuiBackdrop-invisible)').click({
    position: { x: PHONE.width - 5, y: PHONE.height / 2 },
  });
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  // Every catalogue destination is reachable from the one phone nav surface.
  for (const label of [...Object.keys(VIEW_IDS), 'History', 'Settings']) {
    await expect(drawer.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(drawer.getByRole('button', { name: 'New session' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page).toHaveURL(/\/usage(\?|$)/);
  await expect(drawer).toBeHidden(); // closes on navigation
  await expectNoPageOverflow(page);
});
