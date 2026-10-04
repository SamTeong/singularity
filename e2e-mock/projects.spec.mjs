// Projects view: an ordered list of git repo toplevels, each with a baked-in
// git-status readout (web/src/mock/routes/projects.js). Same conventions as
// config.spec.mjs (html5Drag recipe, gotoView/openMenu from e2e/helpers/nav.mjs).
import { test, expect } from './fixtures/test.mjs';
import { gotoView, gotoRail, gotoMenu, openMenu } from '../e2e/helpers/nav.mjs';
import { expectNoPageOverflow } from './helpers/responsive.mjs';
import { PROJECT_PATHS } from '../web/src/mock/fixtures.js';

const repoName = (p) => p.split('/').pop();
const cards = (page) => page.locator('[data-testid="project-card"]');
const cardFor = (page, path) => cards(page).filter({ hasText: repoName(path) });
// The drag handle is its own draggable element inside the card (a Tooltip'd
// grip icon), same pattern as the background jobs row grip — the card itself
// is only the drop target.
const gripIn = (card) => card.locator('[aria-label*="Drag to change the order"]');
// Cards start collapsed; clicking blank card space (top-left padding corner)
// expands details (counts, last commit, summary).
const toggle = (card) => card.click({ position: { x: 4, y: 4 } });

async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

// The name Typography is the first `.MuiTypography-root` in each card (name,
// then secondary full-path text) — reads DOM order, independent of the grid's
// visual column layout.
const cardOrder = (page) => cards(page).evaluateAll((els) => els.map((el) => el.querySelector('button[aria-expanded]')?.textContent));

async function openPicker(page) {
  await page.getByRole('button', { name: 'Add folder' }).click();
  return page.getByRole('dialog');
}

test('opens from the More menu directly below Wiki', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  const items = await page.getByRole('menuitem').allTextContents();
  const wikiIdx = items.findIndex((t) => t.includes('Wiki'));
  const projectsIdx = items.findIndex((t) => t.includes('Projects'));
  expect(projectsIdx).toBe(wikiIdx + 1);
  await page.getByRole('menuitem', { name: 'Projects', exact: true }).click();
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();
});

test('cards start collapsed; clicking blank card space toggles details per card', async ({ page }) => {
  await gotoView(page, 'Projects');
  const clean = cardFor(page, PROJECT_PATHS.clean);
  const dirty = cardFor(page, PROJECT_PATHS.dirty);
  await expect(clean).toContainText('↑2 ↓0');
  await expect(clean).not.toContainText('Tidy release notes');
  await expect(dirty).not.toContainText('staged 2');
  // Collapsed counts render as icon + number, labelled via tooltip.
  await expect(dirty.getByLabel('staged 2')).toBeVisible();
  await expect(dirty.getByLabel('stash 1')).toBeVisible();

  await toggle(clean);
  await expect(clean).toContainText('Tidy release notes');
  await expect(dirty).not.toContainText('staged 2');

  // Action buttons keep their own meaning and don't toggle.
  await clean.getByRole('button', { name: 'Refresh project' }).click();
  await expect(clean).toContainText('Tidy release notes');

  await toggle(clean);
  await expect(clean).not.toContainText('Tidy release notes');
});

test('all project actions report successful outcomes', async ({ page }) => {
  await gotoView(page, 'Projects');
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
  await page.getByRole('button', { name: 'Refresh all' }).click();
  await expect(page.getByText('All projects refreshed')).toBeVisible();
});

test('Git body, HTTP, and network failures include useful details', async ({ page }) => {
  await gotoView(page, 'Projects');
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/projects/git')) {
        const { op } = JSON.parse(init.body);
        if (op === 'fetch') return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'remote rejected' }), { status: 200 }));
        if (op === 'rebase') return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'upstream unavailable' }), { status: 503 }));
        return Promise.reject(new Error('offline'));
      }
      return original(input, init);
    };
  });
  const clean = cardFor(page, PROJECT_PATHS.clean);
  for (const [name, text] of [
    ['git fetch', 'git fetch failed for sing-clean: remote rejected'],
    ['git rebase', 'git rebase failed for sing-clean: upstream unavailable'],
    ['git fetch + rebase', 'git fetch + rebase failed for sing-clean: offline'],
  ]) {
    await clean.getByRole('button', { name, exact: true }).click();
    await expect(page.getByText(text)).toBeVisible();
  }
});

