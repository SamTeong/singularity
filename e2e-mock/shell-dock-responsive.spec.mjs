// Phase 2 of the responsive plan: session dock + terminal + persisted list
// width/dock height at phone/tablet, and the phone single-pane switch. Like
// shell-mobile-nav.spec.mjs, viewports are set per test (the crossings and the
// initially-restored persisted value both matter), so this runs in the
// default project rather than the responsive viewport matrix.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';
import { goto } from '../e2e/helpers/nav.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;                   // 375x667
const LANDSCAPE_PHONE = RESPONSIVE_VIEWPORTS.landscapePhone; // 667x375, >=600px wide → tablet rail, not the phone drawer
const TABLET = RESPONSIVE_VIEWPORTS.tablet;                 // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;        // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;               // 1440x900

const listSeparator = (page) => page.getByRole('separator', { name: 'Resize session list' });
const dockSeparator = (page) => page.getByRole('separator', { name: 'Resize terminal dock' });
const railWidth = async (page) => (await page.locator('aside').boundingBox()).width;

async function createSession(page, title) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('title (optional)').fill(title);
  await dialog.getByLabel('model', { exact: true }).fill('sonnet');
  await page.keyboard.press('Escape'); // close ModelSelect's option popper
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
}

// -------------------------------------------------------------- list width

test('a saved 640px list width does not crowd a phone dock; the drag handle returns and restores it exactly at desktop', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('sing-list-w', '640'));
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  // Phone has no drag affordance at all — the pane switch below replaces it —
  // so the separator must not be left behind, unnamed or not.
  await expect(listSeparator(page)).toHaveCount(0);
  await expectNoPageOverflow(page);

  // No reload: crossing back to desktop brings the handle back reporting the
  // untouched persisted value, not a phone-clamped one.
  await page.setViewportSize(DESKTOP);
  await expect(listSeparator(page)).toBeVisible();
  await expect(listSeparator(page)).toHaveAttribute('aria-valuenow', '640');
  expect(await page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('640');
});

test('a saved 640px list width is clamped at tablet so it cannot crowd the terminal pane', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('sing-list-w', '640'));
  await page.setViewportSize(TABLET);
  await page.goto('/tasks');

  const sep = listSeparator(page);
  await expect(sep).toBeVisible();
  const now = Number(await sep.getAttribute('aria-valuenow'));
  expect(now).toBeLessThan(640);
  expect(now).toBeGreaterThanOrEqual(160); // never below the configured min
  await expectNoPageOverflow(page);
  // The persisted preference itself is untouched by the tablet clamp.
  expect(await page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('640');
});

// This covers the exact 899/900 edge as well as the wider tablet/compact bands.
test('a saved 640px list width live-crosses 899/900: rail changes at the edge while the stored desktop width restores through broad bands', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('sing-list-w', '640'));
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await expect(listSeparator(page)).toHaveAttribute('aria-valuenow', '640');

  // 899px is tablet: the rail is forced to its icon form, while this width
  // still has enough room for the saved list preference.
  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect.poll(() => railWidth(page)).toBe(64);
  await expect(listSeparator(page)).toHaveAttribute('aria-valuenow', '640');

  // Its immediately adjacent 900px neighbor restores the desktop rail choice
  // without changing the saved list preference or reloading.
  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect.poll(() => railWidth(page)).toBeGreaterThan(64);
  await expect.poll(() => listSeparator(page).getAttribute('aria-valuenow')).toBe('640');

  // Keep the broad tablet/compact transition coverage too.
  await page.setViewportSize(TABLET);
  await expect.poll(async () => Number(await listSeparator(page).getAttribute('aria-valuenow'))).toBeLessThan(640);
  await page.setViewportSize(COMPACT);
  await expect.poll(() => listSeparator(page).getAttribute('aria-valuenow')).toBe('640');
  await expectNoPageOverflow(page);

  // Crossing back to full desktop keeps the exact same value, and the stored
  // preference was never touched by any of this live resizing.
  await page.setViewportSize(DESKTOP);
  await expect.poll(() => listSeparator(page).getAttribute('aria-valuenow')).toBe('640');
  expect(await page.evaluate(() => localStorage.getItem('sing-list-w'))).toBe('640');
});

// Phase 8 B3 gap 2: shell-dock-responsive.spec.mjs had no Phosphor case at all.
test('the phone dock opens collapsed and its height clamp holds under Phosphor Console too', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  await page.addInitScript(() => window.localStorage.setItem('sing-dock-h', '900'));
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  const restore = page.locator('[role="button"][title="Restore"]');
  await expect(restore).toBeVisible();
  await restore.click();
  const listBtn = page.getByRole('button', { name: 'Session list' });
  await expect(listBtn).toBeInViewport();
  const dockBox = await listBtn.locator('xpath=../..').boundingBox();
  expect(dockBox.height).toBeLessThan(320); // clamped, not the raw persisted 900px
  await expectNoPageOverflow(page);
});

// -------------------------------------------------------------- dock height

