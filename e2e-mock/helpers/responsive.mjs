// Shared responsive smoke helpers. The named Playwright projects in
// playwright.mock.config.mjs set the standard viewport matrix.
import { expect } from '../fixtures/test.mjs';

export const RESPONSIVE_VIEWPORTS = {
  narrowest: { width: 320, height: 667 },
  phone: { width: 375, height: 667 },
  landscapePhone: { width: 667, height: 375 }, // >=600px wide -> tablet rail, not the phone drawer
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

// Vertical reachability, honestly measured. `expectNoPageOverflow` only sees
// HORIZONTAL overflow, and `scrollIntoViewIfNeeded()` + `toBeInViewport()` do
// not care which ancestor scrolled — Playwright will happily scroll an
// `overflow:hidden` box, which no user can scroll with a wheel or a finger. So
// a test that only combines those three stays green when a pane's bounded
// scroll region is removed outright. This asserts the two things that actually
// distinguish "the pane scrolls" from "nothing a user can reach": the page
// itself did not move, and no unscrollable ancestor was scrolled to get there.
export async function expectReachableByPaneScroll(page, locator) {
  const pageTopBefore = await page.evaluate(() => document.scrollingElement.scrollTop);
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport({ ratio: 0.99 });
  const state = await locator.evaluate((el) => {
    const clipped = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n === document.scrollingElement || n.scrollTop === 0) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') clipped.push({ tag: n.tagName, overflowY: oy, scrollTop: n.scrollTop });
    }
    return { clipped, pageTop: document.scrollingElement.scrollTop };
  });
  expect(state.clipped, 'only a user-scrollable ancestor may be scrolled to reveal this').toEqual([]);
  expect(state.pageTop, 'the page itself must not scroll to reveal this').toBe(pageTopBefore);
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
