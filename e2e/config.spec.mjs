// Config editor: tree-by-root rail (settings.json / settings.local.json under
// .claude, config.toml under .codex) + multi-tab CodeMirror editor. The rail
// is seeded with WORKSPACE_DIR in both config-roots + codex-config-roots, and
// .claude/settings{,.local}.json + .codex/config.toml on disk, so the test
// expands that root and opens file leaves from there — keeping all reads/writes
// inside the sandbox. Tabs, client validation, search and root removal are
// covered by e2e-mock/config.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { WORKSPACE_DIR } from './fixtures/paths.mjs';

const SETTINGS_PATH = join(WORKSPACE_DIR, '.claude', 'settings.json');
const CODEX_PATH = join(WORKSPACE_DIR, '.codex', 'config.toml');
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

test('a valid Save writes settings.json and leaves a backup on disk', async ({ page }) => {
  await gotoView(page, 'Config');
  // Expand the seeded root — idempotent: /config/state persists on the daemon,
  // so the root may already be open, and clicking it again would COLLAPSE it.
  // The '.claude' group label renders only while the Collapse is open.
  const group = page.getByText('.claude', { exact: true });
  if (!(await group.isVisible().catch(() => false))) await page.getByRole('button', { name: WORKSPACE_DIR, exact: false }).click();
  await expect(group).toBeVisible();

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

  // The codex config.toml saves through its own route, /codex-config/project.
  await page.getByRole('button', { name: 'config.toml', exact: true }).click();
  await expect(cm(page)).toContainText('gpt-5.2');

  const codexMarker = uniq('e2e-codex-model');
  await replaceContent(page, `model = "${codexMarker}"\n`);
  const [codexResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/codex-config/project') && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect((await codexResp.json()).ok).toBe(true);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(readFileSync(CODEX_PATH, 'utf8')).toContain(codexMarker);
});
