// Tasks board. The board is fed over the websocket — it never fetches /tasks
// itself — so the assertion here waits on the DOM to reflect a pushed 'tasks'
// frame after a real mutation rather than polling REST. Filters, the detail
// panel, conclude, history and the Phosphor skin are covered by e2e-mock/tasks.
//
// Deliberately NOT exercised: creating a task via "+ Task". createTask()
// (server/tasks.mjs) unconditionally calls reg.create(), which calls
// ensureTrusted(cwd) — that writes to the REAL ~/.claude.json on this
// machine (server/agents.mjs:267,289..298), not anything under the sandbox's
// SINGULARITY_HOME. The suite's contract (e2e/README.md) promises "Nothing
// here can reach the user's real ... ~/.claude"; task creation breaks that
// promise even though it isn't named in the README's "Never drive these"
// list. So this file only moves a seeded card.
import { test, expect } from './fixtures/test.mjs';
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
