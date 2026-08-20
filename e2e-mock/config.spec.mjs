// Config editor: tree-by-root rail (settings.json / settings.local.json under
// .claude, config.toml under .codex) + multi-tab CodeMirror editor.
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { ROOTS } from '../web/src/mock/fixtures.js';

const SETTINGS_PATH = `${ROOTS.workspace}/.claude/settings.json`;
const LOCAL_PATH = `${ROOTS.workspace}/.claude/settings.local.json`;
const CODEX_PATH = `${ROOTS.workspace}/.codex/config.toml`;
const WORKSPACE_LABEL = '~/workspace';
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escAttr = (s) => s.replace(/[\\"]/g, '\\$&');
const tab = (page, path) => page.locator(`[title="${escAttr(path)}"]`);
// Playwright returns matches in DOM order, so this is the on-screen tab order.
// `:has(> button)` keeps it to tab-strip entries (each carries a close button) —
// a rail search hit renders the same path in a bare `title=` span.
const tabOrder = (page, paths) =>
  page.locator(paths.map((p) => `[title="${escAttr(p)}"]:has(> button)`).join(', ')).evaluateAll((els) => els.map((el) => el.title));

// Playwright's dragTo()/mouse.down+move+up did not reliably fire React's
// onDragStart/onDragOver/onDrop for these HTML5-draggable elements under
// headless Chromium (no real OS-level drag). Dispatching the drag events
// directly with a shared DataTransfer — Playwright's documented recipe for
// HTML5 DnD — does.
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

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

test('dragging a tab reorders the strip without changing the active editor', async ({ page }) => {
  await expandRoot(page);
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await page.getByRole('button', { name: 'settings.local.json', exact: true }).click();
  // expect.poll, not expect(await …): the tabs land via an async readConfig, and
  // the suite runs with retries: 0, so a one-shot read would be a race.
  await expect.poll(() => tabOrder(page, [SETTINGS_PATH, LOCAL_PATH])).toEqual([SETTINGS_PATH, LOCAL_PATH]);
  await expect(cm(page)).toContainText('"local"');

  await html5Drag(page, tab(page, LOCAL_PATH), tab(page, SETTINGS_PATH));

  await expect.poll(() => tabOrder(page, [SETTINGS_PATH, LOCAL_PATH])).toEqual([LOCAL_PATH, SETTINGS_PATH]);
  // The dragged tab was and stays the active one — reorder must not switch tabs.
  await expect(cm(page)).toContainText('"local"');
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
