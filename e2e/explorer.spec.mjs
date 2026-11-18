// Explorer: file-tree rail + multi-tab CodeMirror editor over the full FS
// (no containment guard — see server/explorer.mjs). Root is pinned to
// EXPLORER_DIR via a seeded state/explorer-state.json (the panel's own
// default root is '~', useless for a test) — see fixtures/seed.mjs.
//
// Unlike Hooks/Rules/Memory/Skills, this panel persists its UI state
// (root/expanded/tabs/active) server-side via a debounced PUT /fs/state,
// restored on every mount — so tabs/expansion left open by one test carry
// into the next; the reload test reads /api/fs/state first to stay
// self-sufficient. Listing, tabs, the dirty-tab guard and search are covered
// by e2e-mock/explorer.
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

  test('reload keeps the already-active tab selected after a stale read completes', async ({ page }) => {
    await gotoView(page, 'Explorer');
    const initialState = await page.evaluate(async () => (await fetch('/api/fs/state')).json());
    for (const path of initialState.state?.tabs || []) await expect(tab(page, path)).toBeVisible();
    if (await tab(page, NOTES).count()) {
      await tab(page, NOTES).locator('button').click();
      const discard = page.getByRole('dialog').getByRole('button', { name: 'Discard' });
      if (await discard.isVisible().catch(() => false)) await discard.click();
      await expect(tab(page, NOTES)).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    await expect(cm(page)).toContainText('explorerFixture');

    let releaseNotes;
    let startedNotes;
    const notesReadStarted = new Promise((resolve) => { startedNotes = resolve; });
    let delayNotes = true;
    const holdNotesRead = async (route) => {
      if (delayNotes) {
        delayNotes = false;
        startedNotes();
        await new Promise((resolve) => { releaseNotes = resolve; });
      }
      await route.continue();
    };
    const notesReadUrl = (url) => url.pathname === '/api/fs/read' && url.searchParams.get('path') === NOTES;
    await page.route(notesReadUrl, holdNotesRead);

    await page.getByRole('button', { name: 'notes.md', exact: true }).click();
    await notesReadStarted;
    // Script is already active: this tap must invalidate Notes' outstanding
    // read even though it has no synchronous active-state change to make.
    const statePut = page.waitForResponse((r) => {
      if (!r.url().endsWith('/fs/state') || r.request().method() !== 'PUT') return false;
      const state = r.request().postDataJSON();
      return state.tabs.includes(NOTES) && state.active === SCRIPT;
    });
    await page.getByRole('button', { name: 'script.mjs', exact: true }).click();
    releaseNotes();
    await expect(tab(page, NOTES)).toBeVisible();
    await expect(cm(page)).toContainText('explorerFixture');
    await statePut;
    await page.unroute(notesReadUrl, holdNotesRead);

    await page.reload();
    await page.getByPlaceholder('Search files…').waitFor({ state: 'visible' });
    await expect(tab(page, NOTES)).toBeVisible();
    await expect(tab(page, SCRIPT)).toBeVisible();
    await expect(cm(page)).toContainText('explorerFixture');
  });
});
