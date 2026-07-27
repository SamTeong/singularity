// Console cleanliness spec: walks every skin × every view and verifies the
// browser console stays clean (no errors, warnings, or page exceptions).
// The consoleGuard fixture auto-fails on any console log; this spec's job is
// to visit everything so the guard sees it.
import { test } from './fixtures/test.mjs';
import { goto, setSkin, RAIL_VIEWS, MENU_VIEWS, SKINS } from './helpers/nav.mjs';

// A full walk of all skins and views is slow. Raise the per-test timeout.
test.setTimeout(300000); // 5 minutes

// Test once per skin to keep failures scoped — if ZAPAC is broken, we see
// "ZAPAC" in the test name, not buried in a combined walk.
for (const skin of SKINS) {
  test(`console is clean across all views in ${skin}`, async ({ page }) => {
    await page.goto('/');

    // Switch to this skin. Remounts the shell, so wait for it to settle.
    await setSkin(page, skin);

    // Walk every rail view.
    for (const label of RAIL_VIEWS) {
      await goto(page, label);
    }

    // Walk every menu view.
    for (const label of MENU_VIEWS) {
      await goto(page, label);
    }

    // If we got here without the consoleGuard fixture catching anything,
    // the test passes. The fixture does the actual console assertions.
  });
}