test('project refresh failure and refresh-all aggregate include failing project details', async ({ page }) => {
  await gotoView(page, 'Projects');
  await page.evaluate((dirtyPath) => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/projects/status') && url.includes(encodeURIComponent(dirtyPath))) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'status unavailable' }), { status: 503 }));
      }
      return original(input, init);
    };
  }, PROJECT_PATHS.dirty);
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Refresh project' }).click();
  await expect(page.getByText('Refresh sing-dirty failed: status unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh all' }).click();
  await expect(page.getByText(/Refresh all failed:.*sing-dirty: status unavailable/)).toBeVisible();
});

test('stacked outcome toasts expire independently and hover pauses their drain', async ({ page }) => {
  await gotoView(page, 'Projects');
  const clean = cardFor(page, PROJECT_PATHS.clean);
  const first = page.getByText('git fetch succeeded for sing-clean');
  const second = page.getByText('git rebase succeeded for sing-clean');
  await clean.getByRole('button', { name: 'git fetch', exact: true }).click();
  await expect(first).toBeVisible();
  await first.hover();
  await page.waitForTimeout(1000);
  await clean.getByRole('button', { name: 'git rebase', exact: true }).click();
  await expect(second).toBeVisible();
  await first.hover();
  await expect(second).toHaveCount(0, { timeout: 15000 });
  await expect(first).toBeVisible();
  await page.mouse.move(0, 0); // unhover: the drain resumes only once :hover clears
  await expect(first).toHaveCount(0, { timeout: 13000 });
});

test('the LLM summary is fetched only when a card is expanded, once per refresh', async ({ page }) => {
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
  await gotoView(page, 'Projects');
  const clean = cardFor(page, PROJECT_PATHS.clean);
  await expect(clean).toContainText('↑2 ↓0');
  expect(await page.evaluate(() => window.__summaryFetches)).toBe(0);

  await toggle(clean);
  await expect(clean).toContainText('Tidied up the release notes wording');
  await toggle(clean);
  await toggle(clean);
  expect(await page.evaluate(() => window.__summaryFetches)).toBe(1);

  await clean.getByRole('button', { name: 'Refresh project' }).click();
  await expect.poll(() => page.evaluate(() => window.__summaryFetches)).toBe(2);
});

test('seeded cards render with status chips', async ({ page }) => {
  await gotoView(page, 'Projects');
  await expect(cards(page)).toHaveCount(3);
  for (const p of Object.values(PROJECT_PATHS)) await toggle(cardFor(page, p));

  const clean = cardFor(page, PROJECT_PATHS.clean);
  await expect(clean.getByText('main', { exact: true })).toBeVisible();
  await expect(clean).toContainText('origin/main');
  await expect(clean).toContainText('↑2 ↓0');
  await expect(clean).toContainText('Tidy release notes');

  const dirty = cardFor(page, PROJECT_PATHS.dirty);
  await expect(dirty).toContainText('staged 2');
  await expect(dirty).toContainText('modified 3');
  await expect(dirty).toContainText('untracked 1');
  await expect(dirty).toContainText('stash 1');

  const noUpstream = cardFor(page, PROJECT_PATHS.noUpstream);
  await expect(noUpstream.getByText('no upstream', { exact: true })).toBeVisible();
  await expect(noUpstream).toContainText('untracked 2');
});

test('cards show committed/uncommitted summary bullets, and a clean tree has no Uncommitted section', async ({ page }) => {
  await gotoView(page, 'Projects');
  for (const p of Object.values(PROJECT_PATHS)) await toggle(cardFor(page, p));

  const clean = cardFor(page, PROJECT_PATHS.clean);
  await expect(clean).toContainText('Tidied up the release notes wording');
  await expect(clean).not.toContainText('Uncommitted');
  await expect(clean).toContainText('summary: opus');

  const dirty = cardFor(page, PROJECT_PATHS.dirty);
  await expect(dirty).toContainText('Reworked the widget layout');
  await expect(dirty).toContainText('Still tuning the widget spacing');

  const noUpstream = cardFor(page, PROJECT_PATHS.noUpstream);
  await expect(noUpstream).toContainText('Recent commits');
  await expect(noUpstream).toContainText('Local experiment');
  // The deterministic fallback shows no source line.
  await expect(noUpstream).not.toContainText('summary:');
});

