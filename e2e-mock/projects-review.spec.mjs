// Project card "Review" section (project-review skill's ledger, server/
// project-review.mjs). Same conventions as projects.spec.mjs: cardFor/toggle
// helpers, PROJECT_PATHS imported directly from the fixture module so
// assertions read the same seed the mock server answers from.
import { test, expect } from './fixtures/test.mjs';
import { gotoView } from '../e2e/helpers/nav.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';
import { PROJECT_PATHS, seedProjectReviews } from '../web/src/mock/fixtures.js';

const REVIEWS = seedProjectReviews();
const cards = (page) => page.locator('[data-testid="project-card"]');
const cardFor = (page, path) => cards(page).filter({ hasText: path.split('/').pop() });
const toggle = (card) => card.click({ position: { x: 4, y: 4 } });

test('not-run project shows a Not run chip and no counts', async ({ page }) => {
  await gotoView(page, 'Projects');
  const card = cardFor(page, PROJECT_PATHS.noUpstream);
  await toggle(card);
  await expect(card.getByText('Review', { exact: true })).toBeVisible();
  await expect(card.getByText('Not run', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('commits since');
});

test('a DONE run with every finding resolved shows counts and All resolved', async ({ page }) => {
  await gotoView(page, 'Projects');
  const card = cardFor(page, PROJECT_PATHS.clean);
  await toggle(card);
  const latest = REVIEWS[PROJECT_PATHS.clean].latest;
  await expect(card.getByText('DONE', { exact: true })).toBeVisible();
  await expect(card).toContainText(`reviewed to ${latest.target.slice(0, 7)}`);
  await expect(card).toContainText(`${latest.commitsSince} commits since`);
  await expect(card).toContainText(`P1 ${latest.counts.P1}`);
  await expect(card).toContainText(`P2 ${latest.counts.P2}`);
  await expect(card).toContainText(`open ${latest.counts.open}`);
  await expect(card).toContainText(`resolved ${latest.counts.resolved}`);
  await expect(card.getByLabel('All resolved')).toBeVisible();
});

test('a BLOCKED latest run still surfaces open findings from an older DONE run', async ({ page }) => {
  await gotoView(page, 'Projects');
  const card = cardFor(page, PROJECT_PATHS.dirty);
  await toggle(card);
  const latest = REVIEWS[PROJECT_PATHS.dirty].latest;
  await expect(card.getByText('BLOCKED', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('sha not in repo'); // commitsSince only applies to DONE
  await expect(card).toContainText(`P0 ${latest.counts.P0}`);
  await expect(card).toContainText(`open ${latest.counts.open}`);
  await expect(card.getByLabel('All resolved')).toHaveCount(0);

  // The older run is collapsed by default; its findings are not yet in the DOM.
  await expect(card).not.toContainText('Stashed change clobbers widget layout on rebase');
  await card.getByText('Claude Code · DONE', { exact: true }).click();
  await expect(card).toContainText('P0 · Stashed change clobbers widget layout on rebase · open');
  await expect(card).toContainText('P2 · Widget spacing still WIP · open');
});

test('an artifact link opens a dialog with the file content', async ({ page }) => {
  await gotoView(page, 'Projects');
  const card = cardFor(page, PROJECT_PATHS.clean);
  await toggle(card);
  await card.getByRole('button', { name: 'findings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Race condition on save');
  await expect(dialog).toContainText('Status: fixed');
  // A click inside the portalled dialog must not bubble (via the React tree) to the card's toggle.
  await dialog.getByText('Race condition on save').first().click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(card.getByRole('button', { name: 'findings' })).toBeVisible();
});

test('review section is absent when project-review is not configured', async ({ page }) => {
  // Mirage answers fetch inside the page, so a bad response for one project's
  // review call is faked ahead of Mirage's own window.fetch install (same
  // wrap-whatever-fetch-gets-installed recipe projects.spec.mjs uses for
  // __summaryFetches), rather than a Playwright page.route (which never sees
  // Mirage-handled requests).
  await page.addInitScript((disabledPath) => {
    const wrap = (orig) => (...args) => {
      const [input] = args;
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/projects/review?path=') && url.includes(encodeURIComponent(disabledPath))) {
        return Promise.resolve(new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(...args);
    };
    let current = wrap(window.fetch);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => current, set: (v) => { current = wrap(v); } });
  }, PROJECT_PATHS.clean);

  await gotoView(page, 'Projects');
  const card = cardFor(page, PROJECT_PATHS.clean);
  await toggle(card);
  await expect(card).toContainText('Tidy release notes'); // rest of the card still renders
  await expect(card.getByText('Review', { exact: true })).toHaveCount(0);
});

test('phone width (375px): an expanded card with a Review section has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/projects');
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();
  for (const p of Object.values(PROJECT_PATHS)) await toggle(cardFor(page, p));
  await expect(cardFor(page, PROJECT_PATHS.dirty)).toContainText('BLOCKED');
  await expectNoPageOverflow(page);
});
