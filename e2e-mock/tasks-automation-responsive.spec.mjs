// Phase 3 of the responsive plan: Tasks (board lanes, history table, detail
// sheet, create dialog) and Automation (cron rows, background reorder, create
// dialogs) at phone / landscape-phone / tablet / desktop.
//
// Like shell-mobile-nav.spec.mjs and shell-dock-responsive.spec.mjs, every test
// sets its own viewport, so this file runs in the default `chromium` project
// rather than responsive.spec.mjs's fixed viewport matrix. Navigation is by URL
// (`page.goto('/tasks')`), never e2e/helpers/nav.mjs's `goto()` — that drives
// the rail's More menu, which does not exist at phone width.
//
// Two of the reorder tests run in a touch-enabled context and use `tap()`, so
// "touch-operable" is asserted with touch input, not merely a narrow viewport.
// This is Chromium emulation on a desktop OS — no physical Android/iOS device
// was involved.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900
const NARROW = RESPONSIVE_VIEWPORTS.narrowest;       // 320x667
const LANDSCAPE_PHONE = RESPONSIVE_VIEWPORTS.landscapePhone;

// Several of these drive a create dialog end to end; this box runs other agent
// suites concurrently, so keep the per-test budget the other feature specs use.
test.describe.configure({ timeout: 60_000 });

// ------------------------------------------------------------------ tasks board

// The height of the nearest scrolling ancestor — the window the cards actually
// have. `toBeVisible()` alone is true for a card parked 900px below the fold in
// a 667px viewport (that is exactly how the 114px board window shipped green),
// so every "reachable" claim below pairs an in-viewport check with this.
const scrollWindow = (locator) => locator.evaluate((el) => {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(n).overflowY)) return n.clientHeight;
  }
  return document.documentElement.clientHeight;
});

