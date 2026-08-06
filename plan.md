# Command Palette — SHIFT+SHIFT quick-switcher

Multi-session implementation plan. Each phase is subagent-runnable and
self-contained. Build vertical-slice first (Phase 0), then add command
sources tier-by-tier. Keeps main session clean — delegate each phase to a
`senior-software-engineer` subagent with the phase's prompt.

## Goal

SHIFT+SHIFT (double-tap Left Shift, <300ms, no intervening key) opens a
"Navigate to…" palette overlay on any view. Empty input lists all commands
(grouped); typing fuzzy-filters live. ↑↓ select, ↵ run, Esc close. Palette
covers views + sessions + files + settings toggles + actions + info.

## Architecture

Five pieces, layered so each command source plugs in without touching the
palette UI:

1. **Command registry** — `web/src/features/palette/commands.mjs` (pure
   data + factory). Exports `buildCommands(ctx)` → `{id, group, label,
   keywords[], icon, hint, run(), available?(ctx)}`[]. `ctx` is the
   AppShell-provided bag (setView, sendMsg, agents, setActive, …). Each
   feature adds its commands here. SSOT — palette never hardcodes items.
2. **Palette UI** — `web/src/features/palette/CommandPalette.jsx`.
   Presentational: props `{ commands, onRun, onClose }`. Owns input state,
   fuzzy filter, selection index, keyboard nav. No domain logic.
3. **Fuzzy match** — `web/src/features/palette/fuzzy.mjs` (+ `.test.mjs`).
   `score(query, {label, keywords})` → number or null. Substring + initial
   letters + keyword alias. Pure, unit-tested.
4. **SHIFT+SHIFT hook** — `web/src/features/palette/useShiftShift.js`.
   `useShiftShift(onOpen)` — global keydown; double-Shift detection with
   intervening-key reset, repeat-suppression, blur-when-open guard.
5. **AppShell wiring** — `web/src/shell/AppShell.jsx`. Owns `paletteOpen`
   state, builds `ctx` from `useAgents()` + local setters, mounts
   `<CommandPalette>`, calls `useShiftShift(() => setPaletteOpen(true))`.
   Palette calls `cmd.run(ctx)` then closes.

### Command shape (contract)

```js
{
  id: 'view:config',            // unique, stable
  group: 'Views',               // for grouping in list
  label: 'Config',              // primary match target + display
  keywords: ['cfg', 'settings'],// alias match targets
  icon: <SettingsIcon />,       // optional
  hint: 'view',                 // optional right-aligned hint
  available: (ctx) => true,     // optional — hide if false
  run: (ctx) => { ctx.setView('config'); },
}
```

### ctx shape (contract)

AppShell assembles, passes to `buildCommands`:

```js
{
  setView,            // (v) => void
  view,               // current view id
  sendMsg,            // WS message to daemon
  agents, active, setActive,   // sessions
  onNewSession,       // open CreateSessionDialog
  toggleDock, expandDock,
  setSidebarCollapsed,
  // added per phase as needed (see phase contracts)
}
```

## View catalog (source of truth)

Labels for the Views command group. Reuse these labels in palette.

| id         | label       | source        |
|------------|-------------|---------------|
| tasks      | Tasks       | Sidebar.NAV   |
| cron       | Automation  | Sidebar.NAV   |
| usage      | Usage       | Sidebar.NAV   |
| config     | Config      | NAV_ITEMS     |
| hooks      | Hooks       | NAV_ITEMS     |
| sessions   | Transcripts | NAV_ITEMS     |
| skills     | Skills      | NAV_ITEMS     |
| rules      | Rules       | NAV_ITEMS     |
| memory     | Memory      | NAV_ITEMS     |
| explorer   | Explorer    | NAV_ITEMS     |
| history    | History     | NAV_ITEMS     |
| wiki       | Wiki        | NAV_ITEMS     |
| appearance | Appearance  | NAV_ITEMS     |
| status     | Status      | NAV_ITEMS     |

> Consolidation opportunity: export `NAV` from Sidebar and `NAV_ITEMS`
> from AppMenu; build the unified view list once in `commands.mjs`. Do NOT
> merge the two arrays' roles (Sidebar = primary rail, AppMenu = overflow)
> — only their data feeds the palette.

## Session ops (sendMsg contract, from SessionDock)

- create: `{ t:'create', cwd, title, model, scopes }`
- fork:   `{ t:'fork', id, title }`
- respawn:`{ t:'respawn', id }`
- reattach:`{ t:'reattach', id }`
- kill:   `{ t:'kill', id }`
- external: `POST /session/external { id }`
- view transcript: open `sessions` view with that session (existing
  `viewTranscript` path in AppShell).

