// Config editor: tree-by-root rail (settings.json / settings.local.json under
// .claude, config.toml under .codex) + multi-tab CodeMirror editor.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const SETTINGS_PATH = `${ROOTS.workspace}/.claude/settings.json`;
const WORKSPACE_LABEL = '~/workspace';
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const tab = (page, path) => page.locator(`[title="${path.replace(/[\\"]/g, '\\$&')}"]`);

async function replaceContent(page, text) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

test('tabs switch files, invalid JSON blocks Save, a valid Save reopens, rail search finds it', async ({ page }) => {
  await gotoUrl(page, 'Config');
  const group = page.getByText('.claude', { exact: true });
  if (!(await group.isVisible().catch(() => false))) await page.getByRole('button', { name: WORKSPACE_LABEL, exact: false }).click();
  await expect(group).toBeVisible();

  const settings = page.getByRole('button', { name: 'settings.json', exact: true });
  await settings.click();
  await expect(cm(page)).toContainText('Bash(git status)');
  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  await expect(cm(page)).toContainText('"local"');
  await expect(cm(page)).not.toContainText('Bash(git status)');
  await settings.click();
  await expect(cm(page)).toContainText('Bash(git status)');

  const save = page.getByRole('button', { name: 'Save', exact: true });
  await replaceContent(page, 'this is definitely not json');
  await expect(page.getByText(/isn't valid JSON/)).toBeVisible();
  await expect(save).toBeDisabled();

  const marker = uniq('e2e-config-project');
  await replaceContent(page, JSON.stringify({ e2eMarker: marker }));
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();

  // Close the tab and reopen: the content comes back from the (mock) server.
  await tab(page, SETTINGS_PATH).getByRole('button').click();
  await expect(tab(page, SETTINGS_PATH)).toHaveCount(0);
  await settings.click();
  await expect(cm(page)).toContainText(marker);

  // POST /config/search surfaces the saved marker via the rail search box.
  await page.getByPlaceholder('Search config…').fill(marker);
  const hit = page.getByRole('button', { name: new RegExp(marker) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('settings.json');
});
