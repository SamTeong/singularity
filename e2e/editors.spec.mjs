// Hooks / Rules / Memory / Skills editors: browse + search + edit + save +
// the dirty-navigation guard, across four panels that share the same
// CmEditor/SaveBar/RailHeader plumbing but differ in tree shape:
//  - Hooks/Rules group a flat file list under one root (default expanded).
//  - Memory groups by project folder (default expanded).
//  - Skills is a 3-level root -> scope -> skill tree, rendered COLLAPSED
//    (README: "the tree renders collapsed") — every skill test has to expand
//    root then scope before a skill/file button exists.
//
// Mutating: Save really writes under e2e/.tmp(-<port>)/corpus/... — asserted
// with node:fs. Each save uses a fresh marker so tests don't depend on order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { WORKSPACE_DIR, PROJECTS_DIR, SKILLS_DIR, PROJECT_A, PROJECT_B } from './fixtures/paths.mjs';

const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Append `marker` at the end of whatever's loaded. keyboard.insertText (vs.
// .type, which sends real per-character key events and is both slow and
// subject to CodeMirror's default closeBrackets auto-pairing) inserts the
// whole string as one op, landing byte-for-byte as given.
async function appendMarker(page, marker) {
  await cm(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(marker);
}

async function save(page, urlSuffix) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(urlSuffix) && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  return resp;
}

