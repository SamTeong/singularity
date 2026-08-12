import { test, expect } from './fixtures/test.mjs';
import { openMenu } from './helpers/nav.mjs';

// The "daemon" kind pill has to be matched INSIDE the table: getByText's default
// is a case-insensitive substring match, and the sidebar footer renders "Daemon
// connected" — an unscoped getByText('daemon').first() resolves to that instead,
// which has no ancestor <tr>. Scope every daemon query to the row.
const daemonRow = (page) => page.locator('table tr').filter({ has: page.getByText('daemon', { exact: true }) }).first();

test('More menu -> Processes opens the "Running Processes" dialog', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Dialog opens with title "Running Processes"
  await expect(page.getByText('Running Processes')).toBeVisible();
});

test('Processes dialog displays table with required headers', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Table headers must be present: Process ID, Name, Type, Stop
  await expect(page.getByRole('columnheader', { name: 'Process ID' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Type' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Stop' })).toBeVisible();
});

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
});

test('Daemon process row kill button is disabled (never stops daemon)', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // The button in the "Stop" column of the daemon row should be disabled
  const killButton = daemonRow(page).getByRole('button').first();

  // Daemon row kill button is disabled (cannot stop daemon)
  await expect(killButton).toBeDisabled();
});

test('Dialog Close button closes the Processes dialog', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Dialog is open
  await expect(page.getByText('Running Processes')).toBeVisible();

  // Click Close button
  await page.getByRole('button', { name: 'Close' }).click();

  // Dialog closes
  await expect(page.getByText('Running Processes')).not.toBeVisible();
});

test('Refresh button is visible and clickable in dialog header', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Dialog opens
  await expect(page.getByText('Running Processes')).toBeVisible();

  // Refresh button is present and enabled (icon button with tooltip)
  const refreshButton = page.getByRole('button', { name: 'Refresh list' });
  await expect(refreshButton).toBeVisible();
  await expect(refreshButton).toBeEnabled();
});
