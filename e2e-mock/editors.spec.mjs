// Hooks / Rules / Memory / Skills editors: browse + search + edit + save +
// dirty-navigation guards over the mock's in-memory corpus.
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { PROJECT_A, PROJECT_B } from '../web/src/mock/fixtures.js';

const WORKSPACE_LABEL = '~/workspace';
const PROJECTS_LABEL = '~/projects';
const SKILLS_LABEL = '~/skills';
const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function appendMarker(page, marker) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(marker);
}

async function save(page) {
  await page.getByRole('button', { name: 'Save' }).click();
}

test.describe('Hooks editor', () => {
  test('rail lists the mock root and its seeded hook files', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await expect(page.getByText(WORKSPACE_LABEL, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'format.ps1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'pre-commit.sh', exact: true })).toBeVisible();
  });

  test('search filters to the matching hook; Clear search restores the list', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByPlaceholder('Search hooks…').fill('pre-commit fixture');
    await expect(page.getByRole('button', { name: /pre-commit\.sh:\d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'format.ps1', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('button', { name: 'format.ps1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'pre-commit.sh', exact: true })).toBeVisible();
  });

  test('selecting a hook loads its content into the editor', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByRole('button', { name: 'format.ps1', exact: true }).click();
    await expect(cm(page)).toContainText('format fixture');
  });

  test('typing + Save reopens the hook with the saved content', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await expect(cm(page)).toContainText('pre-commit fixture');

    const marker = uniq('e2e-hook');
    await appendMarker(page, marker);
    await save(page);
    await expect(page.getByText(/^Saved/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByRole('button', { name: 'format.ps1', exact: true }).click();
    await expect(cm(page)).toContainText('format fixture');
    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await expect(cm(page)).toContainText(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved hook open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByRole('button', { name: 'format.ps1', exact: true }).click();
    await expect(cm(page)).toContainText('format fixture');
    await appendMarker(page, 'unsaved-hook-edit');

    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-hook-edit');

    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('pre-commit fixture');
  });
});

test.describe('Rules editor', () => {
  test('rail lists the mock root and its seeded rule files', async ({ page }) => {
    await gotoView(page, 'Rules');
    await expect(page.getByText(WORKSPACE_LABEL, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'style.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'testing.md', exact: true })).toBeVisible();
  });

  test('search filters to the matching rule; Clear search restores the list', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByPlaceholder('Search rules…').fill('trailing whitespace');
    await expect(page.getByRole('button', { name: /style\.md:\d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'testing.md', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('button', { name: 'style.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'testing.md', exact: true })).toBeVisible();
  });

  test('selecting a rule loads its content into the editor', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByRole('button', { name: 'style.md', exact: true }).click();
    await expect(cm(page)).toContainText('Two-space indent');
  });

  test('typing + Save reopens the rule with the saved content', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await expect(cm(page)).toContainText('One runnable check');

    const marker = uniq('e2e-rule');
    await appendMarker(page, marker);
    await save(page);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByRole('button', { name: 'style.md', exact: true }).click();
    await expect(cm(page)).toContainText('Two-space indent');
    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await expect(cm(page)).toContainText(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved rule open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByRole('button', { name: 'style.md', exact: true }).click();
    await expect(cm(page)).toContainText('Two-space indent');
    await appendMarker(page, 'unsaved-rule-edit');

    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-rule-edit');

    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('One runnable check');
  });
});

test.describe('Memory panel', () => {
  test('rail lists the mock root, grouped by project, with its seeded files', async ({ page }) => {
    await gotoView(page, 'Memory');
    await expect(page.getByText(PROJECTS_LABEL, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_A, { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_B, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MEMORY.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'retry-cap.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'deploy-notes.md', exact: true })).toBeVisible();
  });

  test('search filters to the matching memory file; Clear search restores the count', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByPlaceholder('Search memory…').fill('manual cache purge');
    await expect(page.getByText('1 matches', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /deploy-notes\.md/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MEMORY.md', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MEMORY.md', exact: true })).toBeVisible();
  });

  test('selecting a memory file loads its content into the editor', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByRole('button', { name: 'retry-cap.md', exact: true }).click();
    await expect(cm(page)).toContainText('Backoff caps at 30s');
  });

  test('typing + Save reopens the memory file with the saved content', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByRole('button', { name: 'deploy-notes.md', exact: true }).click();
    await expect(cm(page)).toContainText('manual cache purge');

    const marker = uniq('e2e-memory');
    await appendMarker(page, marker);
    await save(page);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await page.getByRole('button', { name: 'retry-cap.md', exact: true }).click();
    await expect(cm(page)).toContainText('Backoff caps at 30s');
    await page.getByRole('button', { name: 'deploy-notes.md', exact: true }).click();
    await expect(cm(page)).toContainText(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved memory file open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByRole('button', { name: 'retry-cap.md', exact: true }).click();
    await expect(cm(page)).toContainText('Backoff caps at 30s');
    await appendMarker(page, 'unsaved-memory-edit');

    await page.getByRole('button', { name: 'MEMORY.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-memory-edit');

    await page.getByRole('button', { name: 'MEMORY.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('Retry cap');
  });
});

test.describe('Skills panel', () => {
  // Roots render expanded, so this collapses one — the inverse of what the
  // click used to do.
  async function collapseRoot(page) {
    await page.getByText(SKILLS_LABEL, { exact: false }).first().click();
  }
  async function openSkill(page, scope, skill) {
    await page.getByRole('button', { name: scope, exact: false }).click();
    await page.getByRole('button', { name: skill, exact: false }).click();
  }

  test('rail lists the mock root expanded one level; collapsing hides its scopes', async ({ page }) => {
    await gotoView(page, 'Skills');
    await expect(page.getByText(SKILLS_LABEL, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('2 scopes', { exact: false })).toBeVisible();
    await expect(page.getByText('2 skills', { exact: false })).toBeVisible();

    // One level only: the root's scope folders are visible without a click, the
    // skills inside them are not.
    await expect(page.getByRole('button', { name: 'coding', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'design', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'lint-guard', exact: false })).toHaveCount(0);

    await collapseRoot(page);
    await expect(page.getByRole('button', { name: 'coding', exact: false })).toHaveCount(0);

    await collapseRoot(page);
    await page.getByRole('button', { name: 'coding', exact: false }).click();
    await expect(page.getByRole('button', { name: 'lint-guard', exact: false })).toBeVisible();
  });

  test('search filters to the matching scope/skill; Clear search collapses back', async ({ page }) => {
    await gotoView(page, 'Skills');
    await page.getByPlaceholder('Search skills…').fill('WCAG');
    await expect(page.getByRole('button', { name: 'color-audit', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'lint-guard', exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('2 scopes', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'color-audit', exact: false })).toHaveCount(0);
  });

  test('selecting a skill loads SKILL.md, and its supporting file loads too', async ({ page }) => {
    await gotoView(page, 'Skills');
    await openSkill(page, 'coding', 'lint-guard');
    await expect(cm(page)).toContainText('Run the linter before staging.');

    await page.getByRole('button', { name: 'reference.md', exact: false }).click();
    await expect(cm(page)).toContainText('One row per rule.');
  });

  test('typing + Save reopens the skill with the saved content', async ({ page }) => {
    await gotoView(page, 'Skills');
    await openSkill(page, 'design', 'color-audit');
    await expect(cm(page)).toContainText('Contrast first, hue second.');

    const marker = uniq('e2e-skill');
    await appendMarker(page, marker);
    await save(page);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await openSkill(page, 'coding', 'lint-guard');
    await expect(cm(page)).toContainText('Run the linter before staging.');
    await page.getByRole('button', { name: 'color-audit', exact: false }).click();
    await expect(cm(page)).toContainText(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved skill open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Skills');
    await openSkill(page, 'coding', 'lint-guard');
    await page.getByRole('button', { name: 'design', exact: false }).click();
    await expect(cm(page)).toContainText('Run the linter before staging.');
    await appendMarker(page, 'unsaved-skill-edit');

    await page.getByRole('button', { name: 'color-audit', exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-skill-edit');

    await page.getByRole('button', { name: 'color-audit', exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('Contrast first, hue second.');
  });
});
