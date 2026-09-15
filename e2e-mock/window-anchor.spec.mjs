// The window-anchor row on the Usage page's provider cards. Seeded state comes
// from the mock's bare GET /window-anchor (claude armed, codex opt-in, ollama
// has no plan window at all); every mutation round-trips through the
// 'window-anchor' WS frame the mock broadcasts, the same one pty-ws fans out.
import { test, expect, recordFetchCalls, fetchCalls } from './fixtures/test.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

test('the anchor row renders seeded state per provider', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');

  // Claude carries an armed window in the fixtures, so the row shows a real
  // countdown (fmtReset) plus its last outcome.
  const claude = page.getByRole('switch', { name: 'Claude window anchor' });
  await expect(claude).toBeChecked();
  await expect(page.getByText('· next in 2h')).toBeVisible();
  await expect(page.getByText('· last: ok')).toBeVisible();

  // Codex is the untouched opt-in shape; Ollama has no 5h plan window, so the
  // daemon reports no anchor state for it and the row is absent.
  await expect(page.getByRole('switch', { name: 'Codex window anchor' })).not.toBeChecked();
  await expect(page.getByText('· not armed')).toBeVisible();
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

test('Poke now posts the poke route and converges from the socket', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Usage');
  await recordFetchCalls(page);

  // Cards render claude, codex, ollama in that order. Codex has never anchored
  // in the fixtures, so it has no last-result cell — claude's is the only one.
  await expect(page.getByText('· last: ok')).toHaveCount(1);
  await page.getByRole('button', { name: 'Poke now' }).nth(1).click();
  await expect.poll(() => fetchCalls(page)).toContain('POST /api/window-anchor/poke');

  // The poke response carries only its outcome; the recorded run reaches the
  // card on the broadcast 'window-anchor' frame, so a second cell is the proof.
  await expect(page.getByText('· last: ok')).toHaveCount(2);
});
