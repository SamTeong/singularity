import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';
// Timeframe / ?status / ?layout URL rules: web/src/features/plans/plansQuery.test.mjs.

test('Plans carousel is reachable and swipeable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto('/plans');
  const initialSession = page.getByRole('region', { name: 'Session carousel' }).locator('[aria-current="true"] .MuiCardActionArea-root');
  await expect(initialSession).toHaveAttribute('aria-expanded', 'true');
  await expect(initialSession).toBeFocused();

  const toggle = page.getByRole('button', { name: 'Switch to board view' });
  const filter = page.getByRole('button', { name: 'Filter plans' });
  const toggleBox = await toggle.boundingBox();
  const filterBox = await filter.boundingBox();
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(filterBox.x);
  await expect(page).not.toHaveURL(/layout=/);
  await toggle.click();
  await expect(page).toHaveURL(/layout=board/);
  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to carousel view' }).click();
  await expect(page).not.toHaveURL(/layout=/);
  const deck = page.getByRole('region', { name: 'Session carousel' });
  await expect(deck).toBeVisible();
  await expectNoPageOverflow(page);
  const deckBox = await deck.boundingBox();
  expect(deckBox.height).toBe(150);
  const cardBottom = await deck.locator('[aria-current="true"] .MuiCard-root').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(cardBottom).toBeLessThanOrEqual(deckBox.y + deckBox.height);
  expect(await deck.evaluate((el) => getComputedStyle(el).perspective)).toBe('1200px');
  const overlap = await deck.evaluate((el) => {
    const at = [...el.children].findIndex((child) => child.getAttribute('aria-current') === 'true');
    const first = el.children[at].getBoundingClientRect();
    const second = el.children[at + 1].getBoundingClientRect();
    return first.right - second.left;
  });
  expect(overlap).toBeGreaterThan(0);
  const rotatedNeighbor = await deck.evaluate((el) => {
    const at = [...el.children].findIndex((child) => child.getAttribute('aria-current') === 'true');
    const center = getComputedStyle(el.children[at]).transform;
    const neighbor = getComputedStyle(el.children[at + 1]).transform;
    return neighbor.startsWith('matrix3d(') && neighbor !== center;
  });
  expect(rotatedNeighbor).toBe(true);

  const bounds = await deck.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 128, bounds.y + bounds.height / 2, { steps: 5 });
  await page.mouse.up();
  // The ring renders only a window around the selection, so track position by the counter.
  const counter = page.getByText(/^\d+ \/ \d+$/);
  const frontIndex = async () => Number((await counter.textContent()).split(' / ')[0]) - 1;
  await expect.poll(frontIndex).toBe(1);
  await page.getByRole('button', { name: 'Next session' }).click();
  await expect.poll(frontIndex).toBe(2);

  await deck.locator('[aria-current="true"] .MuiCardActionArea-root').click();
  const plans = page.getByRole('region', { name: 'Plans in selected session' });
  await expect(plans).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect.poll(frontIndex).toBe(3);
  await expect(deck.locator('[aria-current="true"] .MuiCardActionArea-root')).toBeFocused();
  await expect(deck).not.toBeFocused();
  await expect(plans.locator(':scope > div')).toHaveCount(2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(frontIndex).toBe(2);
  await expect(deck.locator('[aria-current="true"] .MuiCardActionArea-root')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(plans.locator('[data-plan-card] .MuiCardActionArea-root').first()).toBeFocused();
  await expect(plans.locator('[data-plan-card] .MuiCardActionArea-root').first()).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowUp');
  await expect(deck.locator('[aria-current="true"] .MuiCardActionArea-root')).toBeFocused();
  await plans.locator('.MuiCardActionArea-root').first().click();
  await expect(plans.getByText('Next', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next session' }).click();
  await expect(plans).not.toBeVisible();
  await deck.locator('[aria-current="true"] .MuiCardActionArea-root').click();
  await expect(plans).toBeVisible();
  const planCards = plans.locator(':scope > div');
  await expect(planCards).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await expect(planCards.nth(0).locator('.MuiCardActionArea-root')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(planCards.nth(1).locator('.MuiCardActionArea-root')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(planCards.nth(1).locator('.MuiCardActionArea-root')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(planCards.nth(0).locator('.MuiCardActionArea-root')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(deck.locator('[aria-current="true"] .MuiCardActionArea-root')).toBeFocused();
  expect(await plans.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column');
  const planGap = await planCards.evaluateAll((cards) => {
    const first = cards[0].getBoundingClientRect();
    const second = cards[1].getBoundingClientRect();
    return second.top - first.bottom;
  });
  expect(planGap).toBeGreaterThan(0);
  await planCards.nth(0).locator('.MuiCardActionArea-root').click();
  await expect(plans.getByText('Finish fleet section')).toBeVisible();
  await planCards.nth(1).locator('.MuiCardActionArea-root').click();
  await expect(plans.getByText('Finish fleet section')).not.toBeVisible();
  await expect(plans.getByText('Unblock on upstream table rename')).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: 'Switch to board view' }).click();
  await expect(page).toHaveURL(/layout=board/);
  await expect(page.locator('.react-flow')).toBeVisible();
});

test('board arrow keys traverse sessions and their plan stack; session-id search and ?sid= deep link', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/plans?layout=board');
  const sessions = page.locator('.react-flow__node-session .MuiCardActionArea-root');
  const stack = page.locator('.react-flow__node-planStack');
  await expect(sessions.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(stack).toBeVisible();
  await expect(sessions.first()).toBeFocused();
  await page.evaluate(() => {
    window.__sessionVisibilityMutations = [];
    window.__sessionVisibilityObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (getComputedStyle(record.target).visibility === 'hidden' || /visibility:\s*hidden/.test(record.oldValue || '')) {
          window.__sessionVisibilityMutations.push(record.target.getAttribute('data-id'));
        }
      }
    });
    document.querySelectorAll('.react-flow__node-session').forEach((node) => {
      window.__sessionVisibilityObserver.observe(node, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    });
  });

  await page.keyboard.press('ArrowRight');
  await expect(stack.locator('.MuiCardActionArea-root').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sessions.first()).toBeFocused();
  await page.evaluate(() => { window.__sessionVisibilityMutations = []; });
  await page.keyboard.press('ArrowDown');
  await expect(sessions.nth(4)).toBeFocused();
  await expect(stack).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(sessions.first()).toBeFocused();
  await expect(stack).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => {
    const hidden = window.__sessionVisibilityObserver.takeRecords()
      .filter((record) => getComputedStyle(record.target).visibility === 'hidden'
        || /visibility:\s*hidden/.test(record.oldValue || ''))
      .map((record) => record.target.getAttribute('data-id'));
    return [...window.__sessionVisibilityMutations, ...hidden];
  })).toEqual([]);
  await page.evaluate(() => window.__sessionVisibilityObserver.disconnect());

  await sessions.first().click();
  await expect(sessions.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(stack).not.toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(sessions.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sessions.first()).toBeFocused();

  await sessions.first().click();
  await expect(sessions.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(stack).not.toBeVisible();
  // Default zoom is 1, so the 4th column sits past the right edge; frame everything.
  await page.getByRole('button', { name: 'Fit all' }).click();
  await sessions.nth(3).click();
  await expect(stack.locator('.MuiCardActionArea-root')).toHaveCount(2);
  await expect(sessions.nth(3)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(stack.locator('.MuiCardActionArea-root').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(stack.locator('.MuiCardActionArea-root').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(stack.locator('.MuiCardActionArea-root').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sessions.nth(3)).toBeFocused();

  // 130 generated sessions (sing-mock-plans-extra) for the session-id search.
  await page.addInitScript(() => window.localStorage.setItem('sing-mock-plans-extra', '130'));
  await page.goto('/plans');
  const search = page.getByPlaceholder('Search session id…');
  await search.fill('b0000000-0000-4000-8000-00000000001');
  const hits = page.locator('[data-plans-search-hit]');
  await expect(hits.first()).toBeVisible();
  expect(await hits.count()).toBeLessThanOrEqual(10);
  await search.press('Enter');
  await expect(page).toHaveURL(/sid=b0000000-0000-4000-8000-0000000000\d\d/);
  const selected = page.getByRole('region', { name: 'Session carousel' }).locator('[aria-current="true"] .MuiCardActionArea-root');
  await expect(selected).toHaveAttribute('aria-expanded', 'true');

  // ?sid= deep link expands the session once and does not re-expand after collapse.
  await page.goto('/plans?sid=b0000000-0000-4000-8000-000000000005');
  await expect(selected).toContainText(/^b0000000bulk\/51k tokens/);
  await expect(selected).toHaveAttribute('aria-expanded', 'true');
  await selected.click();
  await expect(selected).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(500);
  await expect(selected).toHaveAttribute('aria-expanded', 'false');
});
