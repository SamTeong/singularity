// Wiki panel: read-only markdown viewer + cytoscape link graph.
// Sandbox corpus (fixtures/seed.mjs): one wiki `handbook` with four pages —
// three at the top level (index.md, which links to both others; architecture.md;
// glossary.md) plus design/daemon.md. The subdirectory matters: WikiPanel derives
// the category filter from a page's FOLDER (`category(p.rel)`), not frontmatter.
import { test, expect } from './fixtures/test.mjs';
import { gotoView, visible } from './helpers/nav.mjs';
import { WIKI_NAME } from './fixtures/paths.mjs';

// Open the wiki tree and click through to one page. The tree renders collapsed,
// so the wiki row has to be expanded first; page rows show only the basename.
async function openPage(page, file) {
  await page.getByRole('button', { name: WIKI_NAME, exact: false }).first().click();
  await page.getByRole('button', { name: file, exact: true }).click();
}

test('the tree lists the wiki, its page count, and its pages once expanded', async ({ page }) => {
  await gotoView(page, 'Wiki');

  // The rail loads in two hops (GET /wiki/root then /wiki/files), so wait on the
  // RailHeader caption — "<n> wiki(s) · <n> page(s)" — before anything else.
  await expect(visible(page.getByText(/1 wiki\b.*4 pages/)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page.getByText(WIKI_NAME, { exact: true })).first()).toBeVisible();

  // Pages are hidden until the wiki row is expanded.
  await expect(page.getByRole('button', { name: 'glossary.md', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: WIKI_NAME, exact: false }).first().click();
  for (const f of ['architecture.md', 'glossary.md', 'index.md']) {
    await expect(page.getByRole('button', { name: f, exact: true })).toBeVisible();
  }
  // Nested pages show a folder pill alongside the basename.
  await expect(page.getByRole('button', { name: /design.*daemon\.md/ })).toBeVisible();
});

test('opening a page renders its frontmatter title, status pill and body', async ({ page }) => {
  await gotoView(page, 'Wiki');
  await openPage(page, 'index.md');

  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await expect(visible(page.getByText('stable', { exact: true })).first()).toBeVisible();
  // The rel path caption above the rendered body.
  await expect(visible(page.getByText('index.md', { exact: true })).last()).toBeVisible();
  // Body text, with the [[wikilinks]] turned into anchors.
  await expect(page.getByRole('link', { name: 'architecture' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'glossary' })).toBeVisible();
});

test('a [[wikilink]] jumps to the linked page', async ({ page }) => {
  await gotoView(page, 'Wiki');
  await openPage(page, 'index.md');
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  // The rendered body remounts once as the file fetch settles, which detaches the
  // anchor mid-click — let it stop moving before clicking.
  await page.waitForTimeout(400);

  await page.getByRole('link', { name: 'architecture' }).click();

  // architecture.md: title Architecture, status draft, and it links on to glossary.
  await expect(page.getByRole('heading', { level: 1, name: 'Architecture' })).toBeVisible();
  await expect(visible(page.getByText('draft', { exact: true })).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'glossary' })).toBeVisible();
});

test('search replaces the tree with content matches', async ({ page }) => {
  await gotoView(page, 'Wiki');

  const search = page.getByPlaceholder('Search wiki…');
  await search.fill('Worktree');           // appears only in glossary.md

  // Caption flips from "<n> wikis · <n> pages" to "<n> matches".
  await expect(visible(page.getByText(/\b1 matches?\b/)).first()).toBeVisible();

  // The one hit opens the page it came from.
  await page.getByRole('button', { name: /glossary\.md/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();

  // Clearing search restores the tree caption.
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(visible(page.getByText(/1 wiki\b.*4 pages/)).first()).toBeVisible();
});

test('the category filter narrows the tree', async ({ page }) => {
  await gotoView(page, 'Wiki');

  // The only category in the corpus is the `design` folder.
  await page.getByPlaceholder('Filter categories…').click();
  await page.getByRole('option', { name: 'design', exact: true }).click();
  // disableCloseOnSelect keeps the popper open, and it covers the tree below.
  await page.keyboard.press('Escape');

  // design/daemon.md is the sole page in it, so the count drops to one and the
  // three top-level pages disappear.
  await expect(visible(page.getByText(/1 wiki\b.*1 page\b/)).first()).toBeVisible();
  await page.getByRole('button', { name: WIKI_NAME, exact: false }).first().click();
  await expect(page.getByRole('button', { name: /design.*daemon\.md/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'glossary.md', exact: true })).toHaveCount(0);
});

test('the graph cycles docked → main pane → closed', async ({ page, consoleGuard }) => {
  // Three cytoscape mounts (dock, main pane, and the fcose layout run on each)
  // do not fit the 30s default.
  test.setTimeout(90_000);

  // FINDING (app, not test): mounting the cytoscape graph logs
  //   "You have set a custom wheel sensitivity. This will make your app zoom
  //    unnaturally when using mainstream mice. …"
  // once per instance — WikiGraph.jsx passes a non-default `wheelSensitivity`.
  // Allowed here so the rest of this test can run; it is a real warning worth
  // fixing in the app, not environmental noise.
  consoleGuard.allow(/custom wheel sensitivity/i);

  await gotoView(page, 'Wiki');
  // graphWiki is only set once a wiki is selected, so the Hub button starts disabled.
  await openPage(page, 'index.md');

  // The Hub button carries no accessible name of its own: WikiPanel wraps it in a
  // <span> for the Tooltip (so the tooltip still works while the button is
  // disabled), and MUI puts the aria-label on that span, not the button.
  const hub = page.locator('span[aria-label*="pages link together"] button');
  await expect(hub).toBeEnabled();

  // Docked in the rail. Cytoscape paints to a canvas with no queryable DOM, so
  // assert the surrounding chrome instead.
  await hub.click();
  const caption = visible(page.getByText(`${WIKI_NAME} · how pages link together`));
  await expect(caption.first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand to main pane' })).toBeVisible();

  // Promoted to the main pane — the dock control flips to "Dock to sidebar".
  await page.getByRole('button', { name: 'Expand to main pane' }).click();
  await expect(page.getByRole('button', { name: 'Dock to sidebar' })).toBeVisible();
  await expect(caption.first()).toBeVisible();

  // Closed — chrome and canvas both gone, the page body is back.
  await page.getByRole('button', { name: 'Close graph' }).click();
  await expect(caption).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
});
