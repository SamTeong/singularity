// The two reorderable tables in Settings > Models — the API Rates panel and the
// Models list below it — swap their rows with a drag grip at desktop widths and
// Move up/down buttons below 900px, since an HTML5 drag is not operable by touch.
// Same `narrow` (isPhone || isTablet) switch as the Automation page's background
// jobs rows.
//
// Like the other per-viewport responsive specs, every test sets its own
// viewport, so this runs in the default `chromium` project rather than
// responsive.spec.mjs's fixed viewport matrix. Navigation is by URL.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

const openPrices = async (page) => {
  await page.goto('/settings?tab=models');
  await page.getByText('API Rates').click();
  return page.locator('.MuiAccordion-root').filter({ hasText: 'API Rates' });
};
const grips = (prices) => prices.getByRole('button', { name: 'Reorder' });
const moveUp = (prices) => prices.getByRole('button', { name: /^Move .+ up$/ });

// The reorder affordance is gated on `narrow` (isPhone || isTablet), so this
// covers the exact 899/900 edge without dropping the broader transitions.
test('live 899/900 crossing swaps an API rate row between the drag grip and Move up/down buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const prices = await openPrices(page);

  await expect(grips(prices).first()).toBeVisible();
  await expect(moveUp(prices)).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(grips(prices)).toHaveCount(0);
  await expect(moveUp(prices).first()).toBeVisible();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(grips(prices).first()).toBeVisible();
  await expect(moveUp(prices)).toHaveCount(0);

  // Keep the broad tablet/phone transition coverage too.
  await page.setViewportSize(TABLET);
  await expect(grips(prices)).toHaveCount(0);
  await expect(moveUp(prices).first()).toBeVisible();
  await page.setViewportSize(PHONE);
  await expect(moveUp(prices).first()).toBeVisible();
  await expect(grips(prices)).toHaveCount(0);
});

// The Models list's rows are the only ones with a `label` field (the API Rates
// panel has none), and the nearest Stack ancestor of that field is the row — so
// this scopes the assertion to the Models table even when both tables show grips.
const modelsGrip = (page) => page.getByPlaceholder('label').first()
  .locator('xpath=ancestor::div[contains(@class,"MuiStack-root")][1]')
  .getByRole('button', { name: 'Reorder' });
const modelsMoveUp = (page) => page.getByPlaceholder('label').first()
  .locator('xpath=ancestor::div[contains(@class,"MuiStack-root")][1]')
  .getByRole('button', { name: /^Move .+ up$/ });

test('live 899/900 crossing swaps a Models row between the drag grip and Move up/down buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings?tab=models');
  await expect(page.getByRole('button', { name: 'Restore defaults' })).toBeVisible();

  await expect(modelsGrip(page)).toBeVisible();
  await expect(modelsMoveUp(page)).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(modelsGrip(page)).toHaveCount(0);
  await expect(modelsMoveUp(page)).toBeVisible();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(modelsGrip(page)).toBeVisible();
  await expect(modelsMoveUp(page)).toHaveCount(0);
});
