import { test, expect } from './fixtures/test.mjs';
import { openMenu } from './helpers/nav.mjs';

// The "daemon" kind pill has to be matched INSIDE the table: getByText's default
// is a case-insensitive substring match, and the sidebar footer renders "Daemon
// connected" — an unscoped getByText('daemon').first() resolves to that instead,
// which has no ancestor <tr>. Scope every daemon query to the row.
const daemonRow = (page) => page.locator('table tr').filter({ has: page.getByText('daemon', { exact: true }) }).first();

test('Processes table structure renders and daemon process exists', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Table should be visible
  const table = page.locator('table');
  await expect(table).toBeVisible();

  // At least one `daemon` row — /procs scans the real machine, so a parallel
  // sandbox run (E2E_PORT) puts several daemons in this table. Never assert a count.
  await expect(daemonRow(page)).toBeVisible();

  // The real scan classifies the row as daemon, so its kill button is disabled.
  await expect(daemonRow(page).getByRole('button').first()).toBeDisabled();
});
