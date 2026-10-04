import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_SKINS, seedSkin } from './helpers/responsive.mjs';

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

test('carousel and board session cards share the same dark styling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/plans');
  const card = page.getByRole('region', { name: 'Session carousel' }).locator('[aria-current="true"] .MuiCard-root');
  await expect(card).toBeVisible();
  const deckBox = await page.getByRole('region', { name: 'Session carousel' }).boundingBox();
  expect(deckBox.height).toBe(156);
  const box = await card.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(deckBox.y + deckBox.height);
  const sampleAppearance = (el) => ({
    background: getComputedStyle(el).backgroundColor,
    color: getComputedStyle(el).color,
    captionColor: getComputedStyle(el.querySelector('.MuiTypography-caption')).color,
  });
  const carouselAppearance = await card.evaluate(sampleAppearance);
  expect(box.width).toBeGreaterThan(365);
  expect(box.width).toBeLessThan(395);
  const fontSize = await card.locator('.MuiTypography-caption').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThan(15);
  expect(fontSize).toBeLessThan(17);
  await page.getByRole('button', { name: 'Switch to board view' }).click();
  const boardCards = page.locator('.react-flow__node-session .MuiCard-root');
  await expect(boardCards.first()).toBeVisible();
  const boardAppearance = await boardCards.first().evaluate(sampleAppearance);
  expect(boardAppearance).toEqual(carouselAppearance);
  expect(await boardCards.first().evaluate((el) => getComputedStyle(el).width)).toBe('380px');
  const boardFontSize = await boardCards.first().locator('.MuiTypography-caption').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(boardFontSize).toBe(fontSize);
  const firstBoardCard = await boardCards.nth(0).boundingBox();
  const secondBoardCard = await boardCards.nth(1).boundingBox();
  expect(firstBoardCard.x + firstBoardCard.width).toBeLessThan(secondBoardCard.x);
  await boardCards.first().locator('.MuiCardActionArea-root').click();
  await expect(page.locator('.react-flow__node-planStack')).not.toBeVisible();
  await boardCards.nth(3).locator('.MuiCardActionArea-root').click();
  const stack = page.locator('.react-flow__node-planStack');
  await expect(stack).toBeVisible();
  const planCards = stack.locator('.MuiCard-root');
  await expect(planCards).toHaveCount(2);
  const secondBefore = await planCards.nth(1).boundingBox();
  await planCards.nth(0).locator('.MuiCardActionArea-root').click();
  await expect(stack.getByText('Finish fleet section')).toBeVisible();
  await expect.poll(async () => (await planCards.nth(1).boundingBox()).y).toBeGreaterThan(secondBefore.y + 20);
  const firstExpanded = await planCards.nth(0).boundingBox();
  const secondAfter = await planCards.nth(1).boundingBox();
  expect(secondAfter.y).toBeGreaterThanOrEqual(firstExpanded.y + firstExpanded.height);
});

