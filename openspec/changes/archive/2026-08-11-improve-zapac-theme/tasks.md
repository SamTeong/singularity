## 1. Foundation — tokens & glass helpers

- [x] 1.1 Audit `getTokens()` output against `layout-02.html`'s CSS vars; list any tokens the mockup needs that the contract does not expose (gradient stops, meter track, nav-active bg, chip bg).
- [x] 1.2 Extend `web/src/shell/shellStyles.js` (or add an app-level style helper beside it) with the shared glass recipe + mockup-only tokens, reading `getTokens()` where possible; do NOT edit the vendored `@zapac/mui-theme`.
- [x] 1.3 If any net-new token belongs on the skin, add it to `web/src/theme/skins/zapac.jsx`; confirm `assertSkinContract` still passes (no console warnings in dev).
- [x] 1.4 Verify the ambient gradient background (skin `Background`) reads correctly behind the new glass surfaces in both light and dark mode.

## 2. Sidebar restyle + new widgets

- [x] 2.1 Restyle `web/src/shell/Sidebar.jsx` to the layout-02 brand mark + "New session" primary + glass rail.
- [x] 2.2 Add the gradient active-nav edge indicator, elevated active background, and bold active label.
- [x] 2.3 Add per-view count pills (Tasks, Automation) wired to `useAgents` counts; ensure they update on live data.
- [x] 2.4 Add the "Usage · 5h window" mini-bar panel wired to `useAgents.usage` (labelled bar + % per provider).
- [x] 2.5 Add the daemon-status footer (connected dot + `127.0.0.1:<port>`) wired to `useAgents.connected`; reflect disconnected state.

## 3. View topbar — segmented control + primary action

- [x] 3.1 Restyle the Tasks topbar (title + live subtitle) in `TasksBoard.jsx` to layout-02.
- [x] 3.2 Replace the Board/History text button with a segmented control reflecting + switching `showHistory` (keep it keyboard-operable and focus-ringed).
- [x] 3.3 Restyle the "New task" action as the gradient primary button; keep its `onAdd` wiring and visible focus ring.

## 4. Kanban board & terminal dock restyle

- [x] 4.1 Restyle columns with dot-marked headers; KEEP header text format `<Label> (<n>)` exactly (e.g. `To-Do (1)`) so `tasks.spec.mjs` stays valid.
- [x] 4.2 Restyle task cards as glass surfaces with status pill, repo/branch, stats line, and tag chips; keep card `role=button` + aria-label = title, drag handlers, and hover action icons intact.
- [x] 4.3 Restyle the tag-filter chip row and "Clear all" to the mockup while preserving their roles/labels.
- [x] 4.4 Restyle `web/src/shell/SessionDock.jsx` header/session-list/terminal chrome to layout-02; keep dock resize + minimize behavior.

## 5. Task detail panel (replaces card → transcript dock)

- [x] 5.1 Add a `TaskDetailPanel` component: right-anchored glass sheet + scrim (layout-05 mechanics via MUI `Drawer`/`Modal`), `role=dialog` aria-label "Task detail", Escape/scrim/close dismiss, focus trap + focus restore, `prefers-reduced-motion` respected.
- [x] 5.2 Populate it from the selected task + existing `stats`/`agents` data: title, status pill, id, repo/branch, stats row (cost/tokens/turns) with graceful placeholders when stats are missing, tags/metadata.
- [x] 5.3 In `TasksBoard.jsx`, add `detailTask` state and change the card `activate` to open the panel instead of `openTranscript`/`onSelect` (Board only).
- [x] 5.4 Add panel actions: "Open session" → `onSelect(task.sessionId)` (only when a live session exists, else disabled/hidden); "View transcript" → existing `openTranscript(...)` path.
- [x] 5.5 Confirm History (row → transcript) and the shared dockable transcript panel are unchanged and still reused by "View transcript".
- [x] 5.6 Ensure one panel at a time: derive the panel's data from the live task list by id each render (reflects live stat/status updates; activating another card swaps content), and close/handle gracefully when the open task is concluded, moved, or removed.

## 6. Tests & verification

- [x] 6.1 Rewrite the "clicking a card opens the transcript dock…" test in `e2e/tasks.spec.mjs` to assert: card → detail panel opens; stats/metadata visible; "View transcript" shows "No transcript found for this task." (seeded cards have no sessionId); close via Escape/scrim.
- [x] 6.2 Add coverage for the "Open session" action state (selects terminal when a live session exists, else disabled/hidden).
- [x] 6.3 Confirm the untouched assertions still hold: column counts, tag chips, drag-to-Done, hover-abandon, History table.
- [x] 6.4 Run `pnpm test:e2e` (full build + Playwright) and `pnpm test` (server unit) — both green; `appearance.spec.mjs`, `smoke.spec.mjs`, and `theme/registry.test.mjs` pass unchanged.
- [ ] 6.5 Manual pass in `pnpm dev`: sidebar widgets, gradient nav, segmented control, glass cards, detail panel slide/close — verified in both light and dark mode, and with reduced-motion enabled.
