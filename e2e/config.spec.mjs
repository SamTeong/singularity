// Config editor: tree-by-root rail (settings.json / settings.local.json under
// .claude, config.toml under .codex) + multi-tab CodeMirror editor. The rail
// is seeded with WORKSPACE_DIR in both config-roots + codex-config-roots, and
// .claude/settings{,.local}.json + .codex/config.toml on disk, so every test
// expands that root and opens a file leaf from there — keeping all reads/writes
// inside the sandbox.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { WORKSPACE_DIR } from './fixtures/paths.mjs';

const SETTINGS_PATH = join(WORKSPACE_DIR, '.claude', 'settings.json');
const CODEX_PATH = join(WORKSPACE_DIR, '.codex', 'config.toml');
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Expand the seeded WORKSPACE_DIR root in the rail — idempotent. /config/state
// persists across tests (one sandbox daemon per run), so a prior test may have
// left the root expanded; clicking the row again would COLLAPSE it. Gate the
// click on the '.claude' group label (rendered only while the Collapse is open)
// and wait for it visible either way.
async function expandRoot(page) {
  await gotoView(page, 'Config');
  const root = page.getByRole('button', { name: WORKSPACE_DIR, exact: false });
  const group = page.getByText('.claude', { exact: true });
  if (!(await group.isVisible().catch(() => false))) await root.click();
  await expect(group).toBeVisible();
}

// Clear the editor and insert text as one op. keyboard.insertText (vs. .type,
// which sends real per-character key events) is both far faster and immune to
// CodeMirror's default closeBrackets (basicSetup, on by default for
// @uiw/react-codemirror): closeBrackets only auto-pairs single-character
// keystrokes, so a whole-string insert lands byte-for-byte as given.
async function replaceContent(page, text) {
  await cm(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

test('opening settings.json (project) and settings.local.json (local) switches tabs', async ({ page }) => {
  await expandRoot(page);

  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(cm(page)).toContainText('Bash(git status)');

  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  await expect(cm(page)).toContainText('"local"');
  await expect(cm(page)).not.toContainText('Bash(git status)');

  // Back to project — content is preserved per-tab, not reloaded from the leaf.
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(cm(page)).toContainText('Bash(git status)');
});

test('typing invalid JSON shows the inline error and disables Save', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await replaceContent(page, 'this is definitely not json');

  await expect(page.getByText(/isn't valid JSON/)).toBeVisible();
  // exact: 'Save' is a substring of the "Autosave off" icon button's name.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('a valid Save writes settings.json and leaves a backup on disk', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  const marker = uniq('e2e-config-project');
  await replaceContent(page, JSON.stringify({ e2eMarker: marker }));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/project') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.backup).toBeTruthy();
  // The Save button re-disabling (dirty cleared) is the reliable, non-racy
  // signal that the round trip completed.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  expect(readFileSync(SETTINGS_PATH, 'utf8')).toContain(marker);
  expect(existsSync(body.backup)).toBe(true);
});

test('POST /config/search surfaces a hit via the rail search box', async ({ page }) => {
  await expandRoot(page);
  // Write a fresh marker into the LOCAL scope first, so this test doesn't
  // depend on any other test's writes — then search for that exact marker.
  const marker = uniq('e2e-config-search');
  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  await replaceContent(page, JSON.stringify({ e2eSearchMarker: marker }));
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/local') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await page.getByPlaceholder('Search config…').fill(marker);
  const hit = page.getByRole('button', { name: new RegExp(`${marker}`) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('settings.local.json');
});

test('codex config.toml opens under .codex and saves via /codex-config/project', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'config.toml', exact: true }).click();
  await expect(cm(page)).toContainText('gpt-5.2');

  const marker = uniq('e2e-codex-model');
  await replaceContent(page, `model = "${marker}"\n`);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/codex-config/project') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(readFileSync(CODEX_PATH, 'utf8')).toContain(marker);
});

test('"Remove from list" removes the root from the rail', async ({ page }) => {
  await expandRoot(page);
  const row = page.getByRole('button', { name: WORKSPACE_DIR, exact: false });
  await expect(row).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/config/roots') && r.request().method() === 'PUT'),
    row.getByLabel('Remove from list').click(),
  ]);

  // forget() drops the root from BOTH config-roots and codex-config-roots, and
  // nothing re-adds it (no mount-time load('~') anymore), so the rail empties.
  // The still-open tab's path line keeps the workspace text, so assert on the
  // root *button* (role=button) being gone, not on the bare text.
  await expect(page.getByRole('button', { name: WORKSPACE_DIR, exact: false })).toHaveCount(0);
  await expect(page.getByText('No config paths.')).toBeVisible();
});