// New session dialog's folder browser against the real daemon FS listing: the
// daemon resolves `~` and `..` against the sandbox HOME. Cancel-only, never
// submitted — New session is a real claude spawn and ensureTrusted writes the
// user's real ~/.claude.json. Dialog mechanics are covered by
// e2e-mock/create-dialogs.
import { test, expect } from './fixtures/test.mjs';

test('New session dialog: Browse opens the folder browser; picking a directory updates the cwd field', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });

  const cwdField = dialog.getByLabel('working directory');
  await expect(cwdField).toHaveValue('~'); // default cwd

  await dialog.getByRole('button', { name: 'Browse' }).click();
  const dirPicker = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Go' }) });
  await expect(dirPicker).toBeVisible();

  // Navigate to the parent of the home dir (always present — a home dir is
  // never a filesystem root) and pick it: a real, deterministic change away
  // from the '~' default that doesn't depend on what happens to be in $HOME.
  await dirPicker.getByRole('button', { name: '..', exact: true }).click();
  await dirPicker.getByRole('button', { name: 'Select', exact: true }).click();

  await expect(page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Go' }) })).toHaveCount(0);
  await expect(cwdField).not.toHaveValue('~');

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
