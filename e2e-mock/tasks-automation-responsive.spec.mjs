// Tasks at phone width (one-lane board, create, detail sheet move-by-tap,
// history scroll region) plus the automation lost-response retry. Every test
// sets its own viewport and navigates by URL, so this runs in the default
// `chromium` project. The rail's More menu does not exist at phone width.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;     // 375x667
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop; // 1440x900

// The height of the nearest scrolling ancestor — the window the cards actually
// have. `toBeVisible()` alone is true for a card parked below the fold.
const scrollWindow = (locator) => locator.evaluate((el) => {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(n).overflowY)) return n.clientHeight;
  }
  return document.documentElement.clientHeight;
});

test('phone: one-lane board, create a task, move a card by tap, history scrolls horizontally', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  await test.step('one lane at a time behind a switcher that carries every count', async () => {
    const switcher = page.getByRole('group', { name: 'Board lane', exact: true });
    for (const lane of ['To-Do (1)', 'In Progress (1)', 'In Review (1)', 'Done (1)']) {
      await expect(switcher.getByRole('button', { name: lane, exact: true })).toBeVisible();
    }
    await expect(switcher.getByRole('button', { name: 'To-Do (1)', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const todo = page.getByRole('button', { name: 'Seeded todo card', exact: true });
    await expect(todo).toBeVisible();
    await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toHaveCount(0);
    const box = await todo.boundingBox();
    expect(box.width).toBeGreaterThan(240);
    await todo.scrollIntoViewIfNeeded();
    // ratio 0.99: a fractional card height rounds a wholly-visible element to 0.9989.
    await expect(todo).toBeInViewport({ ratio: 0.99 });
    expect(await scrollWindow(todo)).toBeGreaterThan(box.height);

    await switcher.getByRole('button', { name: 'Done (1)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toBeInViewport();
    await expect(todo).toHaveCount(0);
    await switcher.getByRole('button', { name: 'To-Do (1)', exact: true }).click();
    await expectNoPageOverflow(page);
  });

  await test.step('create a task end to end', async () => {
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('title', { exact: true }).fill('Phone-made task');
    await dialog.getByLabel('description', { exact: true }).fill('Created at 375px.');
    const create = dialog.getByRole('button', { name: 'Create', exact: true });
    await expect(create).toBeEnabled();
    await expect(create).toBeInViewport();
    await create.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Phone-made task', exact: true })).toBeVisible();
    await expect(page.getByText('To-Do (2)', { exact: true })).toBeVisible();
  });

  await test.step('detail sheet keeps actions reachable and moves the card by tap', async () => {
    await page.getByRole('button', { name: 'Seeded todo card', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Task detail', exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeInViewport();
    await expect(sheet.getByRole('button', { name: 'View transcript' })).toBeInViewport();
    // One button per lane the card is not in (its own lane is absent).
    await expect(sheet.getByText('Move to', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'To-Do', exact: true })).toHaveCount(0);
    const target = sheet.getByRole('button', { name: 'In Review', exact: true });
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await expect(page.getByText('In Review (2)', { exact: true })).toBeVisible();
    await expect(page.getByText('To-Do (1)', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'In Review', exact: true })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'To-Do', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  await test.step('history table is a labelled horizontal scroll region; desktop keeps the plain table', async () => {
    await page.goto('/tasks?history=1');
    const region = page.getByRole('region', { name: 'Task history (scrolls horizontally)' });
    await expect(region).toBeVisible();
    const inner = await region.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(inner.scroll).toBeGreaterThan(inner.client);
    const del = page.locator('tr').filter({ hasText: 'Concluded fixture run' })
      .getByRole('button', { name: 'Delete permanently' });
    await del.scrollIntoViewIfNeeded();
    await expect(del).toBeInViewport();
    expect(await region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expectNoPageOverflow(page);

    await page.setViewportSize(DESKTOP);
    await expect(page.getByRole('region', { name: /scrolls horizontally/ })).toHaveCount(0);
    await expect(page.locator('tr').filter({ hasText: 'Concluded fixture run' })).toBeVisible();
  });

  await test.step('live 599/600 crossing keeps an open task detail and swaps four lanes for the switcher', async () => {
    const switcher = page.getByRole('group', { name: 'Board lane', exact: true });
    await page.setViewportSize({ width: 600, height: PHONE.height });
    await page.goto('/tasks');
    await expect(switcher).toHaveCount(0);
    await page.getByRole('button', { name: 'Seeded todo card', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Task detail', exact: true });
    await expect(detail).toBeVisible();
    await page.setViewportSize({ width: 599, height: PHONE.height });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(switcher).toBeVisible();
    await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toHaveCount(0);
  });
});

test('automation creates survive a lost response without duplicates', async ({ page }) => {
  test.slow();
  await page.goto('/cron');
  const scheduledJob = page.getByRole('button', { name: 'Scheduled job' });
  await expect(scheduledJob).toBeVisible();
  await page.evaluate(() => {
    const lost = new Set();
    window.__automationKeys = [];
    const original = window.fetch;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const response = await original(...args);
      const path = new URL(url, location.origin).pathname;
      if (method === 'POST' && /\/(crons|background\/jobs)$/.test(path) && !lost.has(path)) {
        lost.add(path);
        window.__automationKeys.push(headers.get('Idempotency-Key'));
        throw new TypeError('lost response');
      }
      if (method === 'POST' && /\/(crons|background\/jobs)$/.test(path)) window.__automationKeys.push(headers.get('Idempotency-Key'));
      return response;
    };
  });

  // Reads must not consume the one-shot POST response loss.
  const cronReadSucceeded = await page.evaluate(() => fetch('/api/crons').then((response) => response.ok));
  expect(cronReadSucceeded).toBe(true);

  await scheduledJob.click();
  const cronDialog = page.getByRole('dialog');
  await cronDialog.getByLabel('title').fill('Retry-safe cron');
  await cronDialog.getByLabel('description').fill('The first response is lost.');
  await cronDialog.getByRole('button', { name: 'Create' }).click();
  await expect(cronDialog.getByText('lost response')).toBeVisible();
  await cronDialog.getByRole('button', { name: 'Create' }).click();
  await expect(cronDialog).not.toBeVisible();
  await expect(page.locator('tr').filter({ hasText: 'Retry-safe cron' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__automationKeys)).toHaveLength(2);
  expect(await page.evaluate(() => new Set(window.__automationKeys).size)).toBe(1);

  await page.getByRole('button', { name: 'Background job' }).click();
  const backgroundDialog = page.getByRole('dialog');
  await backgroundDialog.getByLabel('title').fill('Retry-safe background');
  await backgroundDialog.getByLabel('description').fill('Normal create after retry.');
  await backgroundDialog.getByRole('button', { name: 'Create' }).click();
  await expect(backgroundDialog.getByText('lost response')).toBeVisible();
  await backgroundDialog.getByRole('button', { name: 'Create' }).click();
  await expect(backgroundDialog).not.toBeVisible();
  await expect(page.locator('tr').filter({ hasText: 'Retry-safe background' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__automationKeys)).toHaveLength(4);
  expect(await page.evaluate(() => new Set(window.__automationKeys.slice(2)).size)).toBe(1);
});
