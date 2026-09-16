// The window-anchor row on the Usage page's provider cards. Seeded state comes
// from the mock's bare GET /window-anchor (claude armed, codex opt-in, ollama
// has no plan window at all); every mutation round-trips through the
// 'window-anchor' WS frame the mock broadcasts, the same one pty-ws fans out.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

// The anchor row folds its schedule and last outcome into one status dot, so
// the accessible name is where those words live now.
const anchorDot = (page, provider) => page.getByRole('img', { name: new RegExp(`^${provider} window anchor status`) });

test('the anchor row renders seeded state per provider', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Claude carries an armed window in the fixtures, so its status dot names the
  // scheduled time plus the last outcome. The fixture stamps the schedule two
  // hours out from load, so assert the shape, not a fixed clock reading.
  const claude = page.getByRole('switch', { name: 'Claude window anchor' });
  await expect(claude).toBeChecked();
  await expect(anchorDot(page, 'Claude')).toHaveAccessibleName(/Ok — Last anchor: .*· Next anchor: /);

  // Codex is the untouched opt-in shape; Ollama has no 5h plan window, so the
  // daemon reports no anchor state for it and the row is absent.
  await expect(page.getByRole('switch', { name: 'Codex window anchor' })).not.toBeChecked();
  await expect(anchorDot(page, 'Codex')).toHaveAccessibleName(/Never anchored · Not armed$/);
  await expect(page.getByRole('switch', { name: 'Ollama window anchor' })).toHaveCount(0);
});

test('toggling the anchor persists across a re-render', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  const toggle = page.getByRole('switch', { name: 'Claude window anchor' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/window-anchor');

  // Collapsing unmounts the cards and expanding remounts them, so the switch
  // reads its value back from the provider's state — not from itself. (A page
  // reload would not prove this: the mock's db resets per page load.)
  const section = page.getByRole('button', { name: /collapse usage|expand usage/i }).first();
  await section.click();
  await section.click();
  await expect(page.getByRole('switch', { name: 'Claude window anchor' })).not.toBeChecked();
});

test('Trigger posts the poke route and converges from the socket', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  // Claude's fixture 5h window already carries usage (pctUsed 42), so its reset
  // is pinned and the button is gone; Codex has session:null and has never
  // anchored, so it keeps the only Trigger on the page.
  await expect(page.getByRole('button', { name: 'Trigger' })).toHaveCount(1);
  // Codex has never anchored in the fixtures, so its dot names no last result.
  await expect(anchorDot(page, 'Codex')).toHaveAccessibleName(/Never anchored · Not armed$/);
  await page.getByRole('button', { name: 'Trigger' }).click();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/window-anchor/poke');

  // The poke response carries only its outcome; the recorded run reaches the
  // card on the broadcast 'window-anchor' frame, so the dot gaining a last
  // result is the proof.
  await expect(anchorDot(page, 'Codex')).toHaveAccessibleName(/Ok — Last anchor: /);
  // That same frame's lastAnchorAt is what retires the button: Codex's session
  // block is still null, so the fresh anchor timestamp is the only thing that
  // can tell the card this window is pinned.
  await expect(page.getByRole('button', { name: 'Trigger' })).toHaveCount(0);
});
