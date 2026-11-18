// Wiki panel: read-only markdown viewer + cytoscape link graph.
// Sandbox corpus (fixtures/seed.mjs): one wiki `handbook` with four pages —
// three at the top level (index.md, which links to both others; architecture.md;
// glossary.md) plus design/daemon.md.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl, visible } from '../e2e/helpers/nav.mjs';
import { WIKI_NAME } from '../web/src/mock/fixtures.js';

// The tree renders collapsed, so the wiki row has to be expanded first; page
// rows show only the basename.
async function openPage(page, file) {
  await page.getByRole('button', { name: WIKI_NAME, exact: false }).first().click();
  await page.getByRole('button', { name: file, exact: true }).click();
}

test('tree lists pages; a page renders frontmatter + body; wikilink jumps; search finds content', async ({ page }) => {
  await gotoUrl(page, 'Wiki');

  // The rail loads in two hops (GET /wiki/root then /wiki/files): wait on the caption.
  await expect(visible(page.getByText(/1 wiki\b.*4 pages/)).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'glossary.md', exact: true })).toHaveCount(0);
  await openPage(page, 'index.md');
  for (const f of ['architecture.md', 'glossary.md']) {
    await expect(page.getByRole('button', { name: f, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /design.*daemon\.md/ })).toBeVisible();

  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
  await expect(visible(page.getByText('stable', { exact: true })).first()).toBeVisible();
  await expect(visible(page.getByText('index.md', { exact: true })).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'glossary' })).toBeVisible();

  // The rendered body remounts once as the file fetch settles, which detaches the
  // anchor mid-click — let it stop moving before clicking.
  await page.waitForTimeout(400);
  await page.getByRole('link', { name: 'architecture' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Architecture' })).toBeVisible();
  await expect(visible(page.getByText('draft', { exact: true })).first()).toBeVisible();

  const search = page.getByPlaceholder('Search wiki…');
  await search.fill('Worktree'); // appears only in glossary.md
  await expect(visible(page.getByText(/\b1 matches?\b/)).first()).toBeVisible();
  await page.getByRole('button', { name: /glossary\.md/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(visible(page.getByText(/1 wiki\b.*4 pages/)).first()).toBeVisible();
});

test('the graph cycles docked → main pane → closed', async ({ page, consoleGuard }) => {
  // Three cytoscape mounts (dock, main pane, and the fcose layout run on each).
  test.setTimeout(90_000);
  // FINDING (app): WikiGraph.jsx passes a non-default `wheelSensitivity`, which
  // cytoscape warns about once per instance.
  consoleGuard.allow(/custom wheel sensitivity/i);

  await gotoUrl(page, 'Wiki');
  // graphWiki is only set once a wiki is selected, so the Hub button starts disabled.
  await openPage(page, 'index.md');

  // MUI puts the Tooltip aria-label on the wrapping span, not the button.
  const hub = page.locator('span[aria-label*="pages link together"] button');
  await expect(hub).toBeEnabled();

  await hub.click();
  const caption = visible(page.getByText(`${WIKI_NAME} · how pages link together`));
  await expect(caption.first()).toBeVisible();
  await page.getByRole('button', { name: 'Expand to main pane' }).click();
  await expect(page.getByRole('button', { name: 'Dock to sidebar' })).toBeVisible();
  await expect(caption.first()).toBeVisible();

  await page.getByRole('button', { name: 'Close graph' }).click();
  await expect(caption).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Handbook' })).toBeVisible();
});