// ------------------------------------------------------------------- Hooks
test.describe('Hooks editor', () => {
  const PRECOMMIT_PATH = join(WORKSPACE_DIR, '.claude', 'hooks', 'pre-commit.sh');

  test('rail lists the sandbox root and its seeded hook files', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await expect(page.getByText(WORKSPACE_DIR, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'format.ps1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'pre-commit.sh', exact: true })).toBeVisible();
  });

  test('search filters to the matching hook; Clear search restores the list', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByPlaceholder('Search hooks…').fill('pre-commit fixture'); // unique to pre-commit.sh's echo line
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

  test('typing + Save writes the hook file to disk', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await expect(cm(page)).toContainText('pre-commit fixture');

    const marker = uniq('e2e-hook');
    await appendMarker(page, marker);
    const resp = await save(page, '/hooks/file');
    expect((await resp.json()).ok).toBe(true);
    await expect(page.getByText(/^Saved/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    expect(readFileSync(PRECOMMIT_PATH, 'utf8')).toContain(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved hook open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Hooks');
    await page.getByRole('button', { name: 'format.ps1', exact: true }).click();
    await expect(cm(page)).toContainText('format fixture');
    await appendMarker(page, 'unsaved-hook-edit');

    // Cancel aborts the navigation — the unsaved edit stays on format.ps1.
    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-hook-edit'); // stayed on format.ps1

    // Discard proceeds without saving — navigates to pre-commit.sh, edit gone.
    await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('pre-commit fixture'); // navigated away, edit discarded
  });
});

// ------------------------------------------------------------------- Rules
test.describe('Rules editor', () => {
  const TESTING_PATH = join(WORKSPACE_DIR, '.claude', 'rules', 'testing.md');

  test('rail lists the sandbox root and its seeded rule files', async ({ page }) => {
    await gotoView(page, 'Rules');
    await expect(page.getByText(WORKSPACE_DIR, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'style.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'testing.md', exact: true })).toBeVisible();
  });

  test('search filters to the matching rule; Clear search restores the list', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByPlaceholder('Search rules…').fill('trailing whitespace'); // unique to style.md
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

  test('typing + Save writes the rule file to disk', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await expect(cm(page)).toContainText('One runnable check');

    const marker = uniq('e2e-rule');
    await appendMarker(page, marker);
    const resp = await save(page, '/rules/file');
    expect((await resp.json()).ok).toBe(true);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    expect(readFileSync(TESTING_PATH, 'utf8')).toContain(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved rule open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Rules');
    await page.getByRole('button', { name: 'style.md', exact: true }).click();
    await expect(cm(page)).toContainText('Two-space indent');
    await appendMarker(page, 'unsaved-rule-edit');

    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-rule-edit'); // stayed on style.md

    await page.getByRole('button', { name: 'testing.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('One runnable check'); // navigated away, edit discarded
  });
});

// ------------------------------------------------------------------ Memory
test.describe('Memory panel', () => {
  const DEPLOY_NOTES_PATH = join(PROJECTS_DIR, PROJECT_B, 'memory', 'deploy-notes.md');

  test('rail lists the sandbox root, grouped by project, with its seeded files', async ({ page }) => {
    await gotoView(page, 'Memory');
    await expect(page.getByText(PROJECTS_DIR, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('3 files', { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_A, { exact: true })).toBeVisible();
    await expect(page.getByText(PROJECT_B, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MEMORY.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'retry-cap.md', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'deploy-notes.md', exact: true })).toBeVisible();
  });

  test('search filters to the matching memory file; Clear search restores the count', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByPlaceholder('Search memory…').fill('manual cache purge'); // unique to deploy-notes.md
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

  test('typing + Save writes the memory file to disk', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByRole('button', { name: 'deploy-notes.md', exact: true }).click();
    await expect(cm(page)).toContainText('manual cache purge');

    const marker = uniq('e2e-memory');
    await appendMarker(page, marker);
    const resp = await save(page, '/memory/file');
    expect((await resp.json()).ok).toBe(true);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    expect(readFileSync(DEPLOY_NOTES_PATH, 'utf8')).toContain(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved memory file open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Memory');
    await page.getByRole('button', { name: 'retry-cap.md', exact: true }).click();
    await expect(cm(page)).toContainText('Backoff caps at 30s');
    await appendMarker(page, 'unsaved-memory-edit');

    await page.getByRole('button', { name: 'MEMORY.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-memory-edit'); // stayed on retry-cap.md

    await page.getByRole('button', { name: 'MEMORY.md', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('Retry cap'); // navigated away, edit discarded
  });
});

// ------------------------------------------------------------------ Skills
// 3-level tree (root -> scope -> skill), rendered collapsed. `SKILLS_DIR`
// holds two scopes: coding/lint-guard (with a supporting reference.md) and
// design/color-audit.
test.describe('Skills panel', () => {
  const COLOR_AUDIT_PATH = join(SKILLS_DIR, 'design', '.claude', 'skills', 'color-audit', 'SKILL.md');

  async function expandRoot(page) {
    await page.getByText(SKILLS_DIR, { exact: false }).first().click();
  }
  async function openSkill(page, scope, skill) {
    await page.getByRole('button', { name: scope, exact: false }).click();
    await page.getByRole('button', { name: skill, exact: false }).click();
  }

  test('rail lists the sandbox root collapsed; expanding reveals scopes and skills', async ({ page }) => {
    await gotoView(page, 'Skills');
    await expect(page.getByText(SKILLS_DIR, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('2 scopes', { exact: false })).toBeVisible();
    await expect(page.getByText('2 skills', { exact: false })).toBeVisible();

    // Collapsed by default — no scope row until the root is expanded.
    await expect(page.getByRole('button', { name: 'coding', exact: false })).toHaveCount(0);
    await expandRoot(page);
    await expect(page.getByRole('button', { name: 'coding', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'design', exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'coding', exact: false }).click();
    await expect(page.getByRole('button', { name: 'lint-guard', exact: false })).toBeVisible();
  });

  test('search filters to the matching scope/skill; Clear search collapses back', async ({ page }) => {
    await gotoView(page, 'Skills');
    await page.getByPlaceholder('Search skills…').fill('WCAG'); // only color-audit's description mentions it
    await expect(page.getByRole('button', { name: 'color-audit', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'lint-guard', exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('2 scopes', { exact: false })).toBeVisible();
    // Tree reverts to its (still-collapsed) prior state — nothing was ever expanded by hand.
    await expect(page.getByRole('button', { name: 'color-audit', exact: false })).toHaveCount(0);
  });

  test('selecting a skill loads SKILL.md, and its supporting file loads too', async ({ page }) => {
    await gotoView(page, 'Skills');
    await expandRoot(page);
    await openSkill(page, 'coding', 'lint-guard');
    await expect(cm(page)).toContainText('Run the linter before staging.');

    await page.getByRole('button', { name: 'reference.md', exact: false }).click();
    await expect(cm(page)).toContainText('One row per rule.');
  });

  test('typing + Save writes the skill file to disk', async ({ page }) => {
    await gotoView(page, 'Skills');
    await expandRoot(page);
    await openSkill(page, 'design', 'color-audit');
    await expect(cm(page)).toContainText('Contrast first, hue second.');

    const marker = uniq('e2e-skill');
    await appendMarker(page, marker);
    const resp = await save(page, '/skill');
    expect((await resp.json()).ok).toBe(true);
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    expect(readFileSync(COLOR_AUDIT_PATH, 'utf8')).toContain(marker);
  });

  test('dirty-nav guard: cancel keeps the unsaved skill open, discard drops it', async ({ page }) => {
    await gotoView(page, 'Skills');
    await expandRoot(page);
    await openSkill(page, 'coding', 'lint-guard'); // expands the coding scope + opens lint-guard
    await page.getByRole('button', { name: 'design', exact: false }).click(); // expand design too, skill picked below
    await expect(cm(page)).toContainText('Run the linter before staging.');
    await appendMarker(page, 'unsaved-skill-edit');

    await page.getByRole('button', { name: 'color-audit', exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(cm(page)).toContainText('unsaved-skill-edit'); // stayed on lint-guard

    await page.getByRole('button', { name: 'color-audit', exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(cm(page)).toContainText('Contrast first, hue second.'); // navigated away, edit discarded
  });
});