test('add via picker: a new path adds a card, the same path does not duplicate', async ({ page }) => {
  await gotoView(page, 'Projects');
  const before = await cards(page).count();

  const dialog = await openPicker(page);
  await dialog.getByRole('textbox').fill('/home/mock/repos/sing-new');
  await dialog.getByRole('button', { name: 'Select' }).click();
  await expect(cards(page)).toHaveCount(before + 1);
  await expect(cardFor(page, '/home/mock/repos/sing-new')).toBeVisible();

  const dialog2 = await openPicker(page);
  await dialog2.getByRole('textbox').fill('/home/mock/repos/sing-new');
  await dialog2.getByRole('button', { name: 'Select' }).click();
  await expect(cards(page)).toHaveCount(before + 1);
});

test('a non-repo path shows the add error', async ({ page }) => {
  await gotoView(page, 'Projects');
  const dialog = await openPicker(page);
  // The path field takes focus on open, so typing a path needs no click.
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await dialog.getByRole('textbox').fill('/home/mock/not-a-repo');
  await dialog.getByRole('button', { name: 'Select' }).click();
  await expect(page.getByRole('alert')).toContainText('not a git repository');
});

test('delete removes a card', async ({ page }) => {
  await gotoView(page, 'Projects');
  const target = cardFor(page, PROJECT_PATHS.noUpstream);
  await expect(target).toBeVisible();
  await target.getByRole('button', { name: 'Remove project' }).click();
  await expect(cardFor(page, PROJECT_PATHS.noUpstream)).toHaveCount(0);
});