test('phone: the board shows one lane at a time behind a switcher, and that lane is genuinely on screen', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  // The switcher is the lane head at this width, and it carries every lane's
  // count — so where work sits is readable without switching.
  const switcher = page.getByRole('group', { name: 'Board lane', exact: true });
  await expect(switcher).toBeVisible();
  for (const lane of ['To-Do (1)', 'In Progress (1)', 'In Review (1)', 'Done (1)']) {
    await expect(switcher.getByRole('button', { name: lane, exact: true })).toBeVisible();
  }
  await expect(switcher.getByRole('button', { name: 'To-Do (1)', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Only the selected lane renders…
  const todo = page.getByRole('button', { name: 'Seeded todo card', exact: true });
  await expect(todo).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toHaveCount(0);

  // …at full width, wholly inside the viewport, in a window at least one card
  // tall. Before this fix the window was 114px against a 142px card, so no card
  // was ever fully visible and this assertion pair is what would have caught it.
  const box = await todo.boundingBox();
  expect(box.width).toBeGreaterThan(240);
  await todo.scrollIntoViewIfNeeded();
  // ratio 0.99, not 1: a fractional card height rounds a wholly-visible element
  // to 0.9989 against the viewport box. Still "the entire card", not "any pixel".
  await expect(todo).toBeInViewport({ ratio: 0.99 });
  expect(await scrollWindow(todo)).toBeGreaterThan(box.height);

  // Switching lanes swaps the content and the pressed state — no reload.
  await switcher.getByRole('button', { name: 'Done (1)', exact: true }).click();
  const done = page.getByRole('button', { name: 'Seeded done card', exact: true });
  await expect(done).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toHaveCount(0);
  await done.scrollIntoViewIfNeeded();
  await expect(done).toBeInViewport({ ratio: 0.99 });

  await expectNoPageOverflow(page);
});

// Phase 8 A7 regression: Phosphor's bilingual status legend (StatusLegend,
// task 5.1) is the largest single contributor to Phosphor's phone chrome
// above the board — it's dropped at PHONE_QUERY, where vertical budget is
// scarce, while staying for tablet+ under Phosphor (unchanged there) and
// never rendering under ZAPAC at all (no `theme.nerv`).
test('phone Phosphor: the status legend is hidden (vertical budget), but still renders at tablet width', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toBeVisible();
  await expect(page.getByText('QUEUED', { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);

  await page.setViewportSize(TABLET);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toBeVisible();
  await expect(page.getByText('QUEUED', { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('landscape phone: a card is fully reachable rather than clipped to a 10px lane', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/tasks');

  // 667px wide is tablet width-class, so this keeps the four lanes — what it
  // must not keep is the old geometry, where the dock's default-expanded height
  // left each lane list 10px tall against 207px of cards and no card rendered.
  const card = page.getByRole('button', { name: 'Seeded done card', exact: true });
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 0.99 });
  expect(await scrollWindow(card)).toBeGreaterThan(box.height);
  await expectNoPageOverflow(page);
});

// This is the live, exact 599/600 crossing (isPhone), no reload.
test('live 599/600 crossing preserves an open task detail while swapping the board between four lanes and the one-lane switcher', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await page.goto('/tasks');
  const switcher = page.getByRole('group', { name: 'Board lane', exact: true });
  await expect(switcher).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toBeVisible();

  // 600px is still tablet, so all four lanes remain available.
  await page.setViewportSize({ width: 600, height: PHONE.height });
  await expect(switcher).toHaveCount(0);
  await page.getByRole('button', { name: 'Seeded todo card', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(detail).toBeVisible();

  // 599px is phone. The already-open detail remains mounted through the
  // exact resize; closing it exposes the one-lane switcher.
  await page.setViewportSize({ width: 599, height: PHONE.height });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(switcher).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);

  // Keep the established broad phone transition as well.
  await page.setViewportSize(PHONE);
  await expect(switcher).toBeVisible();

  await page.setViewportSize(TABLET);
  await expect(switcher).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Seeded done card', exact: true })).toBeVisible();
});

test('desktop: the board keeps its four side-by-side lanes', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');

  const todo = await page.getByRole('button', { name: 'Seeded todo card', exact: true }).boundingBox();
  const done = await page.getByRole('button', { name: 'Seeded done card', exact: true }).boundingBox();
  expect(done.x).toBeGreaterThan(todo.x + todo.width); // to the right, not below
  await expectNoPageOverflow(page);
});

test('phone: create a task end to end from the board', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New task' }) });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('title', { exact: true }).fill('Phone-made task');
  await dialog.getByLabel('description', { exact: true }).fill('Created at 375px.');
  // cwd defaults to '~' and the model field is prefilled from the store, so the
  // dialog is submit-ready here (see create-dialogs.spec.mjs).
  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();
  await expect(create).toBeInViewport();
  await create.click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Phone-made task', exact: true })).toBeVisible();
  await expect(page.getByText('To-Do (2)', { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('phone: the task detail sheet keeps its actions reachable and can move the card between lanes by tap', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Seeded todo card', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeInViewport();
  await expect(sheet.getByRole('button', { name: 'View transcript' })).toBeInViewport();
  await expectNoPageOverflow(page);

  // The touch-operable stand-in for dragging a card between lanes: one button
  // per lane the card is not in (its own lane is absent).
  await expect(sheet.getByText('Move to', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'To-Do', exact: true })).toHaveCount(0);
  const target = sheet.getByRole('button', { name: 'In Review', exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.click();

  // The board converges from the pushed `tasks` frame, and the still-open sheet
  // now offers To-Do (the card left that lane) instead of In Review.
  await expect(page.getByText('In Review (2)', { exact: true })).toBeVisible();
  await expect(page.getByText('To-Do (0)', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'In Review', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'To-Do', exact: true })).toBeVisible();
});

test('desktop: the detail sheet has no move buttons — dragging is available there and nothing above 900px changes', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Seeded todo card', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Move to', { exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'In Review', exact: true })).toHaveCount(0);
});

// -------------------------------------------------------------- dense tables

test('phone: the task history table becomes a labelled horizontal scroll region, still full width at desktop', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/tasks?history=1');

  const region = page.getByRole('region', { name: 'Task history (scrolls horizontally)' });
  await expect(region).toBeVisible();
  // Deliberately narrow, not clipped: the table keeps a legible width and the
  // region scrolls to it — no column is cut off, and the page itself does not
  // scroll sideways.
  const inner = await region.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(inner.scroll).toBeGreaterThan(inner.client);
  await expect(page.locator('tr').filter({ hasText: 'Concluded fixture run' })).toBeVisible();
  await expectNoPageOverflow(page);

  // The right-hand action cell is reachable by scrolling the region (not by
  // scrolling the page) — scrollIntoViewIfNeeded scrolls the ancestors that
  // can, which is the region itself.
  const del = page.locator('tr').filter({ hasText: 'Concluded fixture run' })
    .getByRole('button', { name: 'Delete permanently' });
  await del.scrollIntoViewIfNeeded();
  await expect(del).toBeInViewport();
  expect(await region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expectNoPageOverflow(page);

  // Desktop keeps the plain table — no wrapper region at all.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole('region', { name: /scrolls horizontally/ })).toHaveCount(0);
  await expect(page.locator('tr').filter({ hasText: 'Concluded fixture run' })).toBeVisible();
});

test('phone: both automation tables become labelled scroll regions; desktop keeps the plain tables', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/cron');

  const scheduled = page.getByRole('region', { name: 'Scheduled jobs (scrolls horizontally)' });
  const background = page.getByRole('region', { name: 'Background jobs (scrolls horizontally)' });
  await expect(scheduled).toBeVisible();
  await expect(background).toBeVisible();
  for (const region of [scheduled, background]) {
    const m = await region.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(m.scroll).toBeGreaterThan(m.client);
  }
  await expectNoPageOverflow(page);

  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole('region', { name: /scrolls horizontally/ })).toHaveCount(0);
  await expect(page.locator('tr').filter({ hasText: 'Nightly fixture sweep' })).toBeVisible();
});

test('tablet: the dense tables are labelled scroll regions and their far-right row actions stay on screen', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await page.goto('/cron');

  // At 768px the scheduled table is 948px wide in a 634px pane. Without its own
  // region that overflow was absorbed by an ancestor — no page-level overflow,
  // and Status / Run now / Edit / Delete simply off-screen.
  const scheduled = page.getByRole('region', { name: 'Scheduled jobs (scrolls horizontally)' });
  await expect(scheduled).toBeVisible();
  await expect(page.getByRole('region', { name: 'Background jobs (scrolls horizontally)' })).toBeVisible();
  const m = await scheduled.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(m.scroll).toBeGreaterThan(m.client);

  const del = page.locator('tr').filter({ hasText: 'Nightly fixture sweep' }).getByRole('button', { name: 'Delete' });
  await del.scrollIntoViewIfNeeded();
  await expect(del).toBeInViewport();
  expect(await scheduled.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expectNoPageOverflow(page);

  // Same for the ten-column task history table.
  await page.goto('/tasks?history=1');
  await expect(page.getByRole('region', { name: 'Task history (scrolls horizontally)' })).toBeVisible();
  const histDel = page.locator('tr').filter({ hasText: 'Concluded fixture run' })
    .getByRole('button', { name: 'Delete permanently' });
  await histDel.scrollIntoViewIfNeeded();
  await expect(histDel).toBeInViewport();
  await expectNoPageOverflow(page);

  // 900px and up keeps the plain tables, exactly as before.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole('region', { name: /scrolls horizontally/ })).toHaveCount(0);
});

// ------------------------------------------------------- automation on a phone

test('phone: create a scheduled job end to end', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await page.goto('/cron');

  await page.getByRole('button', { name: 'Scheduled job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New scheduled job' })).toBeVisible();

  await dialog.getByLabel('title').fill('Phone-made cron');
  await dialog.getByLabel('description').fill('Created at 375px.');
  await dialog.getByLabel('schedule (cron format, UTC)').fill('0 0 1 1 *');

  const create = dialog.getByRole('button', { name: 'Create' });
  await expect(create).toBeEnabled();
  await expect(create).toBeInViewport();
  await create.click();

  await expect(page.locator('tr').filter({ hasText: 'Phone-made cron' })).toBeVisible();
  await expectNoPageOverflow(page);

  // …and edit it: the row's actions sit at the far right of the scroll region,
  // so this also proves the region's own scrolling reaches them on a phone.
  const row = page.locator('tr').filter({ hasText: 'Phone-made cron' });
  const edit = row.getByRole('button', { name: 'Edit' });
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  const editDialog = page.getByRole('dialog');
  await expect(editDialog.getByRole('heading', { name: 'Edit scheduled job' })).toBeVisible();
  await expect(editDialog.getByLabel('title')).toHaveValue('Phone-made cron');
  await editDialog.getByLabel('title').fill('Phone-edited cron');
  const save = editDialog.getByRole('button', { name: 'Save' });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.locator('tr').filter({ hasText: 'Phone-edited cron' })).toBeVisible();
  await expectNoPageOverflow(page);
});

