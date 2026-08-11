## ADDED Requirements

### Requirement: Terminal palette is selected by skin and color mode

The live xterm palette SHALL be resolved from the active skin as well as the
active color mode. ZAPAC SHALL retain its current light and dark palettes;
Phosphor SHALL always use its dark console palette. Applying a presentation
change SHALL NOT clear terminal output, recreate server sessions, alter input
bytes, or change terminal keyboard, selection, copy/paste, resize, attach, or
scrollback behavior.

#### Scenario: Phosphor selects the console palette
- **WHEN** a live terminal is displayed while the Phosphor skin is active
- **THEN** xterm uses the Phosphor dark palette regardless of any previously stored ZAPAC light/dark preference

#### Scenario: ZAPAC terminal behavior is preserved
- **WHEN** the user switches back to ZAPAC and selects light or dark mode
- **THEN** xterm uses the same corresponding ZAPAC palette it used before this change

#### Scenario: Palette changes preserve terminal state
- **WHEN** the active palette changes while a terminal has output, selection, and scrollback
- **THEN** those terminal contents and behaviors remain intact while only presentation changes

### Requirement: Phosphor terminal uses amber-on-black machine-output grammar

The Phosphor terminal body SHALL use the void background and an AA-legible
amber primary foreground, with an AA-legible dim amber/rust for secondary
terminal text. ANSI success/nominal SHALL map to mint, pending/information to
blue where applicable, caution to amber, and errors to red; each state SHALL
remain distinguishable by terminal text or symbols as well as color. The cursor
and selection SHALL remain clearly visible.

#### Scenario: Normal output and dim output remain legible
- **WHEN** normal and ANSI-dim terminal output are shown under Phosphor
- **THEN** both are readable against the near-black terminal background and dim text does not use a failing raw color token

#### Scenario: ANSI states follow the Phosphor vocabulary
- **WHEN** terminal output emits success, information, warning, and error ANSI colors
- **THEN** the rendered colors align with mint, blue, amber, and red respectively without using safety orange as a data state

### Requirement: Terminal dock chrome matches the active skin

Under Phosphor, the terminal dock SHALL render as a flat orange-ruled console
region with an amber terminal header, semantic connection state, hard-edged
controls, and a session roster whose queued/idle/running/failed states use the
shared Phosphor mapping. Under ZAPAC, the existing glass terminal dock chrome
SHALL remain unchanged.

#### Scenario: Phosphor dock reads as one console
- **WHEN** a session is selected under Phosphor
- **THEN** its roster row, dock header, connection indicator, controls, and terminal well use the Phosphor frame and state grammar

#### Scenario: Existing dock operations remain available
- **WHEN** the user selects, reorders, duplicates, forks, resumes, restarts, opens externally, views transcript, or removes a session under Phosphor
- **THEN** the existing operation executes with the same availability rules and confirmation behavior as under ZAPAC

### Requirement: Transcript terminal styling shares the live-terminal palette

Transcript rendering that emulates terminal ANSI output SHALL consume the same
skin-aware palette resolver as live xterm. Non-terminal transcript prose and
message structure SHALL remain readable and SHALL NOT be forced into the amber
terminal style.

#### Scenario: Live terminal and transcript colors agree
- **WHEN** equivalent ANSI content is viewed first in a live Phosphor terminal and then in its transcript
- **THEN** background, foreground, dim text, and semantic ANSI colors match between the two surfaces

#### Scenario: Transcript prose remains prose
- **WHEN** user and assistant messages render around terminal/tool output in a transcript
- **THEN** prose retains readable casing and hierarchy while only terminal-like content uses the console palette

### Requirement: Skin changes account for child TUI theme selection

When a skin change occurs while live sessions exist, the application SHALL use
the established live-session respawn confirmation flow to explain that a running
child TUI may need respawning to adopt the new terminal background/theme. The
application SHALL NOT respawn or terminate a live session without user
confirmation.

#### Scenario: Live sessions prompt on skin change
- **WHEN** the user changes between ZAPAC and Phosphor while one or more sessions are live
- **THEN** the existing respawn confirmation identifies the affected live-session count and leaves the sessions running unless the user confirms

#### Scenario: No prompt without live sessions
- **WHEN** the user changes skin while no session is live
- **THEN** the new skin and palette apply without a respawn confirmation

