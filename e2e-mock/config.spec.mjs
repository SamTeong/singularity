// Config editor: tree-by-root rail (settings.json / settings.local.json under
// .claude, config.toml under .codex) + multi-tab CodeMirror editor.
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const SETTINGS_PATH = `${ROOTS.workspace}/.claude/settings.json`;
const CODEX_PATH = `${ROOTS.workspace}/.codex/config.toml`;
const WORKSPACE_LABEL = '~/workspace';
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escAttr = (s) => s.replace(/[\\"]/g, '\\$&');
const tab = (page, path) => page.locator(`[title="${escAttr(path)}"]`);

async function expandRoot(page) {
  await gotoView(page, 'Config');
  const root = page.getByRole('button', { name: WORKSPACE_LABEL, exact: false });
  const group = page.getByText('.claude', { exact: true });
  if (!(await group.isVisible().catch(() => false))) await root.click();
  await expect(group).toBeVisible();
}

async function replaceContent(page, text) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

async function captureMockResponse(page, suffix) {
  await page.evaluate((pathSuffix) => {
    const originalFetch = window.fetch;
    window.__e2eMockResponse = undefined;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input.url;
      if (init?.method === 'PUT' && url.endsWith(pathSuffix)) {
        window.__e2eMockResponse = await response.clone().json();
      }
      return response;
    };
  }, suffix);
}

const mockResponse = (page) => page.evaluate(() => window.__e2eMockResponse);

test('opening settings.json (project) and settings.local.json (local) switches tabs', async ({ page }) => {
  await expandRoot(page);

  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(cm(page)).toContainText('Bash(git status)');

  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  await expect(cm(page)).toContainText('"local"');
  await expect(cm(page)).not.toContainText('Bash(git status)');

  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(cm(page)).toContainText('Bash(git status)');
});

test('typing invalid JSON shows the inline error and disables Save', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await replaceContent(page, 'this is definitely not json');

  await expect(page.getByText(/isn't valid JSON/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('a valid Save reopens settings.json with the saved content', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  const marker = uniq('e2e-config-project');
  await replaceContent(page, JSON.stringify({ e2eMarker: marker }));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  await captureMockResponse(page, '/config/project');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const body = await mockResponse(page);
  expect(body.ok).toBe(true);
  expect(body.backup).toBeTruthy();

  await tab(page, SETTINGS_PATH).getByRole('button').click();
  await expect(tab(page, SETTINGS_PATH)).toHaveCount(0);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(cm(page)).toContainText(marker);
});

test('POST /config/search surfaces a hit via the rail search box', async ({ page }) => {
  await expandRoot(page);
  const marker = uniq('e2e-config-search');
  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  await replaceContent(page, JSON.stringify({ e2eSearchMarker: marker }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await page.getByPlaceholder('Search config…').fill(marker);
  const hit = page.getByRole('button', { name: new RegExp(`${marker}`) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('settings.local.json');
});

test('codex config.toml opens under .codex and reopens with saved content', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'config.toml', exact: true }).click();
  await expect(cm(page)).toContainText('gpt-5.2');

  const marker = uniq('e2e-codex-model');
  await replaceContent(page, `model = "${marker}"\n`);
  await captureMockResponse(page, '/codex-config/project');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const body = await mockResponse(page);
  expect(body.ok).toBe(true);

  await tab(page, CODEX_PATH).getByRole('button').click();
  await expect(tab(page, CODEX_PATH)).toHaveCount(0);
  await page.getByRole('button', { name: 'config.toml', exact: true }).click();
  await expect(cm(page)).toContainText(marker);
});

test('Remove from list removes the root from the rail', async ({ page }) => {
  await expandRoot(page);
  const row = page.getByRole('button', { name: WORKSPACE_LABEL, exact: false });
  await expect(row).toBeVisible();

  await row.getByLabel('Remove from list').click();

  await expect(page.getByRole('button', { name: WORKSPACE_LABEL, exact: false })).toHaveCount(0);
  await expect(page.getByText('No config paths.')).toBeVisible();
});
