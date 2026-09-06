// Phase 4 of the responsive plan: Transcripts (SessionHistory + TranscriptView)
// and session creation/terminal at phone / landscape-phone / tablet / compact
// desktop / desktop.
//
// Like the other per-viewport responsive specs (shell-mobile-nav, shell-dock-
// responsive, tasks-automation-responsive), every test sets its own viewport
// and navigates by URL, so this runs in the default `chromium` project rather
// than the fixed responsive-viewport-matrix projects. New session is reached
// through the phone drawer, never the rail's More menu.
import { test, expect } from './fixtures/test.mjs';
import { expectNoPageOverflow, seedSkin, RESPONSIVE_VIEWPORTS } from './helpers/responsive.mjs';
import { RICH_SESSION } from '../web/src/mock/fixtures.js';

const PHONE = RESPONSIVE_VIEWPORTS.phone;               // 375x667
const LANDSCAPE_PHONE = { width: 667, height: 375 };    // >=600px wide -> tablet rail, not the phone switcher
const TABLET = RESPONSIVE_VIEWPORTS.tablet;             // 768x1024
const COMPACT = RESPONSIVE_VIEWPORTS.compactDesktop;    // 1024x768
const DESKTOP = RESPONSIVE_VIEWPORTS.desktop;           // 1440x900

test.describe.configure({ timeout: 60_000 });

const switcher = (page) => page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Sessions', exact: true }) });

async function openRichTranscript(page) {
  await page.goto('/transcripts');
  await expect(page.getByText(/transcripts$/).first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Retry backoff cap/ }).click();
}

// Opens New session from the phone drawer (the rail is unmounted at this
// width — see shell-mobile-nav.spec.mjs) rather than clicking a rail button.
async function phoneNewSession(page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'New session' }).click();
}

// ---------------------------------------------------------- phone: pane switch

test('phone: transcripts show one pane at a time; selecting a session reveals it at full width', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/transcripts');
  await expect(page.getByText(/transcripts$/).first()).toBeVisible({ timeout: 15000 });

  const sw = switcher(page);
  await expect(sw).toBeVisible();
  await expect(sw.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Nothing selected yet — the Transcript pane isn't reachable.
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toBeDisabled();

  // Before this fix the desktop/tablet Rail rendered unconditionally and
  // clamped to a ~228px-wide column on a 375px phone (useResizable's
  // window-derived floor), leaving the transcript pane ~110px wide. The
  // switcher instead gives the full page width to whichever pane is active.
  const row = page.getByRole('button', { name: /Fixture session/ }).first();
  await expect(row).toBeInViewport();
  const rowBox = await row.boundingBox();
  expect(rowBox.width).toBeGreaterThan(300);

  await row.click();
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toBeEnabled();
  const header = page.getByText(/^Fixture session/).first();
  await expect(header).toBeInViewport();
  // Measure the detail pane itself (the View/Chat tab row spans it, stretched
  // by the outer Stack's default align-items:stretch), not the header text —
  // that shares its row with a Resume button, so its own width understates the
  // pane. Before this fix the pane was ~110px wide (a ~228px-wide Rail column
  // on a 375px phone, useResizable's window-derived floor); it now gets the
  // full page width when the switcher shows it.
  const tabRow = page.getByRole('tablist').locator('..');
  const tabRowBox = await tabRow.boundingBox();
  expect(tabRowBox.width).toBeGreaterThan(300);
  await expectNoPageOverflow(page);

  // Switching back to Sessions shows the list again, full width, no reload.
  await sw.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(row).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('phone: 320px wide has no page-level horizontal overflow on Transcripts', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto('/transcripts');
  await expect(page.getByText(/transcripts$/).first()).toBeVisible({ timeout: 15000 });
  await expectNoPageOverflow(page);
});

test('phone (Phosphor Console): the switcher renders and still reaches the transcript', async ({ page }) => {
  await seedSkin(page, 'Phosphor Console');
  await page.setViewportSize(PHONE);
  await openRichTranscript(page);

  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
});

// ------------------------------------------------------- landscape phone / tablet

test('landscape phone: 667px is tablet-width-class, so list and transcript stay side by side with no overflow', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE_PHONE);
  await openRichTranscript(page);

  // No phone switcher at this width (>= PHONE_QUERY's 600px floor) — both
  // panes render together, same as tablet/desktop.
  await expect(page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Sessions', exact: true }) })).toHaveCount(0);
  const resume = page.getByRole('button', { name: 'Resume', exact: true });
  await resume.scrollIntoViewIfNeeded();
  await expect(resume).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('tablet: list and transcript panes both fit, no switcher, no overflow', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await openRichTranscript(page);

  await expect(page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Sessions', exact: true }) })).toHaveCount(0);
  const header = page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true });
  await expect(header).toBeInViewport();
  const tabRow = page.getByRole('tablist').locator('..');
  const tabRowBox = await tabRow.boundingBox();
  expect(tabRowBox.width).toBeGreaterThan(300); // not squeezed into a sliver
  await expectNoPageOverflow(page);
});

test('compact desktop and desktop: unchanged two-pane layout', async ({ page }) => {
  for (const vp of [COMPACT, DESKTOP]) {
    await page.setViewportSize(vp);
    await openRichTranscript(page);
    await expect(page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Sessions', exact: true }) })).toHaveCount(0);
    await expect(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).toBeInViewport();
    await expectNoPageOverflow(page);
  }
});

// --------------------------------------------------------------- long path/title

test('long transcript titles and cwd paths truncate accessibly (title attribute + ellipsis), not with page overflow', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openRichTranscript(page);

  const header = page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true });
  await expect(header).toHaveAttribute('title', `Retry backoff cap - ${RICH_SESSION}`);
  await expect(header).toHaveCSS('text-overflow', 'ellipsis');
  await expect(header).toHaveCSS('white-space', 'nowrap');

  const cwd = page.getByText('/fixture/beta', { exact: true }).first();
  await expect(cwd).toHaveAttribute('title', '/fixture/beta');
  await expectNoPageOverflow(page);
});

// ------------------------------------------------------------- session creation

test('phone: New session is reached from the drawer, and Create stays reachable end to end', async ({ page }) => {
  test.slow();
  await page.setViewportSize(PHONE);
  await page.goto('/tasks');

  await phoneNewSession(page);
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('title (optional)').fill('Phone-made session');
  await dialog.getByLabel('model', { exact: true }).fill('sonnet');
  await page.keyboard.press('Escape'); // close ModelSelect's option popper

  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();
  await expect(create).toBeInViewport();
  await create.click();
  await expect(dialog).toBeHidden();

  await expectNoPageOverflow(page);
});

test('phone: New session dialog fields stay full width and Cancel is reachable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto('/tasks');

  await phoneNewSession(page);
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New session' }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('working directory')).toBeInViewport();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expectNoPageOverflow(page);
});

// ------------------------------------------------------- desktop -> phone crossing

test('desktop -> phone with a transcript open lands on the transcript, not the list', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openRichTranscript(page);
  await expect(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).toBeVisible();

  // No reload — `open()` only switches panes on a click, so entering phone mode
  // has to re-derive the pane or the open transcript is hidden behind the list.
  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`Retry backoff cap - ${RICH_SESSION}`, { exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
});

test('desktop -> phone with nothing selected stays on the session list', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/transcripts');
  await expect(page.getByText(/transcripts$/).first()).toBeVisible({ timeout: 15000 });

  await page.setViewportSize(PHONE);
  const sw = switcher(page);
  await expect(sw.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'Transcript', exact: true })).toBeDisabled();
});