---

## Phases

Each phase: scope · files · acceptance · subagent notes. Run one phase per
subagent; main thread reviews the diff + build, then commits.

### Phase 0 — Foundation (vertical slice, ships Views only)

**Scope:** palette opens on SHIFT+SHIFT, lists all 14 views, fuzzy-filters,
Enter navigates. End-to-end usable before any other command source exists.

**Files (new):**
- `web/src/features/palette/CommandPalette.jsx`
- `web/src/features/palette/useShiftShift.js`
- `web/src/features/palette/fuzzy.mjs`
- `web/src/features/palette/fuzzy.test.mjs`
- `web/src/features/palette/commands.mjs` (Views group only for now)

**Files (edit):**
- `web/src/shell/AppShell.jsx` — paletteOpen state, ctx, mount palette,
  `useShiftShift`. Place palette at top-level render (z-index above dock).
- `web/src/shell/Sidebar.jsx` — `const NAV` → `export const NAV`.

**Acceptance:**
- SHIFT+SHIFT on Tasks view opens palette; typing "cfg" → Config top hit;
  Enter → view switches to Config; palette closes; focus restored.
- Shift+letter (capital typing) does NOT open palette.
- Esc closes; clicking outside closes.
- `fuzzy.test.mjs` passes; `pnpm build` green.

**Subagent prompt sketch:** give the command shape + ctx contract + view
catalog table + the double-Shift algorithm spec (below). Have it read
AppShell.jsx (view/setView location), Sidebar.jsx (NAV). Use ctx_patch.

**Double-Shift algorithm:**
```
let lastShift = 0;
on keydown:
  if e.key === 'Shift':
    const now = performance.now();
    if (now - lastShift < 300) onOpen();
    lastShift = now;
    return;
  lastShift = 0;            // any other key resets
on keyup e.key === 'Shift': /* no-op; rely on keydown timestamps */
```
Guard: ignore if `e.repeat` (some keyboards repeat Shift). Also ignore when
a text input in the palette itself is focused (palette handles its own
keys). Optional: ignore if a modifier other than Shift is held.

### Phase 1 — Sessions commands

**Scope:** palette lists sessions (switch by title) + session ops
(new/fork/respawn/reattach/kill/external/transcript).

**Files (edit):**
- `commands.mjs` — add Sessions group. Commands:
  - `session:switch:<id>` per live agent (label = session title or id
    prefix; `available` = agent not detached). run → `setActive(id)`.
  - `session:new` → `ctx.onNewSession()`.
  - `session:fork:<id>`, `respawn`, `reattach`, `kill`, `external` —
    `sendMsg` per contract above; external → fetch `/session/external`.
  - `session:transcript:<id>` → `ctx.viewTranscript(agent)`.
- `AppShell.jsx` — extend ctx with `onNewSession`, `viewTranscript`,
  `toggleDock`, `expandDock` (some already in scope).

**Acceptance:** typing a session title surfaces it; Enter focuses it;
"kill <title>" or selecting kill command kills; "new session" opens
CreateSessionDialog. Detached sessions hidden from switch list.

**Subagent notes:** read SessionDock.jsx for exact op signatures +
`viewTranscript`/`onNewSession` props already threaded in AppShell.

### Phase 2 — Files (Explorer fuzzy-open)

**Scope:** "open <filename>" commands using the existing `/fs/read` +
Explorer tab API. Switch to Explorer view and open the file.

**Files (edit):**
- `commands.mjs` — Files group. Needs a file-list source:
  - Option A (lazy): palette query hits a new endpoint `/fs/search?q=…`
    returning matching paths under the Explorer root. Add server route +
    `commands.mjs` async command support.
  - Option B (no backend): use Explorer's loaded tree if available via a
    ref/context; fall back to no-file commands if tree empty.
  Recommend A — matches existing `/config/search` pattern (HooksEditor
  uses `/config/search` + `/codex-config/search`).

**Files (new, if A):** `server/fs-search.mjs` + route in `server/index.mjs`
+ Vite proxy prefix `/fs` in `web/vite.config.mjs` (check if `/fs` already
proxied — `/fs/read` implies yes).

**Acceptance:** type a filename → list of matching paths; Enter → Explorer
view opens with that file in a new tab.

**Subagent notes:** verify `/fs` proxy entry exists; mirror
`/config/search` route shape. Async commands: `run` may be async; palette
closes after `run` resolves.

### Phase 3 — Settings toggles

**Scope:** autosave on/off, theme (light/dark/system), sidebar collapse,
dock minimize/restore.

