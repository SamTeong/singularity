// Targeted iPhone Safari WebKit emulation. This is browser emulation only;
// physical iPhone coverage remains outside this mock suite.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';

async function createSession(page, title) {
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await page.getByRole('dialog', { name: 'Navigation' })
    .getByRole('button', { name: 'New session', exact: true }).tap();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('title (optional)').fill(title);
  await dialog.getByLabel('model', { exact: true }).fill('sonnet');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Create', exact: true }).tap();
  await expect(dialog).toBeHidden();
}

test('iPhone Safari emulation: touch drawer navigation reaches a phone route', async ({ page }) => {
  expect(await page.evaluate(() => navigator.userAgent)).toContain('iPhone');
  expect(page.viewportSize()).toEqual({ width: 390, height: 664 });
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Open navigation' }).tap();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Usage', exact: true }).tap();
  await expect(page).toHaveURL(/\/usage(\?|$)/);
  await expect(drawer).toBeHidden();
  await expectNoPageOverflow(page);
});

test('iPhone Safari emulation: touch-operated dock keeps its terminal pane', async ({ page }) => {
  await page.goto('/tasks');
  await createSession(page, 'WebKit phone session');

  const restore = page.locator('[role="button"][title="Restore"]');
  if (await restore.isVisible()) await restore.tap();
  const list = page.getByRole('button', { name: 'Session list', exact: true });
  const terminal = page.getByRole('button', { name: 'Terminal', exact: true });
  await expect(list).toBeVisible();
  await expect(terminal).toBeVisible();
  await terminal.tap();
  await expect(terminal).toHaveAttribute('aria-pressed', 'true');
  const terminalNode = await page.locator('.term:visible').elementHandle();
  await list.tap();
  await expect(page.locator('.term:visible')).toHaveCount(0);
  await terminal.tap();
  await expect(page.locator('.term:visible')).toHaveCount(1);
  const restoredTerminalNode = await page.locator('.term:visible').elementHandle();
  expect(await page.evaluate(([before, after]) => before === after, [terminalNode, restoredTerminalNode])).toBe(true);
  await expectNoPageOverflow(page);
});

test('iPhone Safari emulation: task-history actions remain reachable by bounded horizontal scrolling', async ({ page }) => {
  await page.goto('/tasks?history=1');

  const region = page.getByRole('region', { name: 'Task history (scrolls horizontally)' });
  await expect(region).toBeVisible();
  expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const remove = page.locator('tr').filter({ hasText: 'Concluded fixture run' })
    .getByRole('button', { name: 'Delete permanently' });
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeInViewport();
  expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expectNoPageOverflow(page);
});
