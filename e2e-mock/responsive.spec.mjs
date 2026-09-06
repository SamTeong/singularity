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
    test(`responsive baseline: ${skin} / ${route}`, async ({ page, consoleGuard }, testInfo) => {
      // Existing Phosphor Settings throws while reading an absent skin role.
      // Retain this as a non-blocking baseline signal until its owning phase.
      if (skin === 'Phosphor Console' && route === 'settings') {
        consoleGuard.allow(/Cannot read properties of undefined \(reading 'stroke'\)/);
      }
      await seedSkin(page, skin);
      await page.goto(`/${route}`);
      await expect(page).toHaveURL(new RegExp(`/${route}(\\?|$)`));

      const viewport = page.viewportSize();
      const appRoot = page.locator('#root > *').first();
      const knownSettingsCrash = skin === 'Phosphor Console' && route === 'settings';
      if (knownSettingsCrash) {
        await expect(appRoot, 'known Phosphor Settings baseline crash leaves no app root').toHaveCount(0);
      } else {
        await expect(appRoot, 'route should mount the application root').toBeVisible();
      }

      const overflow = await pageOverflow(page);
      await testInfo.attach('responsive-baseline.json', {
        body: JSON.stringify({
          route, skin, viewport, rootMounted: !knownSettingsCrash, knownSettingsCrash, ...overflow,
        }, null, 2),
        contentType: 'application/json',
      });
    });
  }
}