**Files (edit):**
- `commands.mjs` — Toggles group. Each command `run` flips a setting.
- Theme: reuse existing theme mode setter (find in AppShell/Appearance
  view — `useColorScheme` or a context). If no global setter exposed, add
  one and have Appearance view reuse it (do NOT duplicate).
- Autosave: ConfigEditor + ExplorerPanel each own `autosave` state —
  palette can't reach per-panel state cleanly. Decision: expose a shared
  `useAutosave` hook OR limit the toggle to "current editor panel". Flag
  this in phase prompt — subagent picks the simpler per CLAUDE.md
  simplicity-first.

**Acceptance:** "autosave off" toggles it (visible in Config editor
icon); "dark" switches theme; "collapse sidebar" collapses.

**Subagent notes:** read Appearance view + AppShell theme wiring first.
Avoid adding a new setting store — reuse what exists.

### Phase 4 — Actions (daemon/processes/tasks/crons)

**Scope:** "restart server", "open processes", "new task", "conclude
task", "delete task", create/list cron.

**Files (edit):**
- `commands.mjs` — Actions group.
- AppShell ctx: add `onOpenRestart`, `onOpenProcesses` (already props to
  AppMenu — reuse), task actions from `useTaskActions` (`moveTask`,
  `concludeTask`, `deleteHistory`).
- Task commands: list tasks from `useAgents().tasks` as switch targets;
  "conclude <task>", "delete <task>".
- Cron: reuse cron create dialog/list (Automation view) — "new cron" opens
  it.

**Acceptance:** "restart" triggers restart flow; "new task" opens task
creation; selecting a task from list focuses it.

### Phase 5 — Info + keybindings help

**Scope:** "show keybindings" (lists all global shortcuts incl. ALT+Up/Down,
SHIFT+SHIFT, Ctrl+S), "show capabilities", "usage/cost", "version".

**Files (new):** `web/src/features/palette/KeybindingsDialog.jsx` (or reuse
a generic Info dialog). Build keybinding list from a single
`web/src/features/palette/keybindings.mjs` data file so the help and any
future onboarding share one SSOT.

**Acceptance:** "keybindings" opens a dialog listing every global shortcut;
data sourced from one file.

### Phase 6 — Tests + docs

**Scope:** e2e + history record.
- `e2e/palette.spec.mjs` — open palette, filter, run a view switch, run a
  session switch; assert SHIFT+SHIFT does not fire during capital typing
  in an input.
- Update `HISTORY.md` / project history doc per repo convention with
  palette feature record (as-built).
- Add palette to README/capabilities if a user-facing feature list exists.

**Acceptance:** new e2e green; `pnpm test` + `pnpm build` green.

---

## Cross-cutting rules

- **Token budget:** every phase is one subagent. Main thread: review diff
  (caveman-reviewer or read the changed regions via ctx_read), run
  `pnpm build`, commit per phase. Do not let main accumulate phase code.
- **Subagent tool contract:** read-only exploration fine; implementation
  uses ctx_read(mode=anchored) → ctx_patch. No native Grep/Glob/Read for
  exploration (policy) — ctx_* only.
- **Surgical:** each phase touches only its listed files + commands.mjs.
  No drive-by refactor. Match existing style (caveman-dense comments,
  arrow fns, MUI `sx`).
- **No new deps.** MUI + React already present. Fuzzy is hand-rolled (~30
  lines) — no fuse.js.
- **Accessibility:** palette input is a real `<input>` with `aria-label`;
  list items `role="option"`; Esc closes; focus trap inside palette while
  open; restore focus to prior element on close.
- **Key conflicts:** while palette open, it owns ↑↓↵Esc — stop
  propagation so ALT+Up/Down (session/view cycle) and xterm don't also
  fire. Close on any `run`.

## Risks / open decisions

- **SHIFT+SHIFT false positives:** terminal apps sometimes intercept Shift.
  Mitigation: only act on `e.key === 'Shift'` keydown with no other
  modifier; reset on any non-Shift keydown. If users report conflict, add a
  settings toggle to change the chord (defer — YAGNI until reported).
- **Autosave toggle reach** (Phase 3): per-panel state vs shared hook —
  decide in-phase; prefer reuse.
- **Async commands** (Phase 2): `run` returning a Promise changes close
  timing. Decide: close immediately, or close on resolve. Recommend close
  immediately (navigation feels instant); surface errors via existing
  toast.
- **Performance:** large command lists (many sessions/files) — cap
  rendered rows (virtualize only if >500; YAGNI until then), compute fuzzy
  via `useMemo` on `[query, commands]`.