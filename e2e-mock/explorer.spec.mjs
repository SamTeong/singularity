// Explorer: file-tree rail + multi-tab CodeMirror editor over the mock's
// in-memory filesystem. Each test establishes its own tree and tab state.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const cm = (page) => page.locator('.cm-content');
const tab = (page, path) => page.locator(`[title="${path.replace(/[\\"]/g, '\\$&')}"]`);
const row = (page, name) => page.getByRole('button', { name, exact: true });

const NOTES = `${ROOTS.explorer}/notes.md`;
const SCRIPT = `${ROOTS.explorer}/script.mjs`;

test('tree order + lazy expand, tabs switch content, edit + Save reopens with saved content', async ({ page }) => {
  await gotoUrl(page, 'Explorer');

  // Seeded top-level entries incl. the dotfile, dirs before files.
  const rows = page.getByRole('button', { name: /^(subdir|\.hidden|notes\.md|pixel\.png|script\.mjs)$/ });
  await expect(rows).toHaveCount(5);
  expect(await rows.allTextContents()).toEqual(['subdir', '.hidden', 'notes.md', 'pixel.png', 'script.mjs']);

  // Lazy expand: the nested file is absent until its folder is clicked.
  await expect(row(page, 'nested.txt')).toHaveCount(0);
  await row(page, 'subdir').click();
  await expect(row(page, 'nested.txt')).toBeVisible();

  await row(page, 'notes.md').click();
  await expect(tab(page, NOTES)).toContainText('notes.md');
  await expect(cm(page)).toContainText('Explorer fixture markdown.');
  await row(page, 'script.mjs').click();
  await expect(tab(page, NOTES)).toBeVisible();
  await expect(cm(page)).toContainText('explorerFixture');
  await tab(page, NOTES).click();
  await expect(cm(page)).toContainText('Explorer fixture markdown.');
  await tab(page, SCRIPT).click();
  await expect(cm(page)).toContainText('explorerFixture');

  const marker = `e2e-explorer-${Date.now()}`;
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(marker);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await tab(page, SCRIPT).getByRole('button').click();
  await expect(tab(page, SCRIPT)).toHaveCount(0);
  await row(page, 'script.mjs').click();
  await expect(cm(page)).toContainText(marker);
});

test('context menu New File / Delete, and search finds a nested file from a collapsed tree', async ({ page }) => {
  await gotoUrl(page, 'Explorer');

  await row(page, 'notes.md').click({ button: 'right' });
  page.once('dialog', (d) => d.accept('created.txt'));
  await page.getByRole('menuitem', { name: 'New File' }).click();
  await expect(row(page, 'created.txt')).toBeVisible();

  await row(page, 'created.txt').click({ button: 'right' });
  const msg = onceConfirm(page, true);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  expect(await msg).toMatch(/delete/i);
  await expect(row(page, 'created.txt')).toHaveCount(0);

  await expect(row(page, 'nested.txt')).toHaveCount(0);
  await page.getByPlaceholder('Search files…').fill('nested');
  const hit = page.getByRole('button', { name: /nested\.txt/ });
  await hit.click();
  await expect(cm(page)).toContainText('Nested file content.');
  await expect(page.getByPlaceholder('Search files…')).toHaveValue('nested');
});
