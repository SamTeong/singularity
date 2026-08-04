// Navigation helpers. There is no router — AppShell keeps the active view in a
// `sing-view` localStorage key, so the URL is always '/' and deep-linking means
// seeding that key before load.
//
// The two non-obvious moves are inherited from the console scanner this suite
// replaced: press Escape before opening the More menu (a lingering menu backdrop
// otherwise eats the click and the next open times out), and match skin radios
// by hasText, because their accessible name is label + description.
//
// Selector policy: MUI stamps data-testid="<Name>Icon" on SvgIcon in development
// ONLY — the suite drives the production bundle, where those attributes are gone.
// Select by role + accessible name (Tooltip titles become aria-labels, which is
// how the icon-only buttons are reachable at all).

export const RAIL_VIEWS = ['Tasks', 'Automation', 'Usage'];
export const MENU_VIEWS = ['Config', 'Hooks', 'Skills', 'Rules', 'Memory', 'Explorer', 'Transcripts', 'Wiki', 'Appearance', 'Status'];
export const SKINS = ['ZAPAC', 'Phosphor Console'];

// view ids as stored in localStorage, keyed by the label the user clicks.
export const VIEW_IDS = {
  Tasks: 'tasks', Automation: 'cron', Usage: 'usage', Config: 'config', Hooks: 'hooks',
  Skills: 'skills', Rules: 'rules', Memory: 'memory', Explorer: 'explorer', Transcripts: 'sessions', Wiki: 'wiki',
  Appearance: 'appearance', Status: 'status',
};

// A locator that only resolves once the given view has actually mounted —
// every view is lazy-loaded behind AppShell's <Suspense fallback="Loading…">,
// so a fixed sleep after a nav click was racing that mount instead of proving
// it happened. One stable, state-independent landmark per view id:
//  - the rail-based panels (config/hooks/rules/memory/wiki/sessions/skills) all
//    share the RailHeader toolbar, whose search box renders unconditionally —
//    unlike an EmptyState (e.g. "Select a hook"), it's still there after a spec
//    has made a selection, so it stays valid on a second visit in the same test.
//  - tasks/cron/usage/appearance/status aren't RailHeader panels; each gets its
//    own always-present heading/button/label instead.
const VIEW_LANDMARK = {
  tasks: (page) => page.getByText(/To-Do \(\d+\)/),
  cron: (page) => page.getByRole('button', { name: 'Scheduled job' }),
  usage: (page) => page.getByRole('button', { name: /collapse usage|expand usage/i }).first(),
  config: (page) => page.getByPlaceholder('Search config…'),
  hooks: (page) => page.getByPlaceholder('Search hooks…'),
  skills: (page) => page.getByPlaceholder('Search skills…'),
  rules: (page) => page.getByPlaceholder('Search rules…'),
  memory: (page) => page.getByPlaceholder('Search memory…'),
  explorer: (page) => page.getByPlaceholder('Search files…'),
  sessions: (page) => page.getByPlaceholder('Search transcripts…'),
  wiki: (page) => page.getByPlaceholder('Search wiki…'),
  appearance: (page) => page.getByRole('heading', { name: 'Appearance' }),
  status: (page) => page.getByText('Provider status', { exact: true }),
};

// Wait on `id`'s landmark rather than a fixed sleep. Falls back to a short
// settle for anything not in the map above (there is nothing that should hit
// this branch today, but it keeps a bad/renamed id from hanging the suite).
async function settle(page, id) {
  const landmark = VIEW_LANDMARK[id];
  if (!landmark) return page.waitForTimeout(400);
  await landmark(page).waitFor({ state: 'visible' });
}

export async function openMenu(page) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More', exact: true }).click();
}

export async function gotoRail(page, label) {
  await page.locator('aside').getByText(label, { exact: true }).click();
  await settle(page, VIEW_IDS[label]);
}

export async function gotoMenu(page, name) {
  await openMenu(page);
  await page.getByRole('menuitem', { name, exact: true }).click();
  await settle(page, VIEW_IDS[name]);
}

// Click through to a view by its label, picking rail vs menu automatically.
export async function goto(page, label) {
  if (RAIL_VIEWS.includes(label)) return gotoRail(page, label);
  return gotoMenu(page, label);
}

// Load straight into a view without clicking — seeds localStorage pre-navigation.
export async function gotoView(page, label) {
  const id = VIEW_IDS[label] || label;
  await page.addInitScript((v) => window.localStorage.setItem('sing-view', v), id);
  await page.goto('/');
  await settle(page, id);
}

// Switch skin via Appearance. Remounts the whole shell (theme registry is keyed
// by skin id), so re-wait afterwards. Idempotent: clicking the active skin is a no-op.
export async function setSkin(page, skin) {
  await gotoMenu(page, 'Appearance');
  await page.getByRole('radio').filter({ hasText: skin }).click();
  // The remount lands back on Appearance (view id is unchanged by a skin
  // switch — only localStorage's skin key moves), so the same landmark applies.
  await settle(page, 'appearance');
}

// PERSISTENT_VIEWS (config/hooks/rules/memory/wiki/sessions) stay mounted with
// display:none once visited, so an unscoped text/CSS query can match a hidden
// panel. There is no <main> landmark to scope to — prefer getByRole (display:none
// is out of the accessibility tree, so hidden panels drop out for free), and wrap
// text/CSS locators in visible() when they don't have a role.
export const visible = (locator) => locator.locator('visible=true');
