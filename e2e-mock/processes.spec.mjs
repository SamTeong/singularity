import { test, expect } from './fixtures/test.mjs';
import { openMenu } from '../e2e/helpers/nav.mjs';

// The "daemon" kind pill has to be matched INSIDE the table: getByText's default
// is a case-insensitive substring match, and the sidebar footer renders "Daemon
// connected" — an unscoped getByText('daemon').first() resolves to that instead,
// which has no ancestor <tr>. Scope every daemon query to the row.
const daemonRow = (page) => page.locator('table tr').filter({ has: page.getByText('daemon', { exact: true }) }).first();

test('More menu -> Processes: table, protected daemon row, Refresh, Close', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();
  await expect(page.getByText('Running Processes')).toBeVisible();

  for (const name of ['Process ID', 'Name', 'Type', 'Stop']) {
    await expect(page.getByRole('columnheader', { name })).toBeVisible();
  }

  // The mock always supplies one protected `daemon` row; its kill button is
  // disabled. Structural only, so mock live-agent rows can be added later.
  await expect(daemonRow(page)).toBeVisible();
  await expect(daemonRow(page).getByRole('button').first()).toBeDisabled();

  await expect(page.getByRole('button', { name: 'Refresh list' })).toBeEnabled();

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Running Processes')).not.toBeVisible();
});
