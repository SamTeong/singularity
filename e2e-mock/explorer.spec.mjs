// Explorer: file-tree rail + multi-tab CodeMirror editor over the mock's
// in-memory filesystem. Each test establishes its own tree and tab state.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const cm = (page) => page.locator('.cm-content');
const escAttr = (s) => s.replace(/[\\"]/g, '\\$&');
const tab = (page, path) => page.locator(`[title="${escAttr(path)}"]`);

const NOTES = `${ROOTS.explorer}/notes.md`;
const SCRIPT = `${ROOTS.explorer}/script.mjs`;

test.describe('Explorer', () => {
  test('rail lists the seeded top-level entries incl. the dotfile, dirs before files', async ({ page }) => {
    await gotoView(page, 'Explorer');
    const rows = page.getByRole('button', { name: /^(subdir|\.hidden|notes\.md|pixel\.png|script\.mjs)$/ });
    await expect(rows).toHaveCount(5);
    expect(await rows.allTextContents()).toEqual(['subdir', '.hidden', 'notes.md', 'pixel.png', 'script.mjs']);
  });

  test('lazy expand: the nested file is absent until its folder is clicked', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'subdir', exact: true }).click();
    await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toBeVisible();
  });

  test('clicking a file opens a tab and loads its content into the editor', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    await expect(tab(page, NOTES)).toContainText('notes.md');
    await expect(cm(page)).toContainText('Explorer fixture markdown.');
  });

  test('opening a second file adds a tab; clicking the first tab switches content back', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(tab(page, NOTES)).toBeVisible();
    await expect(tab(page, SCRIPT)).toBeVisible();
    await expect(cm(page)).toContainText('explorerFixture');

    await tab(page, NOTES).click();
    await expect(cm(page)).toContainText('Explorer fixture markdown.');
  });

  test('editing and saving a file reopens it with the saved content', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(cm(page)).toContainText('explorerFixture');

    const marker = `e2e-explorer-${Date.now()}`;
    await cm(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(marker);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await tab(page, SCRIPT).getByRole('button').click();
    await expect(tab(page, SCRIPT)).toHaveCount(0);
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(cm(page)).toContainText(marker);
  });

  test('closing a dirty tab prompts to discard, then removes it', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    await cm(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('unsaved edit');

    await tab(page, NOTES).getByRole('button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(tab(page, NOTES)).toHaveCount(0);
  });

  test('context menu New File creates it in the tree; Delete removes it', async ({ page }) => {
    await gotoView(page, 'Explorer');

    await page.getByRole('button', { name: 'notes.md', exact: true }).click({ button: 'right' });
    page.once('dialog', (d) => d.accept('created.txt'));
    await page.getByRole('menuitem', { name: 'New File' }).click();
    await expect(page.getByRole('button', { name: 'created.txt', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'created.txt', exact: true }).click({ button: 'right' });
    const msg = onceConfirm(page, true);
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    expect(await msg).toMatch(/delete/i);
    await expect(page.getByRole('button', { name: 'created.txt', exact: true })).toHaveCount(0);
  });

  test('failed tree mutations alert and preserve the tree', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = init.method || (typeof input === 'string' ? 'GET' : input.method);
        if (window.__explorerMutationFailure === 'create' && method === 'POST' && url.includes('/api/fs/entry')) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'create failed' }), { status: 400, headers: { 'content-type': 'application/json' } }));
        }
        if (window.__explorerMutationFailure === 'rename' && method === 'PATCH' && url.includes('/api/fs/rename')) {
          return Promise.resolve(new Response('broken', { status: 500, headers: { 'content-type': 'text/plain' } }));
        }
        if (window.__explorerMutationFailure === 'delete' && method === 'DELETE' && url.includes('/api/fs/entry')) return Promise.reject(new TypeError('failed'));
        return originalFetch(input, init);
      };
    });

    await page.evaluate(() => { window.__explorerMutationFailure = 'create'; });
    await page.getByRole('button', { name: 'notes.md', exact: true }).click({ button: 'right' });
    page.once('dialog', (d) => d.accept('failed.txt'));
    const createError = page.waitForEvent('dialog', (d) => d.type() === 'alert');
    const createClick = page.getByRole('menuitem', { name: 'New File' }).click();
    const createAlert = await createError;
    expect(createAlert.message()).toBe('create failed');
    await createAlert.accept();
    await createClick;
    await expect(page.getByRole('button', { name: 'failed.txt', exact: true })).toHaveCount(0);

    await page.evaluate(() => { window.__explorerMutationFailure = 'rename'; });
    await page.getByRole('button', { name: 'notes.md', exact: true }).click({ button: 'right' });
    page.once('dialog', (d) => d.accept('renamed.md'));
    const renameError = page.waitForEvent('dialog', (d) => d.type() === 'alert');
    const renameClick = page.getByRole('menuitem', { name: 'Rename' }).click();
    const renameAlert = await renameError;
    expect(renameAlert.message()).toBe('Request failed (500)');
    await renameAlert.accept();
    await renameClick;
    await expect(page.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'renamed.md', exact: true })).toHaveCount(0);

    await page.evaluate(() => { window.__explorerMutationFailure = 'delete'; });
    await page.getByRole('button', { name: 'notes.md', exact: true }).click({ button: 'right' });
    const confirm = onceConfirm(page, true);
    const deleteError = page.waitForEvent('dialog', (d) => d.type() === 'alert');
    const deleteClick = page.getByRole('menuitem', { name: 'Delete' }).click();
    await confirm;
    const deleteAlert = await deleteError;
    expect(deleteAlert.message()).toBe('Request failed');
    await deleteAlert.accept();
    await deleteClick;
    await expect(page.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
  });

  test('reload resets Explorer content and tabs to the seeded baseline', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(tab(page, SCRIPT)).toBeVisible();

    const marker = `e2e-explorer-reset-${Date.now()}`;
    await cm(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(marker);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.reload();
    await page.getByPlaceholder('Search files…').waitFor({ state: 'visible' });
    await expect(tab(page, SCRIPT)).toHaveCount(0);
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(cm(page)).toContainText('explorerFixture');
    await expect(cm(page)).not.toContainText(marker);
  });

  test('search finds a nested file by name from a collapsed tree', async ({ page }) => {
    await gotoView(page, 'Explorer');
    const nested = page.getByRole('button', { name: 'nested.txt', exact: true });
    if ((await nested.count()) > 0) {
      await page.getByRole('button', { name: 'subdir', exact: true }).click();
    }
    await expect(nested).toHaveCount(0);

    await page.getByPlaceholder('Search files…').fill('nested');
    const hit = page.getByRole('button', { name: /nested\.txt/ });
    await expect(hit).toBeVisible();

    await hit.click();
    await expect(cm(page)).toContainText('Nested file content.');
    await expect(page.getByPlaceholder('Search files…')).toHaveValue('nested');
  });
});