test('board arrow keys traverse sessions and their plan stack', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/plans?layout=board');
  const sessions = page.locator('.react-flow__node-session .MuiCardActionArea-root');
  const stack = page.locator('.react-flow__node-planStack');
  await expect(sessions.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(stack).toBeVisible();
  await expect(sessions.first()).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(stack.locator('.MuiCardActionArea-root').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sessions.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(sessions.nth(4)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(sessions.first()).toBeFocused();

  await sessions.first().click();
  await expect(stack).not.toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(sessions.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sessions.first()).toBeFocused();

  await sessions.first().click();
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
});

// 130 generated sessions (plus the 7 fixtures inside the 3d window) = 137.
const BULK = 130;
const TOTAL = 137;
const seedBulk = (page) => page.addInitScript((n) => window.localStorage.setItem('sing-mock-plans-extra', String(n)), BULK);
const viewportZoom = (page) => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

for (const skin of RESPONSIVE_SKINS) {
  for (const [name, size] of [['phone', { width: 375, height: 667 }], ['desktop', { width: 1440, height: 900 }]]) {
    test(`Plans carousel stays bounded and fully reachable with ${TOTAL} sessions (${skin}, ${name})`, async ({ page }) => {
      await page.setViewportSize(size);
      await seedSkin(page, skin);
      await seedBulk(page);
      await page.goto('/plans');
      const deck = page.getByRole('region', { name: 'Session carousel' });
      const counter = page.getByText(/^\d+ \/ \d+$/);
      await expect(counter).toHaveText(`1 / ${TOTAL}`);
      await expect(deck.locator('[aria-current="true"] .MuiCardActionArea-root')).toBeFocused();
      await expect(deck.locator(':scope > *')).toHaveCount(7);

      // Previous from the first card wraps to the last, which is then selected.
      await page.getByRole('button', { name: 'Previous session' }).click();
      await expect(counter).toHaveText(`${TOTAL} / ${TOTAL}`);
      await expect(deck.locator('[aria-current="true"]')).toHaveCount(1);
      expect(await deck.locator(':scope > *').count()).toBeLessThanOrEqual(7);
      await page.getByRole('button', { name: 'Next session' }).click();
      await expect(counter).toHaveText(`1 / ${TOTAL}`);
      await page.getByRole('button', { name: 'Next session' }).click();
      await expect(counter).toHaveText(`2 / ${TOTAL}`);

      // Keyboard: arrows act on the expanded selected card; they move and wrap.
      const selected = deck.locator('[aria-current="true"] .MuiCardActionArea-root');
      await selected.click();
      await expect(selected).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('ArrowLeft');
      await expect(counter).toHaveText(`1 / ${TOTAL}`);
      await page.keyboard.press('ArrowLeft');
      await expect(counter).toHaveText(`${TOTAL} / ${TOTAL}`);
      await page.keyboard.press('ArrowRight');
      await expect(counter).toHaveText(`1 / ${TOTAL}`);
      expect(await deck.locator(':scope > *').count()).toBeLessThanOrEqual(7);
      await expectNoPageOverflow(page);
    });

    test(`Plans board opens readable and Fit all zooms out with ${TOTAL} sessions (${skin}, ${name})`, async ({ page }) => {
      await page.setViewportSize(size);
      await seedSkin(page, skin);
      await seedBulk(page);
      await page.goto('/plans?layout=board');
      await expect(page.locator('.react-flow__node-session').first()).toBeVisible();
      await expect.poll(() => viewportZoom(page)).toBeCloseTo(1, 2);
      await expectNoPageOverflow(page);
      await page.getByRole('button', { name: 'Fit all' }).click();
      await expect.poll(() => viewportZoom(page)).toBeLessThan(0.5);
      await expectNoPageOverflow(page);
    });
  }
}

test.describe('Plans timeframe defaults', () => {
  const counter = (page) => page.getByText(/^\d+ \/ \d+$/);

  test('first visit is 3d without a preset in the URL', async ({ page }) => {
    await page.goto('/plans');
    await expect(counter(page)).toHaveText('1 / 7');
    await expect(page).not.toHaveURL(/preset=/);
  });

  test('a saved timeframe wins over the 3d default', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('sing-plans-timeframe', JSON.stringify({ preset: 'all', from: '', to: '' })));
    await page.goto('/plans');
    await expect(counter(page)).toHaveText('1 / 12');
  });

  test('an invalid ?preset degrades to 3d', async ({ page }) => {
    await page.goto('/plans?preset=bogus');
    await expect(counter(page)).toHaveText('1 / 7');
  });
});

test('invalid Plans status and layout are removed while valid timeframe and unrelated params remain', async ({ page }) => {
  await page.goto('/plans?status=bogus&layout=invalid&preset=all&from=2026-09-01&to=2026-09-30&keep=here');

  await expect(page.getByRole('region', { name: 'Session carousel' })).toBeVisible();
  await expect(page.getByText(/^1 \/ 12$/)).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const params = new URLSearchParams(location.search);
    return [params.has('status'), params.has('layout'), params.get('preset'), params.get('from'), params.get('to'), params.get('keep')];
  })).toEqual([false, false, 'all', '2026-09-01', '2026-09-30', 'here']);

  await page.goto('/plans?status=active&layout=board&keep=here');
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const params = new URLSearchParams(location.search);
    return [params.get('status'), params.get('layout'), params.get('keep')];
  })).toEqual(['active', 'board', 'here']);
});
