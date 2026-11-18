// Phone rail-editor smoke (Explorer, standing in for every PhonePane panel)
// and the one viewport-crossing test kept suite-wide. Every test sets its own
// viewport and navigates by URL, so this runs in the default `chromium` project.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;     // 375x667
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop; // 1440x900

// The shared pane switcher (PhonePane.jsx), located by its group aria-label.
const switcher = (page) => page.getByRole('group', { name: 'Pane switch' });
const cmContent = (page) => page.locator('.cm-content').first();
const explorerReady = (page) => page.getByRole('button', { name: 'notes.md', exact: true }).first();

async function openExplorer(page) {
  await page.goto('/explorer');
  await expect(explorerReady(page)).toBeVisible();
}

test.describe('phone explorer touch flows', () => {
  test.use({ hasTouch: true });

  test('one pane at a time; browse, edit and save — every control reachable by tap', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openExplorer(page);

    const sw = switcher(page);
    await expect(sw.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toBeDisabled();
    // The tree row spans the pane (the Rail no longer clamps to its ~200px floor).
    expect((await explorerReady(page).boundingBox()).width).toBeGreaterThan(300);

    // Real touch input, not a mouse click: expand, then open the nested file.
    await page.getByRole('button', { name: 'subdir', exact: true }).tap();
    await page.getByRole('button', { name: 'nested.txt', exact: true }).tap();
    await expect(sw.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(cmContent(page)).toContainText('Nested file content.');
    expect((await page.locator('.cm-editor').first().boundingBox()).width).toBeGreaterThan(300);

    await cmContent(page).tap();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' touch edit');
    const save = page.getByRole('button', { name: 'Save', exact: true }).first();
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await save.tap();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // Back to the list and re-open: the edit survives the pane switch.
    await sw.getByRole('button', { name: 'Files', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'nested.txt', exact: true }).tap();
    await expect(cmContent(page)).toContainText('touch edit');
    await expectNoPageOverflow(page);
  });
});

test('desktop -> phone -> desktop with an open editor keeps the node and unsaved text', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openExplorer(page);
  await explorerReady(page).click();
  await expect(cmContent(page)).toContainText('Explorer fixture markdown.');

  // Tag the mounted CodeMirror node so the assertion proves no remount (and
  // therefore no content loss) across each crossing.
  const cmNode = page.locator('.cm-editor').first();
  await cmNode.evaluate((el) => { el.dataset.keep = 'yes'; });
  await cmContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/* unsaved */');

  await page.setViewportSize(PHONE);
  await expect(switcher(page).getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(cmNode).toBeVisible();
  expect(await cmNode.getAttribute('data-keep')).toBe('yes');
  await expect(cmContent(page)).toContainText('unsaved');
  await expectNoPageOverflow(page);

  await page.setViewportSize(DESKTOP);
  await expect(switcher(page)).toHaveCount(0);
  await expect(cmNode).toBeVisible();
  expect(await cmNode.getAttribute('data-keep')).toBe('yes');
  await expect(cmContent(page)).toContainText('unsaved');
  await expectNoPageOverflow(page);
});