test.describe('touch reorder', () => {
  test.use({ hasTouch: true });

  test('phone: background jobs reorder by tapping Move up / Move down, not by dragging', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/cron');

    const titles = () => page.locator('table').last().locator('tbody tr td:nth-child(3)').allInnerTexts();
    await expect(page.locator('tr').filter({ hasText: 'Fixture backlog groomer' })).toBeVisible();
    expect(await titles()).toEqual(['Fixture backlog groomer', 'Fixture dependency check']);

    // The drag grip is gone at this width (it cannot be operated by touch), and
    // the first row's "Move up" is correctly disabled.
    await expect(page.locator('[aria-label*="Drag to change the order"]')).toHaveCount(0);
    const rowA = page.locator('tr').filter({ hasText: 'Fixture backlog groomer' });
    await expect(rowA.getByRole('button', { name: 'Move up' })).toBeDisabled();

    // Real touch input, not a mouse click.
    await rowA.getByRole('button', { name: 'Move down' }).tap();
    await expect.poll(titles).toEqual(['Fixture dependency check', 'Fixture backlog groomer']);
    await expectNoPageOverflow(page);
  });

  test('phone: the same reorder works from the keyboard', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/cron');

    const titles = () => page.locator('table').last().locator('tbody tr td:nth-child(3)').allInnerTexts();
    const rowB = page.locator('tr').filter({ hasText: 'Fixture dependency check' });
    const up = rowB.getByRole('button', { name: 'Move up' });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect.poll(titles).toEqual(['Fixture dependency check', 'Fixture backlog groomer']);
  });
});

