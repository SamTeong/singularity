// Targeted iPhone Safari WebKit emulation. This is browser emulation only;
// physical iPhone coverage remains outside this mock suite.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';

test('iPhone Safari emulation: touch drawer navigation reaches a phone route', async ({ page }) => {
  expect(await page.evaluate(() => navigator.userAgent)).toContain('iPhone');
  expect(page.viewportSize()).toEqual({ width: 390, height: 664 });
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Open navigation' }).tap();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Usage', exact: true }).tap();
  await expect(page).toHaveURL(/\/usage(\?|$)/);
  await expect(drawer).toBeHidden();
  await expectNoPageOverflow(page);
});
