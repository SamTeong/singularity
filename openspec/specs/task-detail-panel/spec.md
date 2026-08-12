# task-detail-panel

## Purpose

Defines the task detail panel: a right-sliding overlay opened by activating a
board card, replacing the previous behavior where a card click opened the
dockable transcript panel directly. Covers opening/dismissal, panel content
(title, status, stats, metadata), preserved actions ("Open session", "View
transcript"), single-panel/live-update behavior, and the boundary with the
History view's unchanged transcript flow. TBD: finalize scope as the panel
evolves beyond this initial implementation.

## Requirements

### Requirement: Activating a board card opens a right-sliding detail panel

Activating a task card on the board (click, Enter, or Space) SHALL open a task
detail panel that slides in from the right edge over a scrim, in the ZAPAC glass
look. The scrim SHALL prevent interaction with the board behind it until the panel
is dismissed. This replaces the previous behavior where a card click opened the
dockable transcript panel.

#### Scenario: Card click opens the detail panel

- **WHEN** the user clicks a task card
- **THEN** a detail panel slides in from the right over a scrim, showing that task's details

#### Scenario: Keyboard activation opens the panel

- **WHEN** a card has focus and the user presses Enter or Space
- **THEN** the detail panel opens for that card

#### Scenario: Scrim blocks the board while open

- **WHEN** the detail panel is open
- **THEN** the board behind the scrim cannot be interacted with until the panel is dismissed

### Requirement: Dismissing the detail panel

The detail panel SHALL be dismissible via a close control, a click on the scrim,
and the Escape key. On dismissal, keyboard focus SHALL return to the board card
that opened it.

#### Scenario: Close control dismisses the panel

- **WHEN** the user activates the panel's close control
- **THEN** the panel closes and focus returns to the originating card

#### Scenario: Scrim click dismisses the panel

- **WHEN** the user clicks the scrim
- **THEN** the panel closes and focus returns to the originating card

#### Scenario: Escape dismisses the panel

- **WHEN** the user presses Escape while the panel is open
- **THEN** the panel closes and focus returns to the originating card

### Requirement: Detail panel content

The detail panel SHALL display the task's title, status pill, id, and repo/branch,
a stats row (cost, tokens, turns) derived from existing application state, and the
task's tags and metadata. The panel SHALL add no new server endpoint.

#### Scenario: Panel shows task stats and metadata

- **WHEN** the detail panel opens for a task
- **THEN** it shows the task title, status pill, repo/branch, and a stats row (cost, tokens, turns) reflecting that task's current data

#### Scenario: Missing stats degrade gracefully

- **WHEN** a task has no recorded stats (e.g. no session yet)
- **THEN** the stats row renders placeholders rather than erroring

### Requirement: Preserved actions inside the panel

The detail panel SHALL preserve the capabilities the previous card-click
interaction provided, exposed as explicit actions: "Open session" SHALL select
the task's live session terminal in the dock when a live session exists, and
"View transcript" SHALL open that task's transcript using the existing transcript
view. No prior capability SHALL be removed — only re-homed behind these actions.

#### Scenario: Open session selects the live terminal

- **WHEN** the task has a live session and the user activates "Open session"
- **THEN** that session's terminal becomes the active terminal in the dock

#### Scenario: View transcript opens the transcript

- **WHEN** the user activates "View transcript"
- **THEN** the task's transcript is shown via the existing transcript view (loading and "no transcript found" states preserved)

#### Scenario: Actions reflect availability

- **WHEN** a task has no live session
- **THEN** "Open session" is disabled or hidden while "View transcript" remains available

### Requirement: Single panel and live task updates

Only one detail panel SHALL be open at a time; activating a different card while a
panel is open SHALL show the newly selected task. While a panel is open, it SHALL
reflect live updates to the underlying task, and SHALL handle the task leaving the
board (concluded, moved, or removed) without erroring.

#### Scenario: Selecting another card swaps the content

- **WHEN** a panel is open for one task and the user activates a different card
- **THEN** the panel shows the newly selected task's details (a single panel, not two)

#### Scenario: Open panel reflects live updates

- **WHEN** the open task's stats or status change while the panel is open
- **THEN** the panel updates to show the new values

#### Scenario: Underlying task leaves the board

- **WHEN** the open task is concluded, moved, or removed while its panel is open
- **THEN** the panel either updates to the task's new state or closes gracefully, without an error

### Requirement: Board-only interaction change; History transcript flow preserved

The card → detail-panel change SHALL apply to the kanban Board only. The History
table's existing row → transcript behavior and the shared dockable transcript
panel SHALL remain available (reused by "View transcript" and by History), so that
functionality is preserved and the History behavior continues to work.

#### Scenario: History rows still open transcripts

- **WHEN** the user is in the History view and activates a row
- **THEN** the transcript panel opens for that concluded task as before

#### Scenario: Board and History non-card behaviors unchanged

- **WHEN** the board or history renders
- **THEN** column counts, tag-filter chips, drag-to-Done, and hover-abandon behave exactly as before the restyle
</content>
