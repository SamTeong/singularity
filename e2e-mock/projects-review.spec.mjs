// Project card "Review" section (project-review skill's ledger, server/
// project-review.mjs). PROJECT_PATHS come straight from the fixture module so
// assertions read the same seed the mock server answers from.
import { test, expect } from './fixtures/test.mjs';
import { gotoUrl } from '../e2e/helpers/nav.mjs';
import { PROJECT_PATHS, seedProjectReviews } from '../web/src/mock/fixtures.js';

const REVIEWS = seedProjectReviews();
const cards = (page) => page.locator('[data-testid="project-card"]');
const cardFor = (page, path) => cards(page).filter({ hasText: path.split('/').pop() });
const toggle = (card) => card.click({ position: { x: 4, y: 4 } });

test('review section: DONE counts + artifact dialog, Not run chip, BLOCKED surfaces older open findings', async ({ page }) => {
  await gotoUrl(page, 'Projects');

  const clean = cardFor(page, PROJECT_PATHS.clean);
  await toggle(clean);
  const latest = REVIEWS[PROJECT_PATHS.clean].latest;
  await expect(clean.getByText('DONE', { exact: true })).toBeVisible();
  await expect(clean).toContainText(`reviewed to ${latest.target.slice(0, 7)}`);
  await expect(clean).toContainText(`${latest.commitsSince} commits since`);
  for (const k of ['P1', 'P2', 'open', 'resolved']) await expect(clean).toContainText(`${k} ${latest.counts[k]}`);
  await expect(clean.getByLabel('All resolved')).toBeVisible();

  await clean.getByRole('button', { name: 'findings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Race condition on save');
  await expect(dialog).toContainText('Status: fixed');
  // A click inside the portalled dialog must not bubble (via the React tree) to the card's toggle.
  await dialog.getByText('Race condition on save').first().click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(clean.getByRole('button', { name: 'findings' })).toBeVisible();

  const notRun = cardFor(page, PROJECT_PATHS.noUpstream);
  await toggle(notRun);
  await expect(notRun.getByText('Not run', { exact: true })).toBeVisible();
  await expect(notRun).not.toContainText('commits since');

  const dirty = cardFor(page, PROJECT_PATHS.dirty);
  await toggle(dirty);
  const blocked = REVIEWS[PROJECT_PATHS.dirty].latest;
  await expect(dirty.getByText('BLOCKED', { exact: true })).toBeVisible();
  await expect(dirty).not.toContainText('sha not in repo'); // commitsSince only applies to DONE
  await expect(dirty).toContainText(`P0 ${blocked.counts.P0}`);
  await expect(dirty).toContainText(`open ${blocked.counts.open}`);
  await expect(dirty.getByLabel('All resolved')).toHaveCount(0);
  // The older run is collapsed by default; its findings are not yet in the DOM.
  await expect(dirty).not.toContainText('Stashed change clobbers widget layout on rebase');
  await dirty.getByText('Claude Code · DONE', { exact: true }).click();
  await expect(dirty).toContainText('P0 · Stashed change clobbers widget layout on rebase · open');
  await expect(dirty).toContainText('P2 · Widget spacing still WIP · open');
});
