import { test, expect } from './fixtures/test.mjs';
import { goto, setSkin } from './helpers/nav.mjs';

test('dock minimize round-trips between the term-bar button and the collapsed strip', async ({ page }) => {
  await page.goto('/');

  // Two different controls, one per state. Expanded, the only toggle is the
  // `.term-tools` icon-btn on the right of the term-bar; the "Sessions" label
  // beside it is `.dock-list-head` — plain text, deliberately not clickable.
  const minimize = page.getByRole('button', { name: 'Minimize dock' });
  // Collapsed, the whole dock shrinks to one clickable strip (unmounted while
  // expanded, so its absence is the assertion that the dock is open).
  const restore = page.locator('[role="button"][title="Restore"]');

  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);

  await minimize.click();

  await expect(restore).toBeVisible();
  await expect(restore).toContainText('Sessions');
  // Body stays mounted (display:none) so terminals keep scrollback — the
  // minimize button is still in the DOM, just not reachable.
  await expect(minimize).toBeHidden();

  await restore.click();

  await expect(minimize).toBeVisible();
  await expect(restore).toHaveCount(0);
});

test('clicking the session-list header also collapses the dock', async ({ page }) => {
  await page.goto('/');

  // A second collapse trigger alongside the term-bar's minimize button: the
  // `.dock-list-head` row itself, distinguished by its own accessible name so
  // it doesn't collide with "Minimize dock" or the collapsed strip's "Restore".
  const header = page.getByRole('button', { name: 'Collapse sessions dock' });
  const restore = page.locator('[role="button"][title="Restore"]');

  await expect(header).toBeVisible();
  await expect(restore).toHaveCount(0);

  await header.click();

  await expect(restore).toBeVisible();
  await expect(header).toBeHidden();

  await restore.click();

  await expect(header).toBeVisible();
  await expect(restore).toHaveCount(0);
});

test('dock empty state shows "No agent selected" when no session is active', async ({ page }) => {
  await page.goto('/');

  // With no agents in the sandbox, the dock should show empty state.
  // The empty state is inside the dock (full width when expanded).
  // Check for the specific text in the empty state
  const emptyStateDesc = page.getByText('Create an agent to begin.');

  await expect(emptyStateDesc).toBeVisible({ timeout: 10000 });
});

test('dock header survives across view switches', async ({ page }) => {
  await page.goto('/');

  const listHead = page.getByRole('heading', { name: 'Sessions' });
  const minimize = page.getByRole('button', { name: 'Minimize dock' });
  await expect(listHead).toBeVisible();
  await expect(minimize).toBeVisible();

  // Walk a few views (rail + more-menu) and confirm the dock header — and its
  // expanded state — survives every switch, since it lives outside the routed
  // view area in AppShell and must never remount alongside it.
  for (const view of ['Automation', 'Usage', 'Wiki', 'Tasks']) {
    await goto(page, view);
    await expect(listHead).toBeVisible();
    await expect(minimize).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Phosphor Console (openspec/changes/implement-phosphor-theme, task 8.4):
// persisted resize/minimize, semantic session state, and unchanged
// terminal/session operations.
//
// Live xterm/session-action coverage (duplicate/fork/resume/restart/reattach/
// external/kill) is NOT exercised here: the sandbox seeds ZERO agents on
// purpose (e2e/fixtures/seed.mjs — nothing may spawn a pty), so SessionRow
// never mounts and there is no live session to drive (e2e/README.md's "Never
// drive these"). What IS reachable and asserted below is everything the dock
// itself renders with no live session: the minimize/restore mechanic, the
// bilingual zone header + hard dock edge, and the Phosphor-native empty
// state. The palette RESOLVER (`getTerminalTheme`/`PHOSPHOR_TERM_THEME`) is
// unit-tested directly in web/src/features/sessions/term-theme.test.mjs; the
// one reachable half of live palette coverage — the read-only transcript
// ANSI palette — is covered in transcripts.spec.mjs. Persisted dock/list
// resize dimensions are covered in resize.spec.mjs's own Phosphor block
// (shared ResizeHandle component, skin-agnostic mechanics).
test.describe('Session dock — Phosphor Console', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSkin(page, 'Phosphor Console');
  });

  test('dock renders a bilingual zone header and hard edge, and minimize/restore still round-trips', async ({ page }) => {
    // Bilingual zone header (SessionDock.jsx: "Sessions" + Mincho "部隊") and
    // a mono "N TOTAL" readout in place of ZAPAC's pill-shaped count chip.
    const listHead = page.getByRole('heading', { name: 'Sessions' });
    await expect(listHead).toBeVisible();
    await expect(listHead.getByText('部隊', { exact: true })).toBeVisible();
    await expect(page.getByText('0 TOTAL', { exact: true })).toBeVisible();

    const minimize = page.getByRole('button', { name: 'Minimize dock' });
    const restore = page.locator('[role="button"][title="Restore"]');
    await expect(minimize).toBeVisible();
    await expect(restore).toHaveCount(0);

    await minimize.click();

    await expect(restore).toBeVisible();
    await expect(restore).toContainText('Sessions');
    await expect(restore.getByText('部隊', { exact: true })).toBeVisible();
    await expect(restore.getByText('0 TOTAL', { exact: true })).toBeVisible();
    await expect(minimize).toBeHidden();

    // Hard edge — no ZAPAC rounded dock corner under Phosphor (SessionDock.jsx:
    // `borderRadius: phosphor ? 0 : getTokens(t).radius.lg`). The minimized
    // strip's direct parent is the outer dock Box that carries this radius.
    const dockBox = restore.locator('xpath=..');
    await expect(dockBox).toHaveCSS('border-top-left-radius', '0px');

    await restore.click();

    await expect(minimize).toBeVisible();
    await expect(restore).toHaveCount(0);
  });

  test('dock header survives across view switches under Phosphor', async ({ page }) => {
    const listHead = page.getByRole('heading', { name: 'Sessions' });
    const minimize = page.getByRole('button', { name: 'Minimize dock' });
    await expect(listHead).toBeVisible();
    await expect(minimize).toBeVisible();

    for (const view of ['Automation', 'Usage', 'Wiki', 'Tasks']) {
      await goto(page, view);
      await expect(listHead).toBeVisible();
      await expect(minimize).toBeVisible();
    }
  });

  test('the dock empty state renders Phosphor-native chrome with the same copy as ZAPAC', async ({ page }) => {
    const emptyTitle = page.getByText('No agent selected', { exact: true });
    await expect(emptyTitle).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Create an agent to begin.', { exact: true })).toBeVisible();

    // Hard-edged, chrome-stroked (orange) icon tile in place of ZAPAC's glass
    // chip (EmptyState.jsx's Phosphor branch) — the icon Box directly
    // precedes the title Typography in that component's markup.
    const iconTile = emptyTitle.locator('xpath=preceding-sibling::*[1]');
    await expect(iconTile).toHaveCSS('border-top-left-radius', '0px');
    await expect(iconTile).toHaveCSS('border-top-color', 'rgb(242, 100, 0)');
  });
});
