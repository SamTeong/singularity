// Console cleanliness spec: walks every view against real daemon payloads and
// verifies the browser console stays clean (no errors, warnings, or page
// exceptions) — the cheapest broad check for daemon-shape drift. The
// consoleGuard fixture auto-fails on any console log; this spec's job is to
// visit everything so the guard sees it. Skin rendering (Phosphor) is
// client-only and covered by e2e-mock.
import { test } from './fixtures/test.mjs';
import { goto, setSkin, RAIL_VIEWS, MENU_VIEWS } from './helpers/nav.mjs';

// A full walk of all views is slow. Raise the per-test timeout.
test.setTimeout(300000); // 5 minutes

test('console is clean across all views in ZAPAC', async ({ page }) => {
  await page.goto('/');

  // Pin the skin. Remounts the shell, so wait for it to settle.
  await setSkin(page, 'ZAPAC');

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
