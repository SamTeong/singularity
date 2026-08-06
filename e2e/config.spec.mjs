// Config editor: settings.json / settings.local.json for a picked cwd.
// ConfigEditor defaults its `cwd` state to '~' (the real OS home, resolved by
// untildify — see web/src/lib/paths.js), so every test here starts by
// clicking the seeded WORKSPACE_DIR row in the rail before touching anything,
// keeping all reads/writes inside the sandbox.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { WORKSPACE_DIR } from './fixtures/paths.mjs';

const SETTINGS_PATH = join(WORKSPACE_DIR, '.claude', 'settings.json');
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pickWorkspaceRoot(page) {
  await gotoView(page, 'Config');
  await page.getByText(WORKSPACE_DIR, { exact: false }).first().click();
  await expect(page.getByRole('tab', { name: 'settings.json' })).toBeVisible();
}

// Clear the editor and insert text as one op. keyboard.insertText (vs. .type,
// which sends real per-character key events) is both far faster and immune to
// CodeMirror's default closeBrackets (basicSetup, on by default for
// @uiw/react-codemirror): closeBrackets only auto-pairs single-character
// keystrokes, so a whole-string insert lands byte-for-byte as given.
//
// ControlOrMeta, not Control: select-all is CodeMirror's `Mod-a`, and Mod is Cmd
// on macOS — where a literal Ctrl-A is instead bound to cursorLineStart
// (standardKeymap's emacs-style mac bindings). With plain Control+A this
// prepended to the loaded settings instead of replacing them, so the result was
// invalid JSON and Save stayed disabled.
async function replaceContent(page, text) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

test('the two scope tabs load settings.json (project) and settings.local.json (local)', async ({ page }) => {
  await pickWorkspaceRoot(page);

  // Default tab is project scope — seeded settings.json.
  await expect(cm(page)).toContainText('Bash(git status)');

  await page.getByRole('tab', { name: 'settings.local.json' }).click();
  await expect(cm(page)).toContainText('"local"');
  await expect(cm(page)).not.toContainText('Bash(git status)');

  await page.getByRole('tab', { name: 'settings.json' }).click();
  await expect(cm(page)).toContainText('Bash(git status)');
});

test('typing invalid JSON shows the inline error and disables Save', async ({ page }) => {
  await pickWorkspaceRoot(page);
  await replaceContent(page, 'this is definitely not json');

  await expect(page.getByText(/isn't valid JSON/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('a valid Save writes settings.json and leaves a backup on disk', async ({ page }) => {
  await pickWorkspaceRoot(page);
  const marker = uniq('e2e-config-project');
  await replaceContent(page, JSON.stringify({ e2eMarker: marker }));
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/project') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.backup).toBeTruthy();
  // Not asserting the "Saved" message here: ConfigEditor's save() immediately
  // re-triggers load(), whose own .then() unconditionally does setMsg(null) —
  // so the success text is a same-tick flash, not a stable state. The Save
  // button re-disabling (dirty cleared, and it stays cleared through the
  // reload) is the reliable, non-racy signal that the round trip completed.
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  expect(readFileSync(SETTINGS_PATH, 'utf8')).toContain(marker);
  expect(existsSync(body.backup)).toBe(true);
});

test('POST /config/search surfaces a hit via the rail search box', async ({ page }) => {
  await pickWorkspaceRoot(page);
  // Write a fresh marker into the LOCAL scope first, so this test doesn't
  // depend on any other test's writes — then search for that exact marker.
  const marker = uniq('e2e-config-search');
  await page.getByRole('tab', { name: 'settings.local.json' }).click();
  await replaceContent(page, JSON.stringify({ e2eSearchMarker: marker }));
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/local') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.getByPlaceholder('Search config…').fill(marker);
  const hit = page.getByRole('button', { name: new RegExp(`${marker}`) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('settings.local.json');
});

test('"Remove from list" removes the root from the rail', async ({ page }) => {
  await gotoView(page, 'Config');
  // ConfigEditor's own mount-time load('~') remembers the real OS home too
  // (see paths.js untildify), so the rail can show a second "~" row besides
  // the seeded WORKSPACE_DIR one — scope the remove click to WORKSPACE_DIR's
  // row specifically rather than a bare "Remove from list" role query.
  const row = page.getByRole('button', { name: WORKSPACE_DIR, exact: false });
  await expect(row).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/roots') && r.request().method() === 'PUT'),
    row.getByLabel('Remove from list').click(),
  ]);

  // Note: this does not empty the rail — ConfigEditor's own mount-time
  // load('~') re-remembers the real OS home on every visit (see the comment
  // above), so a "~" row reappears regardless. What's provable is that OUR
  // seeded root is specifically gone.
  await expect(page.getByText(WORKSPACE_DIR, { exact: false })).toHaveCount(0);
  await expect(page.getByText('~', { exact: true })).toBeVisible();
});