test('phone: Move down under an active column sort drops the sort and really moves the row', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/cron');

  const titles = () => page.locator('table').last().locator('tbody tr td:nth-child(3)').allInnerTexts();
  await expect(page.locator('tr').filter({ hasText: 'Fixture backlog groomer' })).toBeVisible();

  // Sort by Title (the only sortable table on this route). Ascending happens to
  // match the source order, so the move below is the only thing that can change it.
  await page.getByRole('button', { name: 'Title' }).click();
  await expect.poll(titles).toEqual(['Fixture backlog groomer', 'Fixture dependency check']);

  // Before the fix this was a visible no-op — `sortedRows` re-sorted the result —
  // while still PATCHing the sorted order over the user's stored one.
  await page.locator('tr').filter({ hasText: 'Fixture backlog groomer' })
    .getByRole('button', { name: 'Move down' }).click();
  await expect.poll(titles).toEqual(['Fixture dependency check', 'Fixture backlog groomer']);
  await expectNoPageOverflow(page);
});

// The reorder affordance is gated on `narrow` (isPhone || isTablet), so this
// covers the exact 899/900 edge without dropping the broader transitions.
test('live 899/900 crossing swaps the background jobs row between the drag grip and Move up/down buttons', async ({ page }) => {
  await page.setViewportSize(COMPACT);
  await page.goto('/cron');
  await expect(page.locator('[aria-label*="Drag to change the order"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0);

  await page.setViewportSize({ width: 899, height: COMPACT.height });
  await expect(page.locator('[aria-label*="Drag to change the order"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move up' }).first()).toBeVisible();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 900, height: COMPACT.height });
  await expect(page.locator('[aria-label*="Drag to change the order"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0);

  // Keep the established broad tablet/compact transition coverage too.
  await page.setViewportSize(TABLET);
  await expect(page.locator('[aria-label*="Drag to change the order"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move up' }).first()).toBeVisible();
  await page.setViewportSize(COMPACT);
  await expect(page.locator('[aria-label*="Drag to change the order"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0);
});

test('desktop: the background jobs table keeps its drag grip and gains no move buttons', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/cron');

  await expect(page.locator('[aria-label*="Drag to change the order"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move up' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move down' })).toHaveCount(0);
});

// ------------------------------------------------- dialogs in short viewports

for (const [label, viewport] of [['landscape phone', LANDSCAPE_PHONE], ['phone', PHONE]]) {
  test(`${label}: the New background job dialog scrolls its content and keeps Cancel/Create on screen`, async ({ page }) => {
    test.slow();
    await page.setViewportSize(viewport);
    await page.goto('/cron');

    await page.getByRole('button', { name: 'Background job' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New background job' })).toBeVisible();

    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const create = dialog.getByRole('button', { name: 'Create' });
    await expect(cancel).toBeInViewport();
    await expect(create).toBeInViewport();

    // This is the tallest dialog in the app: at 375px of height its body must
    // be a scroller, and scrolling it to the bottom must not move the actions.
    const body = dialog.locator('.MuiDialogContent-root');
    const m = await body.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(m.scroll).toBeGreaterThan(m.client);
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(cancel).toBeInViewport();
    await expect(create).toBeInViewport();

    await expectNoPageOverflow(page);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
  });
}

test('landscape phone: the task detail sheet keeps its footer actions on screen', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Seeded review card', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(sheet.getByRole('button', { name: 'View transcript' })).toBeInViewport();
  await expect(sheet.getByRole('button', { name: 'Open session' })).toBeInViewport();
  await expectNoPageOverflow(page);
});

// ---------------------------------------------------- 320px, both skins

for (const skin of ['ZAPAC', 'Phosphor Console']) {
  for (const route of ['/tasks', '/cron']) {
    test(`320px ${skin}: ${route} has no page-level horizontal overflow`, async ({ page }) => {
      await seedSkin(page, skin);
      await page.setViewportSize(NARROW);
      await page.goto(route);
      // Wait for the route's own content, not just the shell.
      if (route === '/tasks') await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toBeVisible();
      else await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
      await expectNoPageOverflow(page);
    });
  }
}

// --------------------------------------------- the in-between viewports

for (const [label, viewport] of [['tablet', TABLET], ['compact desktop', COMPACT]]) {
  test(`${label}: /tasks and /cron stay free of page-level overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/tasks');
    await expect(page.getByRole('button', { name: 'Seeded todo card', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto('/cron');
    await expect(page.locator('tr').filter({ hasText: 'Nightly fixture sweep' })).toBeVisible();
    await expectNoPageOverflow(page);
  });
}
