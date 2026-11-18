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

// Hold /api/wiki/sweeps responses for roots ending in /wiki or /skills until the
// test calls window.__releaseSweeps(suffix). Mirage answers fetch inside the page, so
// page.route never sees this request; wrap whatever fetch gets installed instead.
// window.__settled lists suffixes whose held body has been handed to the app.
async function holdSweeps(page) {
  await page.addInitScript(() => {
    const gates = {};
    window.__settled = [];
    window.__releaseSweeps = (suffix) => gates[suffix].release();
    for (const suffix of ['/wiki', '/skills']) {
      gates[suffix] = {};
      gates[suffix].promise = new Promise((resolve) => { gates[suffix].release = resolve; });
    }
    const wrap = (orig) => async (...args) => {
      const [input] = args;
      const url = typeof input === 'string' ? input : input.url;
      const suffix = url.includes('/api/wiki/sweeps?') && ['/wiki', '/skills'].find((x) => decodeURIComponent(url).endsWith(x));
      if (!suffix) return orig(...args);
      await gates[suffix].promise;
      const res = await orig(...args);
      const json = res.json.bind(res);
      res.json = async () => { const d = await json(); setTimeout(() => { window.__settled.push(suffix); }); return d; };
      return res;
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });
}

async function selectSkillsRoot(page) {
  await page.getByRole('button', { name: 'Browse' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('~/skills');
  await dialog.getByRole('button', { name: 'Go' }).click();
  await dialog.getByRole('button', { name: 'coding' }).waitFor();
  await dialog.getByRole('button', { name: 'Select' }).click();
}

async function expectEmptySweepTable(table) {
  await expect(table.getByRole('row')).toHaveCount(4);
  for (const name of ['agentic-coding', 'dotnet', 'iap']) {
    await expect(table.getByRole('row', { name: new RegExp(name) }).locator('[aria-label="No completed sweep recorded"]')).toHaveCount(3);
  }
}

test('sweep history: root change hides stale dates, late old-root response is ignored, failure shows unavailable', async ({ page }) => {
  const table = page.getByRole('table', { name: 'Last completed wiki sweeps' });
  const loading = page.getByRole('status').filter({ hasText: 'Loading sweep history…' });

  await holdSweeps(page);
  await gotoUrl(page, 'Wiki');
  await expect(loading).toBeVisible();
  await page.evaluate(() => window.__releaseSweeps('/wiki'));
  await expect(table.getByRole('row', { name: /agentic-coding/ })).toContainText('2026-10-12');

  // Stale data: the old root's dates must vanish while the new root's response is held.
  await selectSkillsRoot(page);
  await expect(loading).toBeVisible();
  await expect(table).toHaveCount(0);
  await page.evaluate(() => window.__releaseSweeps('/skills'));
  await expectEmptySweepTable(table);

  // Late response: reload (fresh mock state + gates), switch root while the original
  // root's request is still held, then release it. The skills table must stay.
  await page.reload();
  await expect(loading).toBeVisible();
  await page.evaluate(() => window.__releaseSweeps('/skills'));
  await selectSkillsRoot(page);
  await expectEmptySweepTable(table);
  await page.evaluate(() => window.__releaseSweeps('/wiki'));
  await page.waitForFunction(() => window.__settled.includes('/wiki'));
  await expect(loading).toHaveCount(0);
  await expectEmptySweepTable(table);
});

test('failed sweep history request shows an unavailable state', async ({ page }) => {
  await page.addInitScript(() => {
    const wrap = (orig) => (...args) => {
      const [input] = args;
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/wiki/sweeps?')) return Promise.reject(new TypeError('Failed to fetch'));
      return orig(...args);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });
  await gotoUrl(page, 'Wiki');
  await expect(page.getByRole('alert').filter({ hasText: 'Sweep history unavailable.' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Last completed wiki sweeps' })).toHaveCount(0);
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
