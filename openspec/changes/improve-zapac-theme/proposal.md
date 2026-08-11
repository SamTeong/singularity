## Why

The ZAPAC skin (the app's default theme) is functional but visually flat — it does
not yet realize the "Lucid Cockpit" glass-over-gradient identity captured in
`DESIGN.md` and prototyped in `docs/one-shot/layout-02.html`. We want the default
Singularity shell to look like that mockup: calm glass chrome over an ambient
purple→cyan field, one accent, gradient-marked navigation, and a task board whose
cards feel like a real cockpit. Only the ZAPAC skin is in scope for this pass; the
Phosphor skin and the skin switcher are untouched.

## What Changes

- **Restyle the whole ZAPAC shell to match `layout-02.html`** (full-shell fidelity):
  sidebar brand mark, gradient active-nav indicator + per-view counts, segmented
  Board/History control, gradient primary buttons, glass kanban cards with status
  dots/pills, and a restyled terminal-dock header.
- **Add two sidebar widgets** present in the mockup but not the app today, wired to
  existing `useAgents` data: a "Usage · 5h window" mini-bar panel and a "Daemon
  connected · 127.0.0.1:4317" status footer.
- **BREAKING (interaction): replace the task board's card-click behavior.** Today a
  card click opens the dockable transcript panel (`Dock right`/`Dock bottom`). It
  will instead open a **task-detail panel that slides in from the right** (layout-05
  presentation, layout-02 look): title, cost/tokens/turns stats, activity, and
  action buttons. The prior behaviors are preserved as **actions inside the panel** —
  "Open session" selects the live terminal, "View transcript" opens the existing
  transcript view — so no capability is lost, but the primary click target changes.
- **Update `e2e/tasks.spec.mjs`** to assert the new card → detail-panel interaction
  (and its "Open session" / "View transcript" sub-actions), keeping the suite green.
  Column counts, tag-filter chips, drag-to-Done, hover-abandon, and the History
  table are unchanged and their assertions stay.
- **Do NOT add** the floating lower-right light/dark toggle from the mockup — the app
  already toggles colour mode from the Appearance view (locked by
  `e2e/appearance.spec.mjs`); that flow is unchanged.
- The vendored `@zapac/mui-theme` package is **not edited**; all restyling happens in
  the app's own shell/board components and the ZAPAC skin descriptor, reading design
  tokens through `getTokens()`.

## Capabilities

### New Capabilities
- `zapac-shell-appearance`: The visual contract for the ZAPAC-skinned application
  shell — sidebar (brand, gradient-marked nav, counts, usage mini-bars, daemon
  footer), view topbar (segmented control, gradient primary action), glass surfaces,
  and terminal-dock chrome — expressed as behavior/appearance requirements.
- `task-detail-panel`: The right-sliding task-detail panel that opens when a board
  card is activated, its contents (stats, activity, metadata), and its actions
  ("Open session", "View transcript"), replacing the card→transcript-dock interaction.

### Modified Capabilities
<!-- No pre-existing openspec specs to modify; both areas are captured as new capabilities above. -->

## Impact

- **UI components (restyle + behavior):** `web/src/shell/AppShell.jsx`,
  `web/src/shell/Sidebar.jsx`, `web/src/shell/SessionDock.jsx`,
  `web/src/shell/shellStyles.js`, `web/src/features/tasks/TasksBoard.jsx`
  (card-click interaction + new detail panel), and the ZAPAC skin descriptor
  `web/src/theme/skins/zapac.jsx`.
- **Design tokens:** read via `web/src/theme/contract.js` (`getTokens`); no vendored
  package changes. New app-level style helpers may be added alongside `shellStyles.js`.
- **Data (no new endpoints):** the detail panel and sidebar widgets consume existing
  `useAgents` state (`tasks`, `agents`, `stats`, `usage`, `connected`) and the
  existing `/session` transcript fetch.
- **Tests:** `e2e/tasks.spec.mjs` rewritten for the new interaction;
  `e2e/appearance.spec.mjs`, `e2e/smoke.spec.mjs`, and the theme
  `registry.test.mjs` expected to stay green unchanged.
- **Out of scope:** the Phosphor skin, the skin switcher, server routes, and colour-mode
  toggling.
