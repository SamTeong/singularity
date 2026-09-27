// Window anchor on the Usage page's provider cards. Enablement is the daemon's
// WINDOW_ANCHOR in .env (no UI toggle); seeded state comes from the mock's bare
// GET /window-anchor (claude enabled + armed, codex not enabled, ollama has no
// plan window at all). Every poke round-trips through the 'window-anchor' WS
// frame the mock broadcasts, the same one pty-ws fans out.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

// The header dot folds usage freshness and the anchor schedule/outcome into one
// indicator, so its accessible name is where those words live.
const statusDot = (page, provider) => page.getByRole('img', { name: new RegExp(`^${provider} status — `) });

test('the header dot merges anchor state only for enabled providers', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Claude is enabled with an armed window. The fixture stamps the schedule two
  // hours out from load, so assert the shape, not a fixed clock reading.
  await expect(statusDot(page, 'Claude')).toHaveAccessibleName(/5h\/7d usage: .*: Last .* · Window anchor: Ok: Last \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · Next \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  // Enabled + armed + fresh usage: the dot's colour is the nominal mint.
  await expect(statusDot(page, 'Claude')).toHaveAttribute('data-status', 'ok');
  // Codex is not in WINDOW_ANCHOR: the dot carries the usage line alone.
  await expect(statusDot(page, 'Codex')).not.toHaveAccessibleName(/Window anchor:/);
  await expect(page.getByRole('switch', { name: /window anchor/i })).toHaveCount(0);
});

test('an enabled but not-yet-armed anchor renders a warn dot', async ({ page }) => {
  // Neither seeded provider covers this shape (Claude is armed, Codex is not
  // enabled), so fake the GET response ahead of Mirage's own fetch wrapper —
  // same recipe projects-review.spec.mjs uses — rather than touching the
  // shared seed other specs rely on. Codex's /usage record stays ok:true with
  // no `stale` flag, so its usage reads as fresh regardless of fetchedAt age.
  await page.addInitScript(() => {
    const wrap = (orig) => (...args) => {
      const [input] = args;
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/window-anchor') && !url.includes('/poke')) {
        const body = {
          claude: { enabled: true, nextAnchorAt: Date.now() + 2 * 3.6e6, lastAnchorAt: Date.now() - 3.6e6, lastResult: 'Ok', lastError: null },
          codex: { enabled: true, nextAnchorAt: null, lastAnchorAt: null, lastResult: null, lastError: null },
        };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(...args);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });

  await page.goto('/');
  await goto(page, 'Usage');

  await expect(statusDot(page, 'Codex')).toHaveAttribute('data-status', 'warn');
});

test('Anchor posts the poke route and converges from the socket', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  // Claude's fixture 5h window already carries usage (pctUsed 42), so its reset
  // is pinned and the button is gone; Codex has session:null and has never
  // anchored, so it keeps the only Anchor button on the page.
  await expect(page.getByRole('button', { name: 'Anchor' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Anchor' }).click();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/window-anchor/poke');

  // The poke response carries only its outcome; the broadcast frame's fresh
  // lastAnchorAt is the only thing that can tell the card (session still null)
  // this window is pinned, so the button retiring is the proof.
  await expect(page.getByRole('button', { name: 'Anchor' })).toHaveCount(0);
});
