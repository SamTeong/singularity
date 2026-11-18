// Hooks / Rules / Memory / Skills editors: a Save through each panel's real
// route lands on disk as bytes. The four panels share the same
// CmEditor/SaveBar/RailHeader plumbing but differ in tree shape:
//  - Hooks/Rules group a flat file list under one root (default expanded).
//  - Memory groups by project folder (default expanded).
//  - Skills is a 3-level root -> scope -> skill tree, rendered one level open
//    (roots expanded, scopes collapsed), so the scope has to be expanded first.
// Browse, search, load and the dirty-nav guard are covered by e2e-mock/editors.
//
// Mutating: Save really writes under <TMP>/corpus/... — asserted with node:fs.
// Each save uses a fresh marker so tests don't depend on order. // VERIFY: wave4-f5-1
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from './helpers/nav.mjs';
import { WORKSPACE_DIR, PROJECTS_DIR, SKILLS_DIR, PROJECT_B } from './fixtures/paths.mjs';

const cm = (page) => page.locator('.cm-content');
const uniq = (label) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Append `marker` at the end of whatever's loaded. keyboard.insertText (vs.
// .type, which sends real per-character key events and is both slow and
// subject to CodeMirror's default closeBrackets auto-pairing) inserts the
// whole string as one op, landing byte-for-byte as given.
//
// ControlOrMeta, not Control: end-of-document is CodeMirror's `Mod-End`, and Mod
// is Cmd on macOS (a literal Ctrl-End falls through to plain End there, i.e.
// end-of-LINE) — see the same note in config.spec.mjs.
async function appendMarker(page, marker) {
  await cm(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(marker);
}

// Append a fresh marker, Save through `urlSuffix`, and assert the bytes landed
// in `path`.
async function saveAndAssertOnDisk(page, label, urlSuffix, path) {
  const marker = uniq(label);
  await appendMarker(page, marker);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(urlSuffix) && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect((await resp.json()).ok).toBe(true);
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(readFileSync(path, 'utf8')).toContain(marker);
}

test('typing + Save writes the hook, rule, memory and skill files to disk', async ({ page }) => {
  await gotoView(page, 'Hooks');
  await page.getByRole('button', { name: 'pre-commit.sh', exact: true }).click();
  await expect(cm(page)).toContainText('pre-commit fixture');
  await saveAndAssertOnDisk(page, 'e2e-hook', '/hooks/file', join(WORKSPACE_DIR, '.claude', 'hooks', 'pre-commit.sh'));

  await gotoView(page, 'Rules');
  await page.getByRole('button', { name: 'testing.md', exact: true }).click();
  await expect(cm(page)).toContainText('One runnable check');
  await saveAndAssertOnDisk(page, 'e2e-rule', '/rules/file', join(WORKSPACE_DIR, '.claude', 'rules', 'testing.md'));

  await gotoView(page, 'Memory');
  await page.getByRole('button', { name: 'deploy-notes.md', exact: true }).click();
  await expect(cm(page)).toContainText('manual cache purge');
  await saveAndAssertOnDisk(page, 'e2e-memory', '/memory/file', join(PROJECTS_DIR, PROJECT_B, 'memory', 'deploy-notes.md'));

  await gotoView(page, 'Skills');
  await page.getByRole('button', { name: 'design', exact: false }).click();
  await page.getByRole('button', { name: 'color-audit', exact: false }).click();
  await expect(cm(page)).toContainText('Contrast first, hue second.');
  await saveAndAssertOnDisk(page, 'e2e-skill', '/skill', join(SKILLS_DIR, 'design', '.claude', 'skills', 'color-audit', 'SKILL.md'));
});
