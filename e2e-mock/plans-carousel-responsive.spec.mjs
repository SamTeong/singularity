import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';

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
    const first = el.children[0].getBoundingClientRect();
    const second = el.children[1].getBoundingClientRect();
    return first.right - second.left;
  });
  expect(overlap).toBeGreaterThan(0);
  const rotatedNeighbor = await deck.evaluate((el) => {
    const center = getComputedStyle(el.children[0]).transform;
    const neighbor = getComputedStyle(el.children[1]).transform;
    return neighbor.startsWith('matrix3d(') && neighbor !== center;
  });
  expect(rotatedNeighbor).toBe(true);

  const bounds = await deck.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 128, bounds.y + bounds.height / 2, { steps: 5 });
  await page.mouse.up();
  const frontIndex = () => deck.evaluate((el) => [...el.children].findIndex((child) => child.getAttribute('aria-current') === 'true'));
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
