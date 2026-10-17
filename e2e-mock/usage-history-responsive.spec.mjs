// The Usage view's 5h history panel at phone widths: the stacked chart fits
// its pane, the header row (title + refresh toggle) wraps instead of pushing
// past the pane, and the provider tabs stay usable. Header wrapping is
// skin-sensitive (font metrics), so both skins loop.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_SKINS, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

test.describe.configure({ timeout: 60_000 });

for (const skin of RESPONSIVE_SKINS) {
  for (const name of ['phone', 'narrowest']) {
    test(`usage history (${skin} ${name}): chart fits the pane, header row stays inside, tabs usable`, async ({ page }) => {
      await seedSkin(page, skin);
      await page.setViewportSize(RESPONSIVE_VIEWPORTS[name]);
      await page.goto('/usage');

      const chart = page.getByRole('figure', { name: '5h history chart' });
      await expect(chart).toBeVisible({ timeout: 15000 });
      // Widest svg = the plot surface (legend swatches are small svgs too).
      const fit = await chart.evaluate((el) => ({ w: Math.max(0, ...[...el.querySelectorAll('svg')].map((s) => s.getBoundingClientRect().width)), pane: el.parentElement.clientWidth }));
      expect(fit.w, 'chart drew at a usable width').toBeGreaterThan(100);
      expect(fit.w, 'chart stays inside its pane').toBeLessThanOrEqual(fit.pane + 1);

      const row = await page.getByRole('group', { name: 'History refresh interval' }).evaluate((el) => {
        const stack = el.closest('.MuiStack-root');
        return { sw: stack.scrollWidth, cw: stack.clientWidth };
      });
      expect(row.sw, 'header row fits its pane').toBeLessThanOrEqual(row.cw + 1);
      await expect(page.getByText(/^Estimated attribution/)).toBeVisible();

      await page.getByRole('tab', { name: 'Ollama' }).click();
      await expect(page.getByText(/^Ollama reports no per-session data/)).toBeVisible();
      await expectNoPageOverflow(page);
    });
  }
}
