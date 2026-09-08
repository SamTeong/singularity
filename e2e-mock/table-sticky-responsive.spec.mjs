import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;

async function seedCronRows(page, count) {
  await page.evaluate(async (rowCount) => {
    await Promise.all(Array.from({ length: rowCount }, (_, index) => fetch('/api/crons', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `Sticky cron ${index + 1}`,
        description: `Seed row ${index + 1}.`,
        cronExpr: '0 0 1 1 *',
        cwd: '/mock/sticky-crons',
        enabled: false,
      }),
    }).then((response) => response.json())));
  }, count);
}

async function seedHistoryRows(page, count) {
  await page.evaluate(async (rowCount) => {
    for (let index = 0; index < rowCount; index += 1) {
      const created = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `Sticky history ${index + 1}`,
          description: `Seed row ${index + 1}.`,
          repo: '/mock/sticky-history',
          model: 'claude',
          implModel: 'claude',
          reviewerModel: 'claude',
        }),
      }).then((response) => response.json());
      await fetch(`/api/tasks/${created.task.id}/conclude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'completed' }),
      });
    }
  }, count);
}

async function expectStickyScrollableTable(page, region, farRight) {
  await expect(region).toBeVisible();
  const header = region.locator('thead th').first();
  await expect(header).toBeVisible();

  const dimensions = await region.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(['auto', 'scroll']).toContain(dimensions.overflowY);

  await region.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(80);

  const pinned = await region.evaluate((el) => {
    const headerTop = el.querySelector('thead th').getBoundingClientRect().top;
    return { headerTop, regionTop: el.getBoundingClientRect().top };
  });
  expect(Math.abs(pinned.headerTop - pinned.regionTop)).toBeLessThanOrEqual(2);

  await farRight.scrollIntoViewIfNeeded();
  await expect(farRight).toBeInViewport();
  expect(await region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
}

test('phone: Cron Jobs and task history retain sticky headers in bounded, two-axis table scrollers', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await page.goto('/cron');
  await seedCronRows(page, 16);
  await expect(page.getByText('Sticky cron 16', { exact: true })).toBeVisible();

  const scheduled = page.getByRole('region', { name: 'Scheduled jobs (scrolls horizontally)' });
  const cronDelete = page.locator('tr').filter({ hasText: 'Sticky cron 16' }).getByRole('button', { name: 'Delete' });
  await expectStickyScrollableTable(page, scheduled, cronDelete);
  await expectNoPageOverflow(page);

  await page.goto('/tasks?history=1');
  await seedHistoryRows(page, 16);
  await expect(page.getByText('Sticky history 16', { exact: true })).toBeVisible();

  const history = page.getByRole('region', { name: 'Task history (scrolls horizontally)' });
  const historyDelete = page.locator('tr').filter({ hasText: 'Sticky history 16' }).getByRole('button', { name: 'Delete permanently' });
  await expectStickyScrollableTable(page, history, historyDelete);
  await expectNoPageOverflow(page);
});
