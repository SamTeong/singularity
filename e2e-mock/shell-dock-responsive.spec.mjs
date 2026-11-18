// Phone session dock: opens collapsed without writing a desktop default, and
// the single-pane list/terminal switch keeps each session's mounted terminal.
// Sets its own viewport, so it runs in the default project.
import { test, expect } from './fixtures/test.mjs';
import { RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;                   // 375x667
const LANDSCAPE_PHONE = RESPONSIVE_VIEWPORTS.landscapePhone; // 667x375
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;               // 1440x900

const listSeparator = (page) => page.getByRole('separator', { name: 'Resize session list' });
const dockSeparator = (page) => page.getByRole('separator', { name: 'Resize terminal dock' });

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

test('phone dock opens collapsed; list ⇄ terminal switch and collapse keep each session\'s terminal node', async ({ page }) => {
  test.slow();
  const restore = page.locator('[role="button"][title="Restore"]');
  const dockMin = () => page.evaluate(() => localStorage.getItem('sing-dock-min'));

  // Phone and landscape phone open collapsed; expanding there writes nothing.
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');
  await expect(restore).toBeVisible();
  await expect(page.getByRole('button', { name: 'Session list', exact: true })).toHaveCount(0);
  await restore.click();
  await expect(page.getByRole('button', { name: 'Session list', exact: true })).toBeVisible();
  expect(await dockMin()).toBeNull();
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/tasks');
  await expect(restore).toBeVisible();

  // Desktop is untouched: still expanded on load.
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: 'Minimize dock' })).toBeVisible();
  await createSession(page, 'Fixture pane A');
  await createSession(page, 'Fixture pane B'); // B ends up active

  await page.setViewportSize(PHONE);
  const listBtn = page.getByRole('button', { name: 'Session list', exact: true });
  const termBtn = page.getByRole('button', { name: 'Terminal', exact: true });
  const sessionRow = (title) => page.locator('[role="button"]').filter({ hasText: title });
  await expect(listBtn).toBeVisible();
  await expect(listSeparator(page)).toHaveCount(0);
  await expect(dockSeparator(page)).toHaveCount(0);
  // The crossing re-derives the pane from the active session.
  await expect(termBtn).toHaveAttribute('aria-pressed', 'true');
  // xterm paints to a canvas, so "stays mounted" is proven by node identity.
  const termNodeB1 = await page.locator('.term:visible').elementHandle();

  await listBtn.click();
  await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.term:visible')).toHaveCount(0);
  await expect(page.locator('.term')).toHaveCount(2);

  await sessionRow('Fixture pane A').click();
  await expect(termBtn).toHaveAttribute('aria-pressed', 'true');
  const termNodeA = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeA, termNodeB1])).toBe(false);

  await page.getByRole('button', { name: 'Minimize dock' }).click();
  await expect(page.locator('.term')).toHaveCount(2);
  await restore.click();
  const termNodeAAfterCollapse = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeAAfterCollapse, termNodeA])).toBe(true);

  await listBtn.click();
  await sessionRow('Fixture pane B').click();
  const termNodeB2 = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [termNodeB2, termNodeB1])).toBe(true);
});
