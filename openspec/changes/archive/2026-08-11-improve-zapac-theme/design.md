## Context

Singularity is a multi-skin app. **ZAPAC** (the vendored `@zapac/mui-theme`, shipped
as `vendor/zapac-mui-theme-0.2.0.tgz`) is the default skin (`DEFAULT_SKIN_ID = 'zapac'`);
Phosphor is a second skin, and both plug in through `web/src/theme/registry.js`. App
components stay skin-agnostic by reading design tokens through
`getTokens(theme)` (`web/src/theme/contract.js`) — `radius`, `layers`, `motion`,
`fonts`, and the `glass` recipe (`surface`, `blur`, `stroke`, `cardShadow`).

The target look is `docs/one-shot/layout-02.html` ("Lucid Cockpit"): glass panels
over an ambient purple→cyan field, gradient-marked nav, a segmented Board/History
control, gradient primary buttons, glass kanban cards, and a restyled terminal dock.
Its CSS variables already mirror `DESIGN.md` and, largely, what the vendored ZAPAC
theme exposes today — so the visual work is **app-level component restyling**, not
edits to the vendored package.

Current relevant code:
- `web/src/shell/AppShell.jsx` — layout orchestration: `Sidebar` + view pane + full-width
  `SessionDock`, drag-resize handles (`useResizable`), dialogs, snackbars. Colour mode via
  `useColorMode`; ambient background via the skin's `Background`.
- `web/src/shell/Sidebar.jsx` — nav rail (currently no usage panel / daemon footer).
- `web/src/shell/SessionDock.jsx` — terminal dock (session list + terminal).
- `web/src/features/tasks/TasksBoard.jsx` — kanban + history + a **shared dockable
  transcript panel** (`dock`, right/bottom, resizable) reused by Board cards and History rows.

The e2e suite (`e2e/*.spec.mjs`, Playwright against the sandbox daemon) encodes the
current contracts. The ones that touch this work:
- `tasks.spec.mjs`: card is `role=button`/aria-label = title; **card click opens the
  transcript dock** with `Collapse|Expand <title> transcript` header, "No transcript
  found for this task." text, and `Dock right`/`Dock bottom` toggle; column headers
  read `<Label> (<n>)`; tag chips; drag-to-Done POST; hover `Abandon task`; History table.
- `appearance.spec.mjs`: skin radiogroup + `Light mode`/`Dark mode` toggle + respawn dialog.
- `smoke.spec.mjs`, `theme/registry.test.mjs`: basic boot + `DEFAULT_SKIN_ID === 'zapac'`.

## Goals / Non-Goals

**Goals:**
- Bring the ZAPAC shell to `layout-02.html` fidelity (full shell): sidebar brand mark +
  gradient nav + counts + usage mini-bars + daemon footer, view topbar with segmented
  control + gradient primary action, glass kanban cards with status dots/pills, restyled
  terminal-dock header.
- Replace the board card-click interaction with a right-sliding task-detail panel
  (layout-05 presentation, layout-02 look), preserving prior behaviors as in-panel actions.
- Keep the e2e suite green: rewrite only `tasks.spec.mjs`'s card-interaction assertions;
  leave the rest untouched.

**Non-Goals:**
- Editing the vendored `@zapac/mui-theme` package.
- Any change to the Phosphor skin, the skin switcher, or colour-mode toggling.
- New server routes or data model changes — everything reads existing `useAgents` state.
- A floating light/dark toggle (explicitly excluded; Appearance view stays the toggle).

## Decisions

### D1 — Restyle in app components, not the vendored theme

Restyle `AppShell`, `Sidebar`, `SessionDock`, `TasksBoard`, and `shellStyles.js`, reading
values through `getTokens()`. Where `layout-02` needs a token the contract doesn't expose
(e.g. specific gradient stops, meter track colour), add an **app-level** style helper
(next to `shellStyles.js`) or a small addition to the ZAPAC skin descriptor
`web/src/theme/skins/zapac.jsx` — never patch the tgz.

- *Alternative considered:* rebuild/repackage the vendored theme. Rejected — the package is
  a `file:` dependency shared with other consumers, slow to iterate, and unnecessary since
  the mockup's tokens already match what the theme exposes.

### D2 — Task detail panel: a new component reusing existing state

Add a `TaskDetailPanel` (right-sliding glass sheet + scrim, layout-05 mechanics) rendered
from `TasksBoard`. It is fed the selected task plus existing `stats`/`agents` data — no new
fetch. Selection becomes `const [detailTask, setDetailTask] = useState(null)`; the card's
`activate` sets it instead of calling `openTranscript`/`onSelect`.

