// Shared responsive smoke helpers. The named Playwright projects in
// playwright.mock.config.mjs set the standard viewport matrix.
import { expect } from '../fixtures/test.mjs';

export const RESPONSIVE_VIEWPORTS = {
  phone: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  compactDesktop: { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
};

export const RESPONSIVE_SKINS = ['ZAPAC', 'Phosphor Console'];

export async function pageOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      overflow: Math.max(0, root.scrollWidth - root.clientWidth),
    };
  });
}

// Kept separate from the baseline sampler: later responsive phases can turn a
// route from an observed exception into this strict page-level contract without
// changing measurement semantics.
export async function expectNoPageOverflow(page) {
  await expect.poll(() => pageOverflow(page), {
    message: 'page-level horizontal overflow should be absent',
  }).toMatchObject({ overflow: 0 });
}

// Skin ids as AppThemeProvider persists them (`sing-skin`), keyed by the label
// the switcher shows.
const SKIN_IDS = { ZAPAC: 'zapac', 'Phosphor Console': 'phosphor' };

// Select a skin without touching the nav chrome. The click-through helper in
// e2e/helpers/nav.mjs drives the rail's More menu, which does not exist on
// phone — this seeds the stored skin before the first render instead, so the
// same matrix runs at every viewport.
export async function seedSkin(page, skin) {
  await page.addInitScript((id) => window.localStorage.setItem('sing-skin', id), SKIN_IDS[skin]);
}
