// Phase 1 of the responsive plan: the phone header/drawer, the tablet icon rail,
// and the rule that a viewport change never overwrites the user's rail-collapse
// choice. Viewports are set per test (the crossings matter here), so this spec
// runs in the default project rather than the responsive viewport matrix.
import { test, expect } from './fixtures/test.mjs';
import { VIEW_IDS } from '../e2e/helpers/nav.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';

const PHONE = { width: 375, height: 667 };
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1440, height: 900 };

const railWidth = async (page) => (await page.locator('aside').boundingBox()).width;

test('phone shows the nav drawer instead of the rail, and reaches every view', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await expect(trigger).toBeVisible();
  await expect(page.locator('aside')).toHaveCount(0);

  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
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

test('phone drawer closes on Escape and returns focus to its trigger', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('320px wide phone has no page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('tablet forces the icon rail without overwriting the desktop collapse choice', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  const expanded = await railWidth(page);
  expect(expanded).toBeGreaterThan(200);

  // No reload: crossing 899/900 forces the icon rail...
  await page.setViewportSize(TABLET);
  await expect.poll(() => railWidth(page)).toBeLessThan(100);
  // ...and crossing back restores the choice the user never changed.
  await page.setViewportSize(DESKTOP);
  await expect.poll(() => railWidth(page)).toBe(expanded);
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
});

test('resizing out of phone mode swaps the drawer for the rail and keeps focus in the shell', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();

  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  await expect(page.locator('aside')).toBeVisible();
  await expect(page.locator('aside').locator(':focus')).toHaveCount(1);
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
});

test('tapping the tablet rail toggle does not rewrite the desktop collapse choice', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  const expanded = await railWidth(page);

  await page.setViewportSize(TABLET);
  await expect.poll(() => railWidth(page)).toBeLessThan(100);
  // The active row doubles as the collapse toggle on the rail; on tablet it must
  // be inert rather than write the preference desktop restores.
  await page.locator('aside').getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect.poll(() => railWidth(page)).toBeLessThan(100);

  await page.setViewportSize(DESKTOP);
  await expect.poll(() => railWidth(page)).toBe(expanded);
});

test('the More menu does not survive a desktop-to-phone resize', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await page.locator('aside').getByRole('button', { name: 'More', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  // Sidebar unmounts here, taking the menu's anchor node with it.
  await page.setViewportSize(PHONE);
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
});