test('delete shows an Undo toast that restores the card to its slot', async ({ page }) => {
  await gotoView(page, 'Projects');
  const before = await cardOrder(page);
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
  await expect(cardFor(page, PROJECT_PATHS.dirty)).toHaveCount(0);

  await expect(page.getByText(`Removed ${repoName(PROJECT_PATHS.dirty)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(cardFor(page, PROJECT_PATHS.dirty)).toBeVisible();
  await expect.poll(() => cardOrder(page)).toEqual(before);
});

test('leaving Projects dismisses its Undo toast', async ({ page }) => {
  await gotoView(page, 'Projects');
  const targetPath = PROJECT_PATHS.dirty;
  await cardFor(page, targetPath).getByRole('button', { name: 'Remove project' }).click();
  const undoToast = page.getByText(`Removed ${repoName(targetPath)}`);
  await expect(undoToast).toBeVisible();

  await gotoRail(page, 'Tasks');
  await expect(undoToast).toHaveCount(0);
  await gotoMenu(page, 'Projects');
  await expect(cardFor(page, PROJECT_PATHS.clean)).toBeVisible();
  await expect(cardFor(page, targetPath)).toHaveCount(0);
});

// The drain animation's end is the dismiss timer (no setTimeout) — prove it fires.
test('Undo toast auto-dismisses when its drain animation ends', async ({ page }) => {
  test.setTimeout(30000);
  await gotoView(page, 'Projects');
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
  const toast = page.getByText(`Removed ${repoName(PROJECT_PATHS.dirty)}`);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0); // hovering the toast pauses the drain
  await expect(toast).toHaveCount(0, { timeout: 15000 });
});

test('deleting two cards stacks two Undo toasts at once', async ({ page }) => {
  await gotoView(page, 'Projects');
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
  await cardFor(page, PROJECT_PATHS.noUpstream).getByRole('button', { name: 'Remove project' }).click();

  await expect(page.getByText(`Removed ${repoName(PROJECT_PATHS.dirty)}`)).toBeVisible();
  await expect(page.getByText(`Removed ${repoName(PROJECT_PATHS.noUpstream)}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(2);
});

for (const [undoOrder, firstUndo] of [['deletion order', 0], ['reverse order', 1]]) {
  test(`undoing stacked adjacent deletions in ${undoOrder} preserves card order`, async ({ page }) => {
    await gotoView(page, 'Projects');
    const before = await cardOrder(page);
    await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
    await cardFor(page, PROJECT_PATHS.noUpstream).getByRole('button', { name: 'Remove project' }).click();

    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Undo' }).nth(firstUndo).click();
    await page.getByRole('button', { name: 'Undo' }).nth(0).click();

    await expect.poll(() => cardOrder(page)).toEqual(before);
  });
}

test('undo preserves the current order of surviving cards', async ({ page }) => {
  await gotoView(page, 'Projects');
  await cardFor(page, PROJECT_PATHS.dirty).getByRole('button', { name: 'Remove project' }).click();
  await expect(cardFor(page, PROJECT_PATHS.dirty)).toHaveCount(0);
  await html5Drag(page, gripIn(cardFor(page, PROJECT_PATHS.noUpstream)), cardFor(page, PROJECT_PATHS.clean));
  await expect.poll(() => cardOrder(page)).toEqual([repoName(PROJECT_PATHS.noUpstream), repoName(PROJECT_PATHS.clean)]);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => cardOrder(page)).toEqual([
    repoName(PROJECT_PATHS.noUpstream), repoName(PROJECT_PATHS.clean), repoName(PROJECT_PATHS.dirty),
  ]);
});

test('drag-reorder changes the order', async ({ page }) => {
  await gotoView(page, 'Projects');
  const before = await cardOrder(page);
  expect(before).toEqual([repoName(PROJECT_PATHS.clean), repoName(PROJECT_PATHS.dirty), repoName(PROJECT_PATHS.noUpstream)]);

  // The card itself is not draggable — only its grip handle is.
  await expect(cards(page).nth(0)).not.toHaveAttribute('draggable', 'true');
  await expect(gripIn(cards(page).nth(0))).toHaveAttribute('draggable', 'true');

  await html5Drag(page, gripIn(cards(page).nth(0)), cards(page).nth(2));

  // Dragging down lands after the target, so the last slot is reachable.
  await expect.poll(() => cardOrder(page)).toEqual([repoName(PROJECT_PATHS.dirty), repoName(PROJECT_PATHS.noUpstream), repoName(PROJECT_PATHS.clean)]);

  // Dragging up lands before the target, so the first slot is reachable.
  await html5Drag(page, gripIn(cards(page).nth(2)), cards(page).nth(0));
  await expect.poll(() => cardOrder(page)).toEqual([repoName(PROJECT_PATHS.clean), repoName(PROJECT_PATHS.dirty), repoName(PROJECT_PATHS.noUpstream)]);
});

test('refresh-all re-fetches status for every card', async ({ page }) => {
  await gotoView(page, 'Projects');
  await page.evaluate(() => {
    window.__statusFetches = 0;
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const [input] = args;
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/projects/status')) window.__statusFetches++;
      return orig(...args);
    };
  });
  await page.getByRole('button', { name: 'Refresh all' }).click();
  await expect.poll(() => page.evaluate(() => window.__statusFetches)).toBeGreaterThanOrEqual(3);
});

test('expand all / collapse all toggles every card at once', async ({ page }) => {
  await gotoView(page, 'Projects');
  await expect(cards(page)).toHaveCount(3);
  const toggles = () => cards(page).locator('button[aria-expanded]');
  await expect(toggles()).toHaveCount(3);
  for (const t of await toggles().all()) await expect(t).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('button', { name: 'Expand all' }).click();
  for (const t of await toggles().all()) await expect(t).toHaveAttribute('aria-expanded', 'true');

  await page.getByRole('button', { name: 'Collapse all' }).click();
  for (const t of await toggles().all()) await expect(t).toHaveAttribute('aria-expanded', 'false');

  // Native button: keyboard Enter toggles just that card.
  const first = toggles().first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(toggles().nth(1)).toHaveAttribute('aria-expanded', 'false');
});

test('phone width (375px): cards are single column, no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/projects');
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();
  await expect(cards(page)).toHaveCount(3);

  const b0 = await cards(page).nth(0).boundingBox();
  const b1 = await cards(page).nth(1).boundingBox();
  expect(Math.abs(b0.x - b1.x)).toBeLessThan(2);

  await expectNoPageOverflow(page);
});