test('a saved 900px dock height is bounded on a short phone viewport, leaving the page above usable', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('sing-dock-h', '900'));
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  // A phone now opens with the dock collapsed (Phase 3, finding 2) — expand it,
  // since the clamp this test is about only applies to an open dock.
  await page.locator('[role="button"][title="Restore"]').click();

  // Dock controls are reachable...
  const listBtn = page.getByRole('button', { name: 'Session list' });
  await expect(listBtn).toBeInViewport();
  // ...and so is the page above the dock (the phone header trigger + a Tasks
  // board landmark), which a 900px-tall dock would otherwise swallow.
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeInViewport();
  await expect(page.getByText(/To-Do \(\d+\)/).first()).toBeInViewport();

  // The dock itself (the pane switcher's own parent) is bounded well under the
  // persisted 900px — a fraction of the 667px-tall viewport, not the raw
  // desktop preference.
  const dockBox = await listBtn.locator('xpath=../..').boundingBox();
  expect(dockBox.height).toBeLessThan(320);
  expect(await page.evaluate(() => localStorage.getItem('sing-dock-h'))).toBe('900'); // untouched
});

test('a saved 900px dock height is still clamped at landscape-phone height (667x375)', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('sing-dock-h', '900'));
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/tasks');

  // 375px of height now opens collapsed too (a landscape phone is tablet by
  // width but shorter than any portrait phone) — expand it to reach the clamp.
  await page.locator('[role="button"][title="Restore"]').click();

  // 667px wide is tablet width-class (>=600px), so this keeps the drag handle —
  // its own container-height clamp must still stop 900px from swallowing a
  // 375px-tall viewport.
  const sep = dockSeparator(page);
  await expect(sep).toBeVisible();
  const max = Number(await sep.getAttribute('aria-valuemax'));
  expect(max).toBeLessThan(900);
  await expect(page.getByRole('button', { name: 'Minimize dock' })).toBeInViewport();
});

test('the dock opens collapsed on a phone and on a landscape phone, and expanding it there is not a new desktop default', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  // Expanded, the phone dock takes 45% of the viewport (Phase 2's clamp) and
  // left the page above it 114px — shorter than one task card. It starts shut.
  const restore = page.locator('[role="button"][title="Restore"]');
  await expect(restore).toBeVisible();
  await expect(page.getByRole('button', { name: 'Session list', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sing-dock-min'))).toBeNull();

  // Opening it here is session-scoped: nothing is written, so the desktop
  // preference is exactly what it was.
  await restore.click();
  await expect(page.getByRole('button', { name: 'Session list', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sing-dock-min'))).toBeNull();

  // A landscape phone (667x375 — tablet by width, shorter than any portrait
  // phone) gets the same treatment.
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/tasks');
  await expect(page.locator('[role="button"][title="Restore"]')).toBeVisible();

  // Desktop is untouched — still expanded on load.
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: 'Minimize dock' })).toBeVisible();
});

// -------------------------------------------------------------- phone pane switch + terminal state

test('the phone dock switches session list ⇄ terminal explicitly, and collapse/expand plus switching preserve each session\'s terminal output', async ({ page }) => {
  test.slow();
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await createSession(page, 'Fixture pane A');
  await createSession(page, 'Fixture pane B'); // B ends up active (most recently created)

  await page.setViewportSize(PHONE);

  const listBtn = page.getByRole('button', { name: 'Session list', exact: true });
  const termBtn = page.getByRole('button', { name: 'Terminal', exact: true });
  const sessionRow = (title) => page.locator('[role="button"]').filter({ hasText: title });
  await expect(listBtn).toBeVisible();
  await expect(termBtn).toBeVisible();
  // No drag affordance at phone, on either axis.
  await expect(listSeparator(page)).toHaveCount(0);
  await expect(dockSeparator(page)).toHaveCount(0);

  // Entering phone mode re-derives the pane from the active session, so the
  // live terminal is what shows — not the list hiding it. (The dock mounts
  // once at desktop, long before B exists, so this can only come from the
  // crossing itself.)
  await expect(termBtn).toHaveAttribute('aria-pressed', 'true');
  // xterm's WebGL renderer draws glyphs to a <canvas> (not DOM text nodes), so
  // scrollback content isn't assertable by text — instead prove "stays
  // mounted" the way it actually matters: the same `.term` host node (xterm
  // never torn down and recreated), never a fresh one. Two agents means two
  // distinct nodes exist throughout; only visibility toggles.
  const termNodeB1 = await page.locator('.term:visible').elementHandle();

  // Switch to the session list — the terminal pane (and B's mounted xterm)
  // just stops being displayed, it does not unmount.
  await listBtn.click();
  await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.term:visible')).toHaveCount(0);
  await expect(page.locator('.term')).toHaveCount(2); // both stay mounted, just hidden
  await expect(sessionRow('Fixture pane A')).toBeVisible();

  // Selecting a different session auto-switches back to the terminal pane.
  await sessionRow('Fixture pane A').click();
  await expect(termBtn).toHaveAttribute('aria-pressed', 'true');
  const termNodeA = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeA, termNodeB1])).toBe(false); // a different node

  // Collapse and expand the whole dock — both mounted terminals must survive
  // (same node, not a fresh mount).
  await page.getByRole('button', { name: 'Minimize dock' }).click();
  await expect(page.locator('.term')).toHaveCount(2);
  await page.locator('[role="button"][title="Restore"]').click();
  const termNodeAAfterCollapse = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeAAfterCollapse, termNodeA])).toBe(true);

  // Back to B — its own terminal node is exactly the one from before the switch.
  await listBtn.click();
  await sessionRow('Fixture pane B').click();
  const termNodeB2 = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeB2, termNodeB1])).toBe(true);
});

