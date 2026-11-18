// Hooks / Rules / Memory / Skills editors over the mock's in-memory corpus.
// All four panels (plus Explorer and Config) share panelkit's useDirtyGuard
// and the same save path, so save + dirty-guard run once (on Hooks); the
// cross-panel test proves each panel lists and loads its own seeded corpus.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { PROJECT_A, PROJECT_B } from '../web/src/mock/fixtures.js';

const WORKSPACE_LABEL = '~/workspace';
const PROJECTS_LABEL = '~/projects';
const SKILLS_LABEL = '~/skills';
const cm = (page) => page.locator('.cm-content');
const btn = (page, name, exact = true) => page.getByRole('button', { name, exact });

async function appendMarker(page, marker) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(marker);
}

test('hooks, rules, memory and skills each list their seeded corpus and load a file', async ({ page }) => {
  await test.step('hooks: rail, search + Clear, select', async () => {
    await gotoUrl(page, 'Hooks');
    await expect(page.getByText(WORKSPACE_LABEL, { exact: false }).first()).toBeVisible();
    await expect(btn(page, 'pre-commit.sh')).toBeVisible();
    await page.getByPlaceholder('Search hooks…').fill('pre-commit fixture');
    await expect(page.getByRole('button', { name: /pre-commit\.sh:\d+/ })).toBeVisible();
    await expect(btn(page, 'format.ps1')).toHaveCount(0);
    await btn(page, 'Clear search').click();
    await btn(page, 'format.ps1').click();
    await expect(cm(page)).toContainText('format fixture');
  });

  await test.step('rules: rail, select', async () => {
    await gotoUrl(page, 'Rules');
    await expect(page.getByText(WORKSPACE_LABEL, { exact: false }).first()).toBeVisible();
    await expect(btn(page, 'testing.md')).toBeVisible();
    await btn(page, 'style.md').click();
    await expect(cm(page)).toContainText('Two-space indent');
  });

  await test.step('memory: rail grouped by project, select', async () => {
    await gotoUrl(page, 'Memory');
    await expect(page.getByText(PROJECTS_LABEL, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_A, { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_B, { exact: true })).toBeVisible();
    await expect(btn(page, 'MEMORY.md')).toBeVisible();
    await expect(btn(page, 'deploy-notes.md')).toBeVisible();
    await btn(page, 'retry-cap.md').click();
    await expect(cm(page)).toContainText('Backoff caps at 30s');
  });

  await test.step('skills: root expanded one level, collapse, SKILL.md + supporting file', async () => {
    await gotoUrl(page, 'Skills');
    await expect(page.getByText('2 scopes', { exact: false })).toBeVisible();
    await expect(page.getByText('2 skills', { exact: false })).toBeVisible();
    // One level only: scope folders visible without a click, skills are not.
    await expect(btn(page, 'design', false)).toBeVisible();
    await expect(btn(page, 'lint-guard', false)).toHaveCount(0);
    const root = page.getByText(SKILLS_LABEL, { exact: false }).first();
    await root.click();
    await expect(btn(page, 'coding', false)).toHaveCount(0);
    await root.click();
    await btn(page, 'coding', false).click();
    await btn(page, 'lint-guard', false).click();
    await expect(cm(page)).toContainText('Run the linter before staging.');
    await btn(page, 'reference.md', false).click();
    await expect(cm(page)).toContainText('One row per rule.');
  });
});

test('typing + Save reopens the hook with the saved content', async ({ page }) => {
  await gotoUrl(page, 'Hooks');
  await btn(page, 'pre-commit.sh').click();
  await expect(cm(page)).toContainText('pre-commit fixture');

  const marker = `e2e-hook-${Date.now()}`;
  await appendMarker(page, marker);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await btn(page, 'format.ps1').click();
  await expect(cm(page)).toContainText('format fixture');
  await btn(page, 'pre-commit.sh').click();
  await expect(cm(page)).toContainText(marker);
});

test('dirty-nav guard: cancel keeps the unsaved hook open, discard drops it', async ({ page }) => {
  await gotoUrl(page, 'Hooks');
  await btn(page, 'format.ps1').click();
  await expect(cm(page)).toContainText('format fixture');
  await appendMarker(page, 'unsaved-hook-edit');

  await btn(page, 'pre-commit.sh').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(cm(page)).toContainText('unsaved-hook-edit');

  await btn(page, 'pre-commit.sh').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  await expect(cm(page)).toContainText('pre-commit fixture');
});
