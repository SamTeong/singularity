# zapac-shell-appearance

## Purpose

Defines the ZAPAC skin's shell appearance: glass-over-gradient surfaces, a
single brand purple→cyan accent for all chrome, gradient-marked navigation
with live count pills, a sidebar usage panel and daemon-status footer, the
Tasks view topbar (segmented control + gradient primary action), glass kanban
cards, keyboard-focus and reduced-motion handling, and preservation of
existing shell layout behaviors (resize, minimize, persisted view selection)
and the Appearance view's colour-mode toggle. TBD: finalize scope as the
ZAPAC skin evolves beyond this initial implementation.

## Requirements

### Requirement: Glass-over-gradient shell surfaces

Under the ZAPAC skin, the application shell SHALL present its primary regions —
sidebar, view pane, and terminal dock — as translucent glass panels (backdrop
blur, hairline stroke, soft card shadow) over the skin's ambient purple→cyan
gradient field, using design tokens read through the skin-agnostic token accessor
rather than skin-specific namespaces. The Phosphor skin and the skin switcher
SHALL be unaffected.

#### Scenario: Shell renders glass panels over the ambient field

- **WHEN** the app loads with the ZAPAC skin active
- **THEN** the sidebar, view pane, and terminal dock render as glass surfaces (blurred translucent background, hairline stroke) above the ambient gradient background

#### Scenario: Both colour modes render coherently

- **WHEN** the shell is viewed in light mode and again in dark mode
- **THEN** the glass surfaces, strokes, and ambient field remain legible and consistent in each mode with no unstyled or mode-inverted regions

### Requirement: One-accent chrome

All shell chrome (navigation, buttons, indicators, meters) SHALL express emphasis
through the single brand purple→cyan accent. Colours that belong to terminal
*content* (for example Claude Code's coral) SHALL remain scoped to terminal output
and SHALL NOT be used for UI chrome.

#### Scenario: Chrome uses only the brand accent

- **WHEN** any shell chrome element is rendered in an emphasized or active state
- **THEN** its emphasis colour is the brand purple→cyan accent, not a terminal-content colour

#### Scenario: Terminal content colour stays in the terminal

- **WHEN** terminal output uses its own accent (e.g. coral)
- **THEN** that colour appears only inside the terminal body and nowhere in the surrounding chrome

### Requirement: Gradient-marked navigation with per-view counts

The sidebar SHALL render a brand mark, a primary "New session" action, and the
primary navigation items. The active nav item SHALL be marked with a gradient
edge indicator and an elevated glass background. Nav items that represent a count
(e.g. Tasks, Automation) SHALL display that count as a pill reflecting live
application data.

#### Scenario: Active view is gradient-marked

- **WHEN** a primary nav item is the current view
- **THEN** it shows a gradient edge indicator, an elevated/active glass background, and bold label weight

#### Scenario: Count pills reflect live data

- **WHEN** the number of tasks or automation entries changes
- **THEN** the corresponding nav count pill updates to the new value

### Requirement: Sidebar usage panel

The sidebar SHALL include a "Usage · 5h window" panel that shows per-provider
usage as labelled mini-bars with percentages, derived from usage data already
available to the shell. It SHALL add no new server endpoint.

#### Scenario: Usage mini-bars render from usage data

- **WHEN** per-provider usage data is available
- **THEN** the usage panel shows a labelled mini-bar and percentage for each provider present in that data

#### Scenario: Usage panel with no data

- **WHEN** no usage data is available yet
- **THEN** the panel renders an empty/placeholder state rather than erroring

### Requirement: Sidebar daemon-status footer

The sidebar SHALL include a footer showing daemon connection status and the
loopback address, derived from the shell's existing connection state.

#### Scenario: Footer shows connected state

- **WHEN** the websocket connection to the daemon is established
- **THEN** the footer shows a connected indicator and the loopback address

#### Scenario: Footer shows disconnected state

- **WHEN** the connection to the daemon is lost
- **THEN** the footer reflects the disconnected state

### Requirement: View topbar with segmented control and gradient primary action

The Tasks view topbar SHALL present a title with a live subtitle, a segmented
Board/History control, and a gradient primary action button. The segmented
control SHALL reflect and switch the current Board/History mode.

#### Scenario: Segmented control switches to History

- **WHEN** the user activates the History segment
- **THEN** the view switches to the History table and the History segment shows as active

#### Scenario: Segmented control switches back to Board

- **WHEN** the user activates the Board segment
- **THEN** the view switches to the kanban board and the Board segment shows as active

#### Scenario: Primary action is gradient-styled and keyboard-operable

- **WHEN** the Tasks topbar renders
- **THEN** the "New task" primary action is styled with the brand gradient, opens the create-task flow when activated, and shows a visible focus ring when focused via keyboard

### Requirement: Glass kanban cards with status dots and pills

Kanban columns SHALL use dot-marked headers with counts, and cards SHALL render
as glass surfaces with a status pill and existing metadata (repo/branch, stats
line, tags). Column header text and counts SHALL keep the format
`<Label> (<n>)` so existing behavior and tests remain valid.

#### Scenario: Column headers keep label-and-count format

- **WHEN** the board renders
- **THEN** each column header reads `<Label> (<count>)` (e.g. `To-Do (1)`) and carries a status dot

#### Scenario: Cards render as glass with status pill

- **WHEN** a task card renders
- **THEN** it appears as a glass surface showing its title, repo/branch, stats line when present, tags, and a status pill for its agent state

### Requirement: Keyboard focus and reduced-motion

Interactive shell chrome (nav items, buttons, cards, segmented control, panel
controls) SHALL show a visible focus indicator when focused via keyboard. All
introduced transitions and slide/scrim animations SHALL be suppressed when the
user prefers reduced motion.

#### Scenario: Keyboard focus is visible

- **WHEN** the user tabs to an interactive chrome element
- **THEN** a visible focus ring is shown on that element

#### Scenario: Reduced motion is honored

- **WHEN** the user's system requests reduced motion
- **THEN** shell transitions and slide/scrim animations are disabled (state changes still occur, without animation)

### Requirement: Preserved shell layout behaviors

The restyle SHALL be visual only for the shell's existing interactions: the
drag-resizable terminal dock height and session-list width, the dock
minimize/expand toggle, and the persisted view selection SHALL continue to work
exactly as before.

#### Scenario: Dock and list remain resizable

- **WHEN** the user drags the dock height handle or the session-list width handle after the restyle
- **THEN** the dock/list resizes within its existing clamps and the size persists across reloads

#### Scenario: Dock minimize still works

- **WHEN** the user minimizes and re-expands the terminal dock
- **THEN** the dock collapses and restores as before, and the state persists

### Requirement: Colour-mode toggle stays in the Appearance view

The restyle SHALL NOT introduce a floating light/dark toggle in the shell. Colour
mode SHALL continue to be toggled from the Appearance view, preserving the
existing `Light mode` / `Dark mode` controls and the respawn-confirmation flow.

#### Scenario: No floating theme toggle is added

- **WHEN** the restyled shell renders
- **THEN** there is no floating lower-right colour-mode button, and the Appearance view's `Light mode` / `Dark mode` toggle remains the way colour mode is changed
</content>