// -------------------------------------------------------------- sheets at narrow widths

// TaskDetailPanel already gates its width on `xs`/`sm` (88vw / 400px, see
// TaskDetailPanel.jsx) — this only verifies that holds at phone and tablet:
// no page-level horizontal overflow, and the close/primary actions stay
// reachable, not that the insetQuery threshold logic (untouched) is correct.
for (const [label, viewport] of [['phone', PHONE], ['tablet', TABLET]]) {
  test(`the task detail sheet overlays cleanly at ${label} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/tasks');
    // Phone shows one board lane at a time (responsive plan, Phase 3), so the
    // review card needs its lane selected first; tablet still shows all four.
    if (viewport === PHONE) {
      await page.getByRole('group', { name: 'Board lane', exact: true })
        .getByRole('button', { name: /^In Review \(/ }).click();
    }
    await page.getByRole('button', { name: 'Seeded review card', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Seeded review card' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'View transcript' })).toBeInViewport();
    await expectNoPageOverflow(page);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();
  });
}

// -------------------------------------------------------- 1199/1200 crossing

// The plan's global criteria requires this crossing (route state, unsaved
// hidden-editor content, terminal attachment/scrollback, and the restored
// desktop rail preference — all live, no reload). The exact 1199/1200 edge is
// covered alongside the broad compact-desktop/desktop transition.
test('live 1199/1200 and compact-desktop/desktop crossings preserve a hidden mounted editor, the live terminal, and the rail collapse preference', async ({ page }) => {
  test.slow();
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');

  // A previously-visited, now-hidden editor: reached by clicking through
  // (client-side nav, not page.goto — a goto is a hard reload and would never
  // exercise AppShell's persistent-view mount, display:none when hidden,
  // never unmounted).
  await goto(page, 'Explorer');
  const notes = page.getByRole('button', { name: 'notes.md', exact: true }).first();
  await notes.click();
  await expect(page.locator('.cm-content').first()).toContainText('Explorer fixture markdown.');
  await page.locator('.cm-editor').first().evaluate((el) => { el.dataset.keep = 'yes'; });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/* unsaved */');

  // Back to Tasks (the route the crossing below must preserve), a live
  // session for the mounted-terminal check, and a rail collapse preference
  // toggled here (the active row doubles as the toggle — Phase 1).
  await goto(page, 'Tasks');
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await createSession(page, 'Crossing fixture');
  const termNode = await page.locator('.term:visible').elementHandle();
  // Not exact:true — the expanded rail's active row also carries its task
  // count badge ("Tasks 4"), unlike the collapsed rail the other toggle tests
  // click this same row on.
  await page.locator('aside').getByRole('button', { name: /^Tasks/ }).click();
  // The collapse is CSS-transitioned — poll for the converged width (64px,
  // Sidebar.jsx's fixed collapsed value), not just "< some threshold", which
  // a mid-transition frame can also satisfy and would capture a stale value.
  await expect.poll(() => railWidth(page)).toBe(64);
  const collapsedWidth = await railWidth(page);

  const sameTermNode = async () => {
    const now = await page.locator('.term:visible').elementHandle();
    return page.evaluate(([a, b]) => a === b, [termNode, now]);
  };

  // The exact adjacent edge must retain every mounted/persisted state.
  await page.setViewportSize({ width: 1199, height: COMPACT.height });
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect.poll(() => railWidth(page)).toBe(collapsedWidth);
  expect(await sameTermNode()).toBe(true);
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 1200, height: COMPACT.height });
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect.poll(() => railWidth(page)).toBe(collapsedWidth);
  expect(await sameTermNode()).toBe(true);

  // Keep the existing broader compact-desktop/desktop transition coverage.
  await page.setViewportSize(COMPACT);
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect.poll(() => railWidth(page)).toBe(collapsedWidth);
  expect(await sameTermNode()).toBe(true);

  await page.setViewportSize(DESKTOP);
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect.poll(() => railWidth(page)).toBe(collapsedWidth);
  expect(await sameTermNode()).toBe(true);

  // The hidden explorer editor survived the whole sequence, unsaved content intact.
  await goto(page, 'Explorer');
  const cm = page.locator('.cm-editor').first();
  expect(await cm.getAttribute('data-keep')).toBe('yes');
  await expect(page.locator('.cm-content').first()).toContainText('unsaved');
  await expectNoPageOverflow(page);
});
