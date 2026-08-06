## ADDED Requirements

### Requirement: Phosphor activation is dark-only, persistent, and isolated

The application SHALL apply the complete Phosphor Console presentation when the
user selects the `phosphor` skin, SHALL persist that selection through the
existing skin preference, and SHALL present Phosphor as dark-only. Selecting
Phosphor SHALL NOT change application data or behavior, and switching back to
ZAPAC SHALL restore the existing ZAPAC presentation and color-mode controls.

#### Scenario: Selecting Phosphor applies and persists the console
- **WHEN** the user selects Phosphor Console in Appearance and reloads the app
- **THEN** the Phosphor console presentation remains active and no light-mode control is offered for that skin

#### Scenario: Switching back preserves ZAPAC
- **WHEN** the user switches from Phosphor Console back to ZAPAC
- **THEN** the existing ZAPAC glass presentation and its light/dark controls render without Phosphor frame, CRT, color, or typography leakage

### Requirement: Phosphor shell uses the command-console frame

Under the Phosphor skin, the shell SHALL use `#0A0A0A` as its only foundational
surface and SHALL present the main workspace inside an orange double frame with
hard corners or deliberate chamfers. Hierarchy SHALL use borders, hue, and
luminous glow rather than translucent glass, lighter raised surfaces, or cast
drop shadows. A non-interactive CRT scanline/vignette pass SHALL cover the shell
without obscuring content or intercepting input.

#### Scenario: Shell renders the defining frame
- **WHEN** the application loads with Phosphor active at a desktop viewport
- **THEN** the masthead, sidebar, main view, resize band, and session dock read as one near-black orange-framed command console beneath the CRT pass

#### Scenario: No ZAPAC surface leaks into Phosphor
- **WHEN** the user navigates among primary views, menus, dialogs, and task details under Phosphor
- **THEN** no purple-to-cyan gradient, decorative glass blur, pill-shaped ZAPAC surface, or soft elevation shadow appears

### Requirement: Masthead and chrome use purposeful bilingual typography

The Phosphor shell SHALL use condensed uppercase type for headings/actions,
monospace type for data and chrome, and Mincho type only for meaningful Japanese
labels. Each large Japanese label SHALL have an adjacent English caption, and
accessible names SHALL describe the control or datum in English. User content,
terminal output, code, and reading prose SHALL retain their original case.

#### Scenario: Masthead communicates real system state
- **WHEN** the Phosphor shell renders its masthead
- **THEN** it shows the Singularity identity plus English-paired Japanese chrome and only real application state such as connection, workload, address, or time

#### Scenario: Content is not transformed as chrome
- **WHEN** mixed-case user prose, a path, source code, or terminal output renders under Phosphor
- **THEN** its original case and readable type treatment are preserved

### Requirement: Color has one semantic meaning

Phosphor UI state SHALL use mint for nominal/running/active, map or dim green for
queued/idle/secondary data, blue for planning/pending, amber for review/caution
and terminal data, and red for failure/disconnection/destructive actions. Safety
orange SHALL be reserved for structural chrome such as borders, rules, dividers,
axes, metadata keys, and chrome-level actions, and SHALL NOT encode a data state.

#### Scenario: Status colors remain consistent across surfaces
- **WHEN** the same queued, planning, running, review, completed, or failed state appears in navigation counts, task UI, session UI, and detail UI
- **THEN** every occurrence uses the same Phosphor tone and a textual or symbolic label in addition to color

#### Scenario: Active state uses figure-ground inversion
- **WHEN** a selectable Phosphor control becomes current, selected, checked, or recorded
- **THEN** it uses a solid semantic-hue fill with near-black content and does not apply glow to the punched-out content

### Requirement: Sidebar and overflow navigation match the Phosphor grammar

The Phosphor sidebar SHALL provide the existing New Session, Tasks, Automation,
Usage, and More interactions with hard-edged bilingual controls, semantic count
stamps, real usage readouts, and daemon connection status. The overflow menu
SHALL preserve every existing destination and server action while using
orange-framed console chrome and a red treatment for destructive actions.

#### Scenario: Existing navigation remains operable
- **WHEN** the user activates any sidebar or overflow-menu destination under Phosphor
- **THEN** the same view or action executes as under ZAPAC and current navigation is shown by semantic inversion rather than a ZAPAC gradient indicator

