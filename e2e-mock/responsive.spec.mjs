// Phase 8 B1: strict completion contract for the entire route catalogue, both
// skins, across all five responsive projects (5 viewports x 15 routes x 2
// skins = 150 cases). Every case must mount its own route-specific content
// (not just an arbitrary root child) and carry zero page-level horizontal
// overflow — no baseline crash exception remains (Phase 5 fixed the one that
// existed, the Phosphor Settings crash) and no case counts as passing on an
// empty or still-loading root.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, pageOverflow, seedSkin, RESPONSIVE_SKINS } from './helpers/responsive.mjs';
import { VIEW_LANDMARK } from '../e2e/helpers/nav.mjs';

// views.mjs defines the catalogue as NAV_CATALOG (NAV + NAV_ITEMS, deduped) —
// importing it directly would be one source instead of two, but its module
// chain (`@/shell/Sidebar.jsx`) uses Vite's `@` alias, which plain Node ESM
// (how Playwright loads this file) cannot resolve: confirmed by a throwaway
// `node --input-type=module -e "import('./web/src/shell/views.mjs')"` probe,
// which threw `Cannot find package '@/shell'`. No loader/`imports` map exists
// in this repo to bridge that, so the regex-over-source read stays — reading
// the same two files views.mjs itself reads from, so a nav-catalogue change
// still adds/removes baseline coverage automatically.
const shellFile = (name) => fileURLToPath(new URL(`../web/src/shell/${name}`, import.meta.url));
const idsFrom = (name) => [...readFileSync(shellFile(name), 'utf8').matchAll(/\{ v: '([^']+)'/g)].map(([, id]) => id);
const ROUTES = [...new Set([...idsFrom('Sidebar.jsx'), ...idsFrom('AppMenu.jsx')])];

expect(ROUTES).toHaveLength(15);

for (const skin of RESPONSIVE_SKINS) {
  for (const route of ROUTES) {
    test(`responsive: ${skin} / ${route}`, async ({ page }, testInfo) => {
      await seedSkin(page, skin);
      await page.goto(`/${route}`);
      await expect(page).toHaveURL(new RegExp(`/${route}(\\?|$)`));

      // Route-specific ready content, not `#root > *` — an empty or
      // still-loading root satisfies a bare root-child locator.
      const landmark = VIEW_LANDMARK[route];
      await expect(landmark(page), `${route} should mount its own ready content`).toBeVisible({ timeout: 15000 });

      await expectNoPageOverflow(page);

      // Diagnostic attachment kept for triage even though the case now fails
      // on overflow directly, rather than only sampling it.
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
