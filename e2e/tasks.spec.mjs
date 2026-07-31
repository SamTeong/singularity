// Tasks board (kanban + history). The board is fed over the websocket — it
// never fetches /tasks itself — so every assertion here waits on the DOM to
// reflect a pushed 'tasks' frame rather than polling REST.
//
// Deliberately NOT exercised: creating a task via "+ Task". createTask()
// (server/tasks.mjs) unconditionally calls reg.create(), which calls
// ensureTrusted(cwd) — that writes to the REAL ~/.claude.json on this
// machine (server/agents.mjs:267,289..298), not anything under the sandbox's
// SINGULARITY_HOME. The suite's contract (e2e/README.md) promises "Nothing
// here can reach the user's real ... ~/.claude"; task creation breaks that
// promise even though it isn't named in the README's "Never drive these"
// list. So this file only reads/moves/concludes/deletes the seeded cards —
// see the tag-filter test below for how that limits what can be proven.
import { test, expect, onceConfirm } from './fixtures/test.mjs';
import { goto } from './helpers/nav.mjs';
import { sessionId } from './fixtures/paths.mjs';

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

const TODO_ID = sessionId(1001);
const INPROGRESS_ID = sessionId(1002);

// This machine regularly runs several agent sessions (and their own Playwright
// suites) concurrently, so the default 30s/test budget (playwright.config.mjs)
// is tight under that shared-CPU contention even though every interaction here
// completes in well under a second in isolation. A longer per-file budget
// absorbs that noise without masking a real regression (a hung/broken
// interaction still fails — just after more retries).
test.describe.configure({ timeout: 60_000 });

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

test('clicking a card opens the right detail panel (not the dock); view-transcript, dock toggle, and close all work', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  // exact:true — once the dock opens its header's accessible name ("Collapse
  // Seeded review card transcript") contains "Seeded review card" as a
  // substring, so a non-exact match on the card would become ambiguous then.
  const card = page.getByRole('button', { name: 'Seeded review card', exact: true });
  await card.click();

  // Card click now opens a right-sliding detail panel — a dialog named "Task
  // detail" — instead of the transcript dock directly. (MUI Drawer renders its
  // Paper with role=dialog + aria-label="Task detail" via slotProps.paper, so
  // the role/name query resolves to the sheet, not the board behind it.)
  const dialog = page.getByRole('dialog', { name: 'Task detail', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Seeded review card')).toBeVisible();
  // Stats grid + meta dl render with graceful "—" placeholders — the seeded
  // card has no session, so stats?.[undefined] is undefined.
  await expect(dialog.getByText('Cost', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Tokens', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Turns', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Details', { exact: true })).toBeVisible();

  // "Open session" only fires for a card with a LIVE agent session. The seeded
  // card has no sessionId, so the action is disabled (the seed data can't
  // exercise the enabled/selects-terminal path — that needs a live agent).
  await expect(dialog.getByRole('button', { name: 'Open session' })).toBeDisabled();

  // "View transcript" hands off to the shared dockable transcript panel and
  // closes this panel. No sessionId on the seeded card → the dock shows the
  // not-found message — the same surface the card click used to open directly.
  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('No transcript found for this task.')).toBeVisible();

  // The dock the card click used to open directly is now reached via the
  // panel's "View transcript" — exercise its collapse + dock-side toggle so
  // that behaviour stays covered after the card→panel change. Header is
  // role=button, aria-label swaps Expand|Collapse with the panelMin toggle;
  // freshly opened it is not minimized, so "Collapse ...". Bind both names up
  // front — the accessible name flips with the state, so a locator built from
  // the pre-toggle name resolves to nothing once the label has moved.
  const collapseHeader = page.getByRole('button', { name: 'Collapse Seeded review card transcript' });
  const expandHeader = page.getByRole('button', { name: 'Expand Seeded review card transcript' });
  await expect(collapseHeader).toBeVisible();
  await collapseHeader.click();
  await expect(expandHeader).toBeVisible();
  await expandHeader.click(); // back to expanded for the dock-side toggle below
  await expect(collapseHeader).toBeVisible();

  const dockRight = page.getByRole('button', { name: 'Dock right' });
  await expect(dockRight).toBeVisible();
  await dockRight.click();
  await expect(page.getByRole('button', { name: 'Dock bottom' })).toBeVisible();

  // Re-open the panel and dismiss it with Escape (a scrim click routes to the
  // same onClose, but Escape is coordinate-independent and robust to the
  // right-docked transcript panel sharing the right edge).
  await card.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('drag a card into Done (HTML5 dnd) moves it via POST /tasks/:id/status', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Tasks');

  // stubNetwork's `**/status*` glob is method-agnostic — it also matches this
  // app route's POST /tasks/:id/status and would answer it with the fake
  // STATUS_STUB (no `ok` field) instead of ever reaching the daemon. Register a
  // more specific route ahead of it (routes run last-registered-first) that
  // sends this one straight to the real network.
  await page.route('**/tasks/*/status', (route) => route.continue());

  const card = page.getByRole('button', { name: 'Seeded todo card' });
  const doneColumn = page.getByText(/^Done \(\d+\)$/).locator('xpath=..');

  const [statusResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/tasks/${TODO_ID}/status`) && r.request().method() === 'POST'),
    html5Drag(page, card, doneColumn),
  ]);
  const body = await statusResp.json();
  expect(body.ok).toBe(true);
  expect(body.task.column).toBe('done');

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
  const [concludeResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/tasks/${INPROGRESS_ID}/conclude`) && r.request().method() === 'POST'),
    abandonBtn.click(),
  ]);
  expect(await confirmMsg).toMatch(/abandon/i);
  const body = await concludeResp.json();
  expect(body.ok).toBe(true);

  await expect(page.getByRole('button', { name: 'Seeded in-progress card' })).not.toBeVisible();
  await expect(page.getByText('In Progress (0)', { exact: true })).toBeVisible();
});

test('history view: toggle, every sortable column header, and delete a row', async ({ page }) => {
  // 9 headers x 2 toggles is the most sequential UI work of any test in this
  // file — under this machine's contention (see the describe.configure above)
  // it occasionally needs more than the 60s file default, same as the
  // heavier cytoscape test in wiki.spec.mjs.
  test.setTimeout(90_000);
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
  const [delResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/tasks/history/${sessionId(1006)}`) && r.request().method() === 'DELETE'),
    abandonedRow.getByRole('button', { name: 'Delete permanently' }).click(),
  ]);
  expect(await confirmMsg).toMatch(/permanently delete/i);
  const body = await delResp.json();
  expect(body.ok).toBe(true);

  await expect(abandonedRow).not.toBeVisible();
  await expect(concludedRow).toBeVisible();
});
