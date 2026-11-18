// Projects view: an ordered list of git repo toplevels, each with a baked-in
// git-status readout (web/src/mock/routes/projects.js).
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { PROJECT_PATHS } from '../web/src/mock/fixtures.js';

const repoName = (p) => p.split('/').pop();
const cards = (page) => page.locator('[data-testid="project-card"]');
const cardFor = (page, path) => cards(page).filter({ hasText: repoName(path) });
// Cards start collapsed; clicking blank card space (top-left padding corner)
// expands details (counts, last commit, summary).
const toggle = (card) => card.click({ position: { x: 4, y: 4 } });
const cardOrder = (page) => cards(page).evaluateAll((els) => els.map((el) => el.querySelector('button[aria-expanded]')?.textContent));

test('git actions and refreshes report outcomes; Refresh all re-fetches every card', async ({ page }) => {
  await gotoUrl(page, 'Projects');
  const clean = cardFor(page, PROJECT_PATHS.clean);
  for (const [name, text] of [
    ['git fetch', 'git fetch succeeded for sing-clean'],
    ['git rebase', 'git rebase succeeded for sing-clean'],
    ['git fetch + rebase', 'git fetch + rebase succeeded for sing-clean'],
  ]) {
    await clean.getByRole('button', { name, exact: true }).click();
    await expect(page.getByText(text)).toBeVisible();
  }
  await clean.getByRole('button', { name: 'Refresh project' }).click();
  await expect(page.getByText('Refreshed sing-clean')).toBeVisible();

  await page.evaluate(() => {
    window.__statusFetches = 0;
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const [input] = args;
      if ((typeof input === 'string' ? input : input.url).includes('/projects/status')) window.__statusFetches++;
      return orig(...args);
    };
  });
  await page.getByRole('button', { name: 'Refresh all' }).click();
  await expect(page.getByText('All projects refreshed')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__statusFetches)).toBeGreaterThanOrEqual(3);
});

test('cards toggle per card and all at once; details show chips + summary; summary fetched lazily', async ({ page }) => {
  // The mock (Mirage/pretender) replaces window.fetch after init scripts run,
  // so count through a setter that wraps whatever fetch gets installed.
  await page.addInitScript(() => {
    window.__summaryFetches = 0;
    const wrap = (orig) => (...args) => {
      const [input] = args;
      if ((typeof input === 'string' ? input : input.url).includes('/projects/summary')) window.__summaryFetches++;
      return orig(...args);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  });
  await gotoUrl(page, 'Projects');
  const summaryFetches = () => page.evaluate(() => window.__summaryFetches);
  await expect(cards(page)).toHaveCount(3);
  const clean = cardFor(page, PROJECT_PATHS.clean);
  const dirty = cardFor(page, PROJECT_PATHS.dirty);
  const noUpstream = cardFor(page, PROJECT_PATHS.noUpstream);

  // Collapsed: counts render as icon + number, labelled via tooltip; no summary yet.
  await expect(clean).toContainText('↑2 ↓0');
  await expect(clean).not.toContainText('Tidy release notes');
  await expect(dirty).not.toContainText('staged 2');
  await expect(dirty.getByLabel('staged 2')).toBeVisible();
  await expect(dirty.getByLabel('stash 1')).toBeVisible();
  expect(await summaryFetches()).toBe(0);

  await toggle(clean);
  await expect(clean).toContainText('Tidied up the release notes wording');
  await expect(dirty).not.toContainText('staged 2');
  await toggle(clean);
  await toggle(clean);
  expect(await summaryFetches()).toBe(1);
  // Action buttons keep their own meaning and don't toggle; refresh refetches the summary.
  await clean.getByRole('button', { name: 'Refresh project' }).click();
  await expect(clean).toContainText('Tidy release notes');
  await expect.poll(summaryFetches).toBe(2);
  await toggle(clean);
  await expect(clean).not.toContainText('Tidy release notes');

  const toggles = () => cards(page).locator('button[aria-expanded]');
  await page.getByRole('button', { name: 'Expand all' }).click();
  for (const t of await toggles().all()) await expect(t).toHaveAttribute('aria-expanded', 'true');

  await expect(clean.getByText('main', { exact: true })).toBeVisible();
  await expect(clean).toContainText('origin/main');
  await expect(clean).toContainText('Tidy release notes');
  await expect(clean).not.toContainText('Uncommitted');
  await expect(clean).toContainText('summary: opus');
  for (const s of ['staged 2', 'modified 3', 'untracked 1', 'stash 1', 'Reworked the widget layout', 'Still tuning the widget spacing']) {
    await expect(dirty).toContainText(s);
  }
  await expect(noUpstream.getByText('no upstream', { exact: true })).toBeVisible();
  await expect(noUpstream).toContainText('untracked 2');
  await expect(noUpstream).toContainText('Local experiment');
  await expect(noUpstream).not.toContainText('summary:'); // deterministic fallback has no source line

  await page.getByRole('button', { name: 'Collapse all' }).click();
  for (const t of await toggles().all()) await expect(t).toHaveAttribute('aria-expanded', 'false');
  // Native button: keyboard Enter toggles just that card.
  await toggles().first().focus();
  await page.keyboard.press('Enter');
  await expect(toggles().first()).toHaveAttribute('aria-expanded', 'true');
  await expect(toggles().nth(1)).toHaveAttribute('aria-expanded', 'false');
});

test('add via picker (no duplicates), delete, and Undo restores the card to its slot', async ({ page }) => {
  await gotoUrl(page, 'Projects');
  await expect(cards(page)).toHaveCount(3);
  for (let i = 0; i < 2; i++) { // second add of the same path must not duplicate
    await page.getByRole('button', { name: 'Add folder' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('/home/mock/repos/sing-new');
    await dialog.getByRole('button', { name: 'Select' }).click();
    await expect(cards(page)).toHaveCount(4);
  }
  await expect(cardFor(page, '/home/mock/repos/sing-new')).toBeVisible();

  const before = await cardOrder(page);
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
  await expect(cardFor(page, PROJECT_PATHS.dirty)).toHaveCount(0);
  await expect(page.getByText(`Removed ${repoName(PROJECT_PATHS.dirty)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cardFor(page, PROJECT_PATHS.dirty)).toBeVisible();
  await expect.poll(() => cardOrder(page)).toEqual(before);
});