#### Scenario: Live sidebar data uses console readouts
- **WHEN** usage, task counts, automation counts, or daemon connectivity changes
- **THEN** the sidebar updates its stamped count, segmented/readout value, or connection state from the existing live data without fabricated telemetry

### Requirement: Task board uses the Phosphor status and dossier system

Under Phosphor, the Tasks view SHALL show a bilingual status legend, bilingual
column chrome, boxed state stamps, near-black hard-edged task cards, segmented
progress where progress is available, and the existing task metadata/actions.
Activating a card SHALL open the existing task detail panel as a chamfered
Phosphor dossier with status, metrics, directive/details, activity, and sticky
actions, while preserving its modal, focus, dismissal, and live-update behavior.

#### Scenario: Board reflects task lifecycle semantically
- **WHEN** queued, planning, running, review, and completed tasks render on the board
- **THEN** their legend, column, card stamp, and progress treatment use the shared bilingual state mapping and actual task data

#### Scenario: Card opens a Phosphor dossier without changing behavior
- **WHEN** the user activates a board card under Phosphor
- **THEN** the same task detail dialog opens with Phosphor dossier presentation and its Open session, View transcript, close, scrim, Escape, focus-trap, and focus-return behaviors remain available

#### Scenario: Task operations are unchanged
- **WHEN** the user filters, drags, concludes, abandons, creates, or reviews a task under Phosphor
- **THEN** the existing operation and resulting data change are identical to the operation under ZAPAC

### Requirement: Shared application states use native Phosphor presentation

Menus, dialogs, inputs, tables, empty states, search controls, status pills,
snackbars, and editor frames SHALL render from MUI's Phosphor overrides or
skin-neutral application primitives. They SHALL NOT require a ZAPAC token
namespace at runtime, and every interactive component SHALL provide default,
hover, focus-visible, active/selected, disabled, and relevant error/loading
states.

#### Scenario: Every primary view renders without compatibility fallback
- **WHEN** the user visits each primary and overflow destination under Phosphor
- **THEN** the view renders without a missing-token error, ZAPAC glass fallback, or visually unstyled shared state

#### Scenario: Form and feedback states are complete
- **WHEN** the user interacts with a control through hover, keyboard focus, selection, disabled, validation-error, and loading states
- **THEN** each state remains visible, legible, and consistent with the Phosphor theme

### Requirement: Responsive, resize, and overlay mechanics are preserved

The Phosphor frame SHALL adapt structurally at narrow widths: secondary masthead
metadata MAY collapse, but bilingual pairs SHALL remain paired and the primary
task/session controls SHALL remain reachable. Existing sidebar collapse,
terminal-dock minimize/restore, dock-height resize, session-list resize, and
persisted dimensions SHALL continue to work. Menus, dialogs, and the task dossier
SHALL render above the clipped/chamfered frame without being cut off.

#### Scenario: Narrow viewport retains usable structure
- **WHEN** the app is viewed at a narrow supported viewport under Phosphor
- **THEN** secondary chrome collapses without horizontal page overflow, orphaned Japanese labels, or unreachable primary controls

#### Scenario: Resize behavior remains functional
- **WHEN** the user resizes or minimizes the session dock and resizes the session list under Phosphor, then reloads
- **THEN** the controls obey their existing clamps and the persisted dimensions/state are restored

#### Scenario: Overlays escape the frame clip
- **WHEN** the user opens the More menu, a dialog, or a task dossier near a frame edge
- **THEN** the complete overlay remains visible above the frame and accepts pointer and keyboard input

### Requirement: Phosphor remains accessible and motion-safe

Body text and controls SHALL meet WCAG AA contrast against their actual
background, status SHALL never be communicated by color alone, and every
interactive element SHALL expose a visible focus indicator and accessible name.
Phosphor motion SHALL be limited to mechanical state feedback; when reduced
motion is requested, blink, strobe, moving CRT effects, stepped fills, and
flicker/slide effects SHALL stop while content remains immediately visible.

#### Scenario: Keyboard operation is visible
- **WHEN** a keyboard user tabs through shell, task, menu, dialog, resize, and dock controls
- **THEN** focus is always visible and each control can be operated without a pointer

#### Scenario: Reduced motion renders final state
- **WHEN** `prefers-reduced-motion: reduce` is active
- **THEN** all Phosphor content is visible in its final state without blink, strobe, flicker, or decorative transition

