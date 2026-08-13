// Tasks board (kanban + history). The board is fed over the websocket — it
// never fetches /tasks itself — so every assertion here waits on the DOM to
// reflect a pushed 'tasks' frame rather than polling REST.
//
// Deliberately NOT exercised: creating a task. This mock suite covers that
// dialog's cancel-only mechanics separately; these board tests only use seeded
// cards and the mock's REST → WebSocket convergence path.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { goto, openMenu } from '../e2e/helpers/nav.mjs';

// Playwright's dragTo()/mouse.down+move+up did not reliably fire React's
// onDragStart/onDragOver/onDrop for these HTML5-draggable elements under
// headless Chromium (no real OS-level drag). Dispatching the drag events
// directly with a shared DataTransfer — Playwright's documented recipe for
// HTML5 DnD — does.
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

async function setSkin(page, skin) {
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible();
  await page.getByRole('radio').filter({ hasText: skin }).click();
  await expect(page.getByText('Appearance', { exact: true }).first()).toBeVisible();
}

test('all four columns render with their seeded counts', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  await expect(page.getByText('To-Do (1)', { exact: true })).toBeVisible();
  await expect(page.getByText('In Progress (1)', { exact: true })).toBeVisible();
  await expect(page.getByText('In Review (1)', { exact: true })).toBeVisible();
  await expect(page.getByText('Done (1)', { exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card' })).toBeVisible();
});

// Every seeded card AND both seeded history rows carry the identical tag set
// (['fixture', 'ui'] — see fixtures/seed.mjs TAGS) — so with OR-match
// semantics (matchesTags in TasksBoard.jsx), selecting either chip alone can
// never hide a seeded card: there's no fixture data with a different tag
// combination to prove real narrowing against, short of creating a new task
// (which this file avoids — see the file banner). What IS covered: the chips
// render off the seeded tag union, toggling one selects it (and the resulting
// filter still matches every seeded card, which is itself a real assertion —
// a bug that made the filter AND instead of OR would hide cards here), and
// "Clear all" removes the selection.
test('tag filter chips toggle and "Clear all" resets the selection', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  const fixtureChip = page.getByRole('button', { name: 'fixture', exact: true });
  const uiChip = page.getByRole('button', { name: 'ui', exact: true });
  await expect(fixtureChip).toBeVisible();
  await expect(uiChip).toBeVisible();

  await fixtureChip.click();
  // OR-match: every seeded card carries 'fixture' too, so selecting it alone
  // must not hide any of them.
  await expect(page.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seeded done card' })).toBeVisible();

  const clearAll = page.getByRole('button', { name: 'Clear all' });
  await expect(clearAll).toBeVisible();
  await clearAll.click();
  await expect(clearAll).not.toBeVisible();
  await expect(fixtureChip).toBeVisible(); // chip row itself stays
});

test('clicking a card opens the right detail panel; "View transcript" hands off to a right-side transcript sheet with close/Escape/scrim affordances', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
  await card.click();

  // Card click opens a right-sliding detail panel — a dialog named "Task
  // detail". (MUI Drawer renders its Paper with role=dialog +
  // aria-label="Task detail" via slotProps.paper, so the role/name query
  // resolves to the sheet, not the board behind it.)
  const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(dialog).toBeVisible();
  // By role, not by text: the panel's "Task" section renders the seeded
  // description ("Seeded review card — seeded fixture card."), which contains the
  // title as a substring — an unscoped getByText would match both.
  await expect(dialog.getByRole('heading', { name: 'Seeded review card' })).toBeVisible();
  // Stats grid + meta dl render with graceful "—" placeholders — the seeded
  // card has no session, so stats?.[undefined] is undefined.
  await expect(dialog.getByText('Cost', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Tokens', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Turns', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Details', { exact: true })).toBeVisible();
  // The layout-02 sections added alongside the stats grid: the task brief and the
  // board-pipeline activity list, whose current stage is the card's own column.
  await expect(dialog.getByText('Task', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Seeded review card — seeded fixture card.')).toBeVisible();
  await expect(dialog.getByText('Activity', { exact: true })).toBeVisible();
  await expect(dialog.getByText('In Review', { exact: true })).toBeVisible();

  // "Open session" only fires for a card with a LIVE agent session. The seeded
  // card has no sessionId, so the action is disabled (the seed data can't
  // exercise the enabled/selects-terminal path — that needs a live agent).
  await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();

  // "View transcript" closes the detail panel and hands off to TasksBoard's
  // right-sliding TranscriptSheet — a second dialog, named "Transcript", built
  // on the exact same Drawer-over-scrim system (same anchor/width/scrim/close
  // affordances/entrance motion as the detail panel). No sessionId on the
  // seeded card → its body shows the not-found message.
  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(dialog).not.toBeVisible();

  const tx = page.getByRole('dialog', { name: 'Transcript', exact: true });
  await expect(tx).toBeVisible();
  await expect(tx.getByRole('heading', { name: 'Seeded review card', exact: true })).toBeVisible();
  await expect(tx.getByText('No transcript found for this task.')).toBeVisible();

  // Close via the explicit close button.
  await tx.getByRole('button', { name: 'Close' }).click();
  await expect(tx).not.toBeVisible();

  // Reopen via the same handoff and dismiss with Escape.
  await card.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(tx).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tx).not.toBeVisible();

  // Reopen once more and dismiss with a scrim (backdrop) click — coordinate-
  // independent affordances (close button, Escape) are covered above; this
  // proves the backdrop itself also routes to the same onClose.
  await card.click();
  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(tx).toBeVisible();
  await tx.locator('xpath=preceding-sibling::*[contains(@class, "MuiBackdrop-root")]').click({
    position: { x: 8, y: 8 },
  });
  await expect(tx).not.toBeVisible();

  // The detail panel's own Escape-to-close (independent of the handoff above)
  // stays covered too.
  await card.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('drag a card into Done (HTML5 dnd) moves it via POST /tasks/:id/status', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  const card = page.getByRole('button', { name: 'Seeded todo card' });
  const doneColumn = page.getByText(/^Done \(\d+\)$/).locator('xpath=..');

  await html5Drag(page, card, doneColumn);

  // The card is now inside the Done column's DOM subtree.
  await expect(doneColumn.getByRole('button', { name: 'Seeded todo card' })).toBeVisible();
  await expect(page.getByText('Done (2)', { exact: true })).toBeVisible();
  await expect(page.getByText('To-Do (0)', { exact: true })).toBeVisible();
});

test('conclude a card via its hover flag icon (abandon) — confirm then POST /tasks/:id/conclude', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  const card = page.getByRole('button', { name: 'Seeded in-progress card' });
  await card.hover();
  const abandonBtn = card.getByRole('button', { name: /Abandon task/ });

  const confirmMsg = onceConfirm(page, true);
  await abandonBtn.click();
  expect(await confirmMsg).toMatch(/abandon/i);

  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).not.toBeVisible();
  await expect(page.getByText('In Progress (0)', { exact: true })).toBeVisible();
});

test('history view: toggle, every sortable column header, and delete a row', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  // exact:true — a substring match on 'History' also catches the Done card's
  // "Remove (moves to history)" icon button (getByRole names are substring,
  // case-insensitive by default), which is a strict-mode violation.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Board' })).toBeVisible(); // toggle relabels itself

  const concludedRow = page.locator('tr').filter({ hasText: 'Concluded fixture run' });
  const abandonedRow = page.locator('tr').filter({ hasText: 'Abandoned fixture run' });
  await expect(concludedRow).toBeVisible();
  await expect(abandonedRow).toBeVisible();

  // Every sortable header toggles aria-sort asc -> desc on repeated clicks.
  // Indexed by position, not accessible name: the "API time" header wraps its
  // TableSortLabel in a Tooltip, and per README selector rule 2, a Tooltip
  // title becomes the wrapped element's aria-label — which replaces "API
  // time" as that header's computed accessible name entirely, so a
  // name-based query would miss it.
  const headerNames = ['Title', 'Repo', 'Branch', 'Outcome', 'Busy', 'API time', 'Cost', 'Tokens', 'Concluded'];
  for (let i = 0; i < headerNames.length; i++) {
    const col = page.locator('thead th').nth(i);
    // Activate via keyboard (Enter), not a mouse click on the label text — the
    // column is stretched wide by its body content (e.g. Title's wrapped tag
    // chips), so a click coordinate at the label often lands past the actual
    // TableSortLabel hit target. It's a span[role=button][tabindex=0]
    // (MuiButtonBase), so Enter reaches the same onClick handler.
    const label = col.getByText(headerNames[i], { exact: true });
    await label.press('Enter');
    await expect(col, headerNames[i]).toHaveAttribute('aria-sort', 'ascending');
    await label.press('Enter');
    await expect(col, headerNames[i]).toHaveAttribute('aria-sort', 'descending');
  }

  const confirmMsg = onceConfirm(page, true);
  await abandonedRow.getByRole('button', { name: 'Delete permanently' }).click();
  expect(await confirmMsg).toMatch(/permanently delete/i);

  await expect(abandonedRow).not.toBeVisible();
  await expect(concludedRow).toBeVisible();
});

// ---------------------------------------------------------------------------
// Phosphor Console (openspec/changes/implement-phosphor-theme, task 8.3):
// status legend/columns/cards, card-to-dossier behavior, dossier dismissal/
// actions, drag/filter/history regressions, and narrow-viewport overlay
// containment.
//
// Every test gets a fresh page-local mock store, so the same seeded board is
// available regardless of execution order or worker count.
// Exact hex→rgb values below trace to the vendored package's own tokens
// (`phosphor-console-theme/theme/tokens.ts`'s `hue` map) and
// `lib/domainState.js`'s tone table — not invented numbers — mirroring
// e2e/phosphor.spec.mjs's own header note.
test.describe('Tasks board — Phosphor Console', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSkin(page, 'Phosphor Console');
    await goto(page, 'Tasks');
  });

  test('bilingual status legend renders every domain state with its shared tone and fill', async ({ page }) => {
    const pairs = [
      ['待機', 'QUEUED'], ['立案', 'PLANNING'], ['稼働', 'RUNNING'],
      ['審査', 'REVIEW'], ['完了', 'MERGED'], ['異常', 'FAILED'],
    ];
    for (const [jp, en] of pairs) {
      await expect(page.getByText(jp, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(en, { exact: true }).first()).toBeVisible();
    }

    // 'planning'/'failed' are legend-only (no board column maps to either —
    // TasksBoard's COLUMN_DOMAIN only covers queued/running/review/done), so
    // these two never collide with a column's own bilingual caption checked
    // below — proving the shared outline-vs-filled grammar unambiguously.
    const planning = page.getByText('立案', { exact: true }).locator('xpath=..');
    const planningStyle = await planning.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor };
    });
    expect(planningStyle.bg).toBe('rgba(0, 0, 0, 0)'); // outline (not filled) — idle
    expect(planningStyle.color).toBe('rgb(80, 144, 208)'); // blue
    expect(planningStyle.border).toBe('rgb(80, 144, 208)');

    const failed = page.getByText('異常', { exact: true }).locator('xpath=..');
    const failedStyle = await failed.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color };
    });
    // Filled inversion — recorded/terminal state. #F04438, NOT the vendored
    // `hue.redHi` #E2280F this originally asserted: that value is 4.28:1 on the
    // void surface, below AA in both directions (filling doesn't rescue it —
    // black-on-#E2280F is the same ratio), so the adapter in
    // `theme/skins/phosphor.jsx` repoints it. Asserting the old value locked in
    // the contrast bug; this now guards against regressing back to it.
    expect(failedStyle.bg).toBe('rgb(240, 68, 56)');
    expect(failedStyle.color).toBe('rgb(10, 10, 10)'); // void content, never a glow on punched-out text
  });

  // Fix 2 (docs/one-shot/phosphor-layout-02.html:275-279): the column head is
  // now ONE flex row — English label + kanji caption on the left, stamped
  // count on the right, a rule beneath — instead of the label+count line with
  // a separate bilingual caption line below it. Once the kanji sits inline in
  // the SAME element as the label/count, that element's own text content is
  // no longer "<Label> (<n>)" verbatim (it'd read "To-Do待機(2)"), so the
  // locked accessible name (tasks.spec.mjs's `/^To-Do \(\d+\)$/` etc.) now
  // lives on that row's `role="group"` + explicit `aria-label`
  // (TasksBoard.jsx) — a proper ARIA name computation instead of incidental
  // textContent parsing, but still asserting the exact same locked string.
  test('columns keep their locked accessible name and gain an inline bilingual caption + stamped count', async ({ page }) => {
    const checks = [
      [/^To-Do \(\d+\)$/, '待機', 'rgb(60, 156, 108)', false], // queued -> green (greenMap)
      [/^In Progress \(\d+\)$/, '稼働', 'rgb(82, 242, 154)', false], // running -> mint
      [/^In Review \(\d+\)$/, '審査', 'rgb(244, 159, 9)', false], // review -> amber
      [/^Done \(\d+\)$/, '完了', 'rgb(82, 242, 154)', true], // done -> mint, filled
    ];
    for (const [nameRe, jp, colorRgb, filled] of checks) {
      // The locked "<Label> (<n>)" name now comes from `role="group"` +
      // `aria-label`, not raw text content.
      const header = page.getByRole('group', { name: nameRe });
      await expect(header).toBeVisible();

      // The kanji caption renders inline, inside this same header row (its
      // English pairing is already covered by the legend test above, so it's
      // not re-asserted here).
      await expect(header).toContainText(jp);

      // The count Stamp's own text is exactly "(<n>)".
      const stamp = header.getByText(/^\(\d+\)$/);
      const style = await stamp.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      });
      if (filled) {
        expect(style.bg).toBe(colorRgb);
        expect(style.color).toBe('rgb(10, 10, 10)');
      } else {
        expect(style.bg).toBe('rgba(0, 0, 0, 0)');
        expect(style.color).toBe(colorRgb);
      }
    }
  });

  test('a card renders as a void hard-edged console record with its state stamp', async ({ page }) => {
    const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
    // goto()/beforeEach's card-independent clicks leave the pointer wherever it
    // last was — park it before reading resting-state (non-hover) CSS.
    await page.mouse.move(0, 0);

    const cardStyle = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopColor };
    });
    expect(cardStyle.radius).toBe('0px'); // hard edge, no ZAPAC card radius
    expect(cardStyle.bg).toBe('rgb(10, 10, 10)'); // void surface
    expect(cardStyle.border).toBe('rgb(244, 159, 9)'); // review tone (amber), resting — not selected/live

    // Card-top state stamp — fix 3 (peg lines 654-676): the shared domain-state
    // bilingual pair (`lib/domainState.js`'s jp+en), not the task's own free-text
    // `state` string ("awaiting human review") — colored/outlined by the same
    // domain tone as the column (no live agent on this seeded card).
    const stateStamp = card.getByText('審査 REVIEW', { exact: true });
    await expect(stateStamp).toBeVisible();
    const stampStyle = await stateStamp.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color };
    });
    expect(stampStyle.bg).toBe('rgba(0, 0, 0, 0)');
    expect(stampStyle.color).toBe('rgb(244, 159, 9)');

    // Task id — amber mono, every card regardless of its own tone.
    const idText = card.getByText(/^#[0-9a-f]{4}$/i);
    await expect(idText).toHaveCSS('color', 'rgb(244, 159, 9)');

    // Repo line — fix 3 (peg lines 294-295/641): "REPO:<value>" plain text, the
    // green-map label stays chrome-only; the value itself is amber (never a
    // status color, but distinct from the dim-green label per the peg).
    const repoLine = card.getByText('scratch', { exact: true });
    await expect(repoLine).toHaveCSS('color', 'rgb(244, 159, 9)');
  });

  test('activating a card opens the Phosphor dossier, preserving modal/close/handoff/focus-restore behavior', async ({ page }) => {
    const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
    await card.click();

    // Same role/name contract as ZAPAC (locked) — the Drawer paper itself
    // carries role="dialog" + aria-label="Task detail" via slotProps.paper.
    const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Seeded review card' })).toBeVisible();

    // The chamfered void dossier sheet — orange inner edge, no elevation shadow.
    const paperStyle = await dialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, borderLeftColor: cs.borderLeftColor, clipPath: cs.clipPath };
    });
    expect(paperStyle.bg).toBe('rgb(10, 10, 10)');
    expect(paperStyle.borderLeftColor).toBe('rgb(242, 100, 0)'); // orange — chrome, not a status color
    expect(paperStyle.clipPath).not.toBe('none'); // nerv.chamfer()

    await expect(dialog.getByText('指令 · DIRECTIVE')).toBeVisible();
    await expect(dialog.getByText('Cost', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Tokens', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Turns', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Task', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Seeded review card — seeded fixture card.')).toBeVisible();
    await expect(dialog.getByText('Details', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Activity', { exact: true })).toBeVisible();
    await expect(dialog.getByText('In Review', { exact: true })).toBeVisible(); // current pipeline stage

    // "Open session" only fires for a card with a LIVE agent session — same
    // rule as ZAPAC; the seeded card has no sessionId.
    await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();

    // Dismiss with Escape — MUI Drawer's focus trap/restore is shared with
    // ZAPAC, so focus returns to the card that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(card).toBeFocused();

    // Reopen and hand off to TasksBoard's TranscriptSheet — identical handoff
    // to the ZAPAC behavior, into a second dialog named "Transcript".
    await card.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'View transcript' }).click();
    await expect(dialog).not.toBeVisible();
    const tx = page.getByRole('dialog', { name: 'Transcript', exact: true });
    await expect(tx).toBeVisible();
    await expect(tx.getByText('No transcript found for this task.')).toBeVisible();
  });

  test('tag filter chips and the Board/History toggle keep working under Phosphor', async ({ page }) => {
    const fixtureChip = page.getByRole('button', { name: 'fixture', exact: true });
    await expect(fixtureChip).toBeVisible();
    await fixtureChip.click();
    await page.mouse.move(0, 0); // resting state — click() leaves the pointer parked on the chip (:hover)

    // Hard-edged orange fill when active (tagChipPhosphor's `on` branch) — same
    // OR-match guarantee as the ZAPAC version of this test: every seeded
    // card/history row carries 'fixture', so selecting it alone must never
    // hide any of them. `toHaveCSS` polls until the chip's 120ms
    // background-color transition (MUI ButtonBase) settles, unlike a single
    // `getComputedStyle` read right after `.click()`.
    await expect(fixtureChip).toHaveCSS('border-top-left-radius', '0px');
    await expect(fixtureChip).toHaveCSS('background-color', 'rgb(242, 100, 0)');

    const clearAll = page.getByRole('button', { name: 'Clear all' });
    await expect(clearAll).toBeVisible();
    await clearAll.click();
    await expect(clearAll).not.toBeVisible();

    // Board/History segmented control — same accessible names/aria-pressed
    // contract as ZAPAC (segBtnPhosphor only changes the CSS, not the markup).
    const boardBtn = page.getByRole('button', { name: 'Board', exact: true });
    const historyBtn = page.getByRole('button', { name: 'History', exact: true });
    await historyBtn.click();
    await expect(boardBtn).toBeVisible();
    await expect(historyBtn).toHaveAttribute('aria-pressed', 'true');

    // The seeded history row is present in this test's independent mock page.
    await expect(page.locator('tr').filter({ hasText: 'Concluded fixture run' })).toBeVisible();

    await boardBtn.click();
    await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible();
  });

  // FIXED (manual visual review, task 8.6): `tagChipPhosphor`'s active-state
  // text color (web/src/features/tasks/TasksBoard.jsx, `color: on ?
  // t.nerv.hue.void : t.nerv.hue.orange`) never used to paint. The vendored
  // Phosphor MUI theme defaults every `Chip` to `color="success"`, which
  // stamps a `.MuiChip-colorSuccess` class carrying its own `{ color: <mint>
  // }` rule. That selector chains two classes (`.css-x.MuiChip-colorSuccess`)
  // against our sx's single emotion class, so it won on specificity
  // regardless of source order and permanently overrode the intended void
  // text — the active filter chip rendered MINT text on an ORANGE fill
  // instead of the solid "near-black content" figure/ground inversion
  // design.md D4 requires for every recorded/active Phosphor control. Fixed
  // by re-declaring the same `&.MuiChip-colorSuccess` selector (plus
  // `!important`, since equal-specificity cascade order isn't guaranteed) in
  // `tagChipPhosphor` — no vendored-theme edit required.
  test('active tag filter chip inverts to void text on its orange fill', async ({ page }) => {
    const fixtureChip = page.getByRole('button', { name: 'fixture', exact: true });
    await fixtureChip.click();
    await page.mouse.move(0, 0); // resting state — click() leaves the pointer parked on the chip (:hover)
    await expect(fixtureChip).toHaveCSS('background-color', 'rgb(242, 100, 0)'); // fill is correct
    await expect(fixtureChip).toHaveCSS('color', 'rgb(10, 10, 10)'); // text is not — see comment above
  });

  test('drag-and-drop still moves a card via POST /tasks/:id/status under Phosphor', async ({ page }) => {
    const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
    // The column head is now a `role="group"` (fix 2), still a direct child of
    // the drop-target column Stack — `xpath=..` still resolves to that Stack.
    const todoColumn = page.getByRole('group', { name: /^To-Do \(\d+\)$/ }).locator('xpath=..');

    await html5Drag(page, card, todoColumn);

    await expect(todoColumn.getByRole('button', { name: 'Seeded review card' })).toBeVisible();
    await expect(page.getByRole('group', { name: /^In Review \(0\)$/ })).toBeVisible();
  });

  test('the task dossier stays fully within a narrow viewport, sticky actions included', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });

    // The seeded Done card is present in this independent mock page.
    const card = page.getByRole('button', { name: 'Seeded done card', exact: true });
    await card.scrollIntoViewIfNeeded();
    await card.click();

    const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
    await expect(dialog).toBeVisible();

    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    // Visibility is reported as soon as the Drawer starts its slide-in. Wait
    // for that transition to settle before measuring its final bounds.
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(viewport.width + 1);

    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

    // Sticky footer actions remain reachable — not clipped by the frame's own chamfer.
    await expect(dialog.getByRole('button', { name: 'View transcript' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open session' })).toBeVisible();
  });
});