Panel actions re-home the old behaviors:
- **Open session** → the existing `onSelect(task.sessionId)` (select live terminal); shown
  only when a live session exists (`LIVE_STATUS`).
- **View transcript** → the existing `openTranscript(item)` path, which still renders the
  shared dockable transcript panel (kept for History too).

- *Alternatives considered:* (a) render the transcript *inside* the detail panel — rejected
  for scope (the dockable panel has its own resize/side/persist behavior worth keeping);
  (b) route "View transcript" to the Transcripts view — heavier, changes navigation. The
  in-place dockable panel is the smallest faithful move.

### D3 — Board changes; History keeps its transcript flow

Only the **Board** card-click changes. The History table row → transcript and the shared
`dock` transcript panel stay. This preserves functionality, keeps the History e2e
assertions valid, and means "View transcript" and History share one transcript surface.

### D4 — Presentation: layout-05 mechanics, layout-02 skin

Use layout-05's `position: fixed; right:0; top:0; bottom:0` full-height sheet + full-screen
scrim (`aria-modal="true"`, Escape-to-close, focus return), but paint it with layout-02's
glass tokens/typography so it reads as one system. Respect `prefers-reduced-motion`.
Implementation may use MUI's `Drawer`/`Modal` (anchor right) for focus-trap + scrim +
Escape handling, styled to the glass recipe, rather than hand-rolling those affordances.

### D5 — e2e: rewrite the one card-interaction test, add sub-action coverage

Rewrite `tasks.spec.mjs`'s "clicking a card opens the transcript dock…" test to:
open the card → assert the detail panel (a stable role/name, e.g. `role=dialog`
aria-label `Task detail`) → assert stats/metadata present → exercise "View transcript"
(reusing the existing "No transcript found for this task." assertion, since seeded cards
have no `sessionId`) → close via Escape/scrim. Keep the "Open session" path covered where a
seeded live session allows (else assert the action's disabled/hidden state). All other
assertions in the file are unchanged. Add stable selectors (aria-labels) to the new panel
so the test binds to semantics, not styling.

## Risks / Trade-offs

- **[Breaking interaction] Card no longer opens the transcript dock directly** → Mitigate by
  preserving both behaviors as explicit, discoverable panel actions and rewriting only the
  affected e2e test; column/tag/drag/abandon/history contracts stay byte-for-byte.
- **[Focus/scroll management] A right sheet must trap focus, restore it on close, and lock
  body scroll** → Use MUI `Drawer`/`Modal` primitives (focus trap + scrim + Escape built in)
  styled to glass, rather than the raw HTML mockup's hand-rolled scrim.
- **[Token gaps] `layout-02` uses gradients/track colours not in the token contract** →
  Add them at app level (`shellStyles.js` helper or ZAPAC skin descriptor), keeping
  `getTokens()` reads intact; assert the ZAPAC contract check (`assertSkinContract`) still passes.
- **[Regression surface] Full-shell restyle touches many components** → Land incrementally
  (tokens/glass → sidebar → topbar/cards → dock → detail panel → e2e), running
  `pnpm test:e2e` after the interaction change; keep changes visual/behavioral, not structural,
  where a component is only being re-skinned.
- **[Reduced motion / a11y] slide + scrim animations** → gate animations behind
  `prefers-reduced-motion`; keep the visible focus ring and keyboard activation on cards and
  panel controls.
- **[Vendored-theme drift] adding app-level tokens could diverge from ZAPAC** → prefer reading
  existing `getTokens()` values; only add net-new tokens the mockup requires, and centralize
  them so a future ZAPAC bump can absorb them.

## Migration Plan

Purely front-end and reversible (revert the branch). Suggested order:
1. Shared glass/token helpers (extend `shellStyles.js`; add mockup-only tokens app-level).
2. Sidebar: brand mark, gradient nav + counts, usage mini-bars, daemon footer.
3. View topbar: segmented Board/History control + gradient primary action.
4. Kanban: dot-headed columns, glass cards, status pills — keep `<Label> (<n>)` headers.
5. Terminal dock header restyle.
6. `TaskDetailPanel` + wire board card `activate`; keep History/transcript dock.
7. Rewrite `tasks.spec.mjs` card-interaction test; run full `pnpm test:e2e` + `pnpm test`.

Rollback: revert the feature branch; no data or server migration involved.

## Open Questions

- Exact stable selector/aria-label for the detail panel and its actions (proposed:
  `role=dialog` name "Task detail"; buttons "Open session" / "View transcript") — finalize
  when rewriting the spec so test and component agree.
- Whether the usage mini-bars should show the same providers/labels as the mockup
  (Claude/API/Ollama) or exactly what `useAgents.usage` currently exposes — default to the
  real data shape.
