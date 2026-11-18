// Strict completion contract for the entire route catalogue, both skins, at
// the two viewport extremes (responsive-narrowest 320px, responsive-desktop
// 1440px). Every route must mount its own route-specific content (not just an
// arbitrary root child) and carry zero page-level horizontal overflow. One test
// per skin walks all 17 routes in a single page, so the matrix costs four
// tests instead of 170.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_SKINS } from './helpers/responsive.mjs';
import { VIEW_LANDMARK } from '../e2e/helpers/nav.mjs';

// views.mjs defines the catalogue as NAV_CATALOG (NAV + NAV_ITEMS, deduped) —
// importing it directly would be one source instead of two, but its module
// chain (`@/shell/Sidebar.jsx`) uses Vite's `@` alias, which plain Node ESM
// (how Playwright loads this file) cannot resolve: confirmed by a throwaway
// `node --input-type=module -e "import('./web/src/shell/views.mjs')"` probe,
// which threw `Cannot find package '@/shell'`. No loader/`imports` map exists
// in this repo to bridge that, so the regex-over-source read stays — reading
// the same two files views.mjs itself reads from, so a nav-catalogue change
// still adds/removes coverage automatically.
const shellFile = (name) => fileURLToPath(new URL(`../web/src/shell/${name}`, import.meta.url));
const idsFrom = (name) => [...readFileSync(shellFile(name), 'utf8').matchAll(/\{ v: '([^']+)'/g)].map(([, id]) => id);
const ROUTES = [...new Set([...idsFrom('Sidebar.jsx'), ...idsFrom('AppMenu.jsx')])];

expect(ROUTES).toHaveLength(17);

for (const skin of RESPONSIVE_SKINS) {
  test(`responsive: ${skin} / every route mounts without page overflow`, async ({ page }) => {
    test.slow();
    await seedSkin(page, skin);
    for (const route of ROUTES) {
      await test.step(route, async () => {
        await page.goto(`/${route}`);
        await expect(page).toHaveURL(new RegExp(`/${route}(\\?|$)`));
        // Route-specific ready content, not `#root > *` — an empty or
        // still-loading root satisfies a bare root-child locator.
        await expect(VIEW_LANDMARK[route](page), `${route} should mount its own ready content`).toBeVisible();
        await expectNoPageOverflow(page);
      });
    }
  });
}
