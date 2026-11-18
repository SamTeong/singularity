// Phosphor Console shell smoke: the skin renders its own console grammar, not
// just "does not crash" (responsive.spec.mjs covers every view under both skins).
// ORANGE and the 3px frame come from the vendored `phosphor-console-theme`
// tokens and `web/src/theme/skins/phosphor.roles.js`.
import { test, expect } from './fixtures/test.mjs';
import { openMenu } from '../e2e/helpers/nav.mjs';
import { seedSkin } from './helpers/responsive.mjs';

const ORANGE = 'rgb(242, 100, 0)';

test('frame, CRT layer, bilingual nav and live-data masthead render the console grammar', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  await page.goto('/tasks');

  const masthead = page.getByRole('banner');
  await expect(masthead).toBeVisible();
  await expect(masthead.getByText('FLEET CONTROL PLANE')).toBeVisible();
  await expect(masthead.getByText('SINGULARITY')).toBeVisible();

  // PhosphorFrame's Box is the masthead's immediate parent (AppShell.jsx).
  const frameStyle = await masthead.locator('xpath=..').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor, backdrop: cs.backdropFilter, shadow: cs.boxShadow };
  });
  expect(frameStyle).toMatchObject({ width: '3px', style: 'solid', color: ORANGE, backdrop: 'none' });
  expect(frameStyle.shadow).not.toBe('none');

  // CRT pass: one fixed, non-interactive `body::before` layer.
  const crt = await page.evaluate(() => {
    const cs = getComputedStyle(document.body, '::before');
    return { content: cs.content, position: cs.position, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex };
  });
  expect(crt.content).not.toBe('none');
  expect(crt).toMatchObject({ position: 'fixed', pointerEvents: 'none', zIndex: '1' });

  // Bilingual nav: the aria-hidden kanji is visible, the accessible name stays English.
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText('任務', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Tasks' })).toHaveAccessibleName(/^Tasks\b/);
  await expect(sidebar.getByText('新規', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New session', exact: true })).toHaveAccessibleName('New session');

  // Live data only: no fabricated telemetry; the connection stamp is the sidebar's.
  await expect(masthead.getByText(/DAEMON:CONNECTED|AGENTS/)).toHaveCount(0);
  await expect(page.getByText(/SYS:NOMINAL|DAEMON LOAD|EX_MODE|PRIORITY:/)).toHaveCount(0);
  await expect(sidebar.getByText('DAEMON CONNECTED', { exact: true })).toBeVisible();

  await openMenu(page);
  await expect(page.getByRole('menu').getByText('設定', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Config', exact: true })).toHaveAccessibleName('Config');
  await page.keyboard.press('Escape');
});
