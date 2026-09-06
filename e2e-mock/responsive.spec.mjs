// Baseline contract for the entire route catalogue in both skins. It samples
// overflow without failing known pre-responsive layouts; Phase 8 promotes any
// remaining route exception to expectNoPageOverflow() from the shared helper.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/test.mjs';
import { pageOverflow, seedSkin, RESPONSIVE_SKINS } from './helpers/responsive.mjs';

// views.mjs defines the catalogue as NAV + NAV_ITEMS. Read those source exports
// rather than maintaining a second route list, so a nav-catalogue change adds
// or removes its baseline coverage automatically.
const shellFile = (name) => fileURLToPath(new URL(`../web/src/shell/${name}`, import.meta.url));
const idsFrom = (name) => [...readFileSync(shellFile(name), 'utf8').matchAll(/\{ v: '([^']+)'/g)].map(([, id]) => id);
const ROUTES = [...new Set([...idsFrom('Sidebar.jsx'), ...idsFrom('AppMenu.jsx')])];

expect(ROUTES).toHaveLength(15);

for (const skin of RESPONSIVE_SKINS) {
  for (const route of ROUTES) {
    test(`responsive baseline: ${skin} / ${route}`, async ({ page }, testInfo) => {
      await seedSkin(page, skin);
      await page.goto(`/${route}`);
      await expect(page).toHaveURL(new RegExp(`/${route}(\\?|$)`));

      // The pre-existing Phosphor Settings crash (t.palette.glass absent under
      // that skin) was fixed in Phase 5 of the responsive plan
      // (features/settings/*.jsx now read stroke2(t) from shellStyles.js,
      // skin-agnostic), so every
      // route/skin case takes the normal root-mounted contract; the old
      // `toHaveCount(0)` exception was removed with its cause.
      const appRoot = page.locator('#root > *').first();
      await expect(appRoot, 'route should mount the application root').toBeVisible();

      const overflow = await pageOverflow(page);
      await testInfo.attach('responsive-baseline.json', {
        body: JSON.stringify({
          route, skin, viewport: page.viewportSize(), rootMounted: true, ...overflow,
        }, null, 2),
        contentType: 'application/json',
      });
    });
  }
}
