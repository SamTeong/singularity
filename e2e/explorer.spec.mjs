// Explorer: file-tree rail + multi-tab CodeMirror editor over the full FS
// (no containment guard — see server/explorer.mjs). Root is pinned to
// EXPLORER_DIR via a seeded state/explorer-state.json (the panel's own
// default root is '~', useless for a test) — see fixtures/seed.mjs.
//
// Unlike Hooks/Rules/Memory/Skills, this panel persists its UI state
// (root/expanded/tabs/active) server-side via a debounced PUT /fs/state,
// restored on every mount — so tests in this file are deliberately ordered:
// later tests build on tabs/expansion left open by earlier ones, the same
// way a real user's session would carry state across a reload.
//
// Not covered: the image/binary/toolarge panes (no assertion-worthy behavior
// beyond "shows a placeholder") and autosave's 5s timer (not worth a
// wall-clock wait in an e2e test).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { EXPLORER_DIR } from './fixtures/paths.mjs';

const cm = (page) => page.locator('.cm-content');

// Tab strip rows key off the full path as their `title` attribute (basename
// alone collides with the tree row of the same name) — escape it for use in
// a CSS attribute selector, since Windows paths carry literal backslashes.
const escAttr = (s) => s.replace(/[\\"]/g, '\\$&');
const tab = (page, path) => page.locator(`[title="${escAttr(path)}"]`);

const NOTES = join(EXPLORER_DIR, 'notes.md');
const SCRIPT = join(EXPLORER_DIR, 'script.mjs');

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

  test('editing and saving a file writes the new bytes to disk', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(cm(page)).toContainText('explorerFixture');

    const marker = `e2e-explorer-${Date.now()}`;
    await cm(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(marker);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/fs/write') && r.request().method() === 'PUT'),
      // exact: true — the autosave toggle's aria-label ("Autosave off") contains
      // "Save" as a substring and would otherwise match too.
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect((await resp.json()).ok).toBe(true);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    expect(readFileSync(SCRIPT, 'utf8')).toContain(marker);
  });

  test('closing a dirty tab prompts to discard, then removes it', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    await cm(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('unsaved edit');

    const msg = onceConfirm(page, true);
    await tab(page, NOTES).locator('button').click();
    expect(await msg).toMatch(/discard/i);
    await expect(tab(page, NOTES)).toHaveCount(0);
  });

  test('context menu New File creates it on disk; Delete removes it', async ({ page }) => {
    await gotoView(page, 'Explorer');
    const created = join(EXPLORER_DIR, 'created.txt');

    await page.getByRole('button', { name: 'notes.md', exact: true }).click({ button: 'right' });
    page.once('dialog', (d) => d.accept('created.txt'));
    await page.getByRole('menuitem', { name: 'New File' }).click();
    await expect(page.getByRole('button', { name: 'created.txt', exact: true })).toBeVisible();
    expect(existsSync(created)).toBe(true);

    await page.getByRole('button', { name: 'created.txt', exact: true }).click({ button: 'right' });
    const msg = onceConfirm(page, true);
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    expect(await msg).toMatch(/delete/i);
    await expect(page.getByRole('button', { name: 'created.txt', exact: true })).toHaveCount(0);
    expect(existsSync(created)).toBe(false);
  });

  test('reload restores the open tabs and the active tab', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    // Register before the state-changing click below — the debounced
    // PUT /fs/state fires 400ms after the last change, so the listener must
    // already be attached when it does.
    const statePut = page.waitForResponse((r) => r.url().endsWith('/fs/state') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(tab(page, SCRIPT)).toBeVisible();
    await statePut;

    await page.reload();
    await page.getByPlaceholder('Search files…').waitFor({ state: 'visible' });
    await expect(tab(page, NOTES)).toBeVisible();
    await expect(tab(page, SCRIPT)).toBeVisible();
    await expect(cm(page)).toContainText('explorerFixture');
  });

  // Search is server-side and recursive (GET /fs/search), unlike Hooks/Rules/
  // Memory/Skills' client-side filter over the already-loaded tree — the case
  // that behavior can't handle is a match inside a folder that's never been
  // expanded. Force a collapsed starting point (toggleAll always collapses,
  // regardless of its current Collapse-all/Expand-all label) so this doesn't
  // depend on whichever expand state an earlier test left behind.
  test('search finds a nested file by name from a collapsed tree', async ({ page }) => {
    await gotoView(page, 'Explorer');
    await page.getByRole('button', { name: /Collapse all|Expand all/ }).click();
    await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toHaveCount(0);

    await page.getByPlaceholder('Search files…').fill('nested');
    const hit = page.getByRole('button', { name: /nested\.txt/ });
    await expect(hit).toBeVisible();

    await hit.click();
    await expect(cm(page)).toContainText('Nested file content.');
    // Unlike a folder hit (which expands the chain and clears the box), a file
    // hit just opens the tab — the search box is left as-is.
    await expect(page.getByPlaceholder('Search files…')).toHaveValue('nested');
  });
});
