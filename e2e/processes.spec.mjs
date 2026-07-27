import { test, expect } from './fixtures/test.mjs';
import { openMenu } from './helpers/nav.mjs';

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
  await expect(page.getByText('daemon').first()).toBeVisible();
});

test('Daemon process row kill button is disabled (never stops daemon)', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Processes' }).click();

  // Find daemon text and locate its close/kill button
  const daemonText = page.getByText('daemon').first();
  const tr = daemonText.locator('xpath=ancestor::tr');

  // The button in the "Stop" column of daemon row should be disabled
  const buttons = tr.getByRole('button');
  const killButton = buttons.first();

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
