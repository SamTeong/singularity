## ADDED Requirements

### Requirement: The generated report resolves its skin before first paint

The generated usage report SHALL resolve the skin to apply before any of its styles
are evaluated, so the first painted frame already carries the active skin. It SHALL
accept the skin from its embedding host as a load-time input, SHALL fall back to a
persisted preference when no load-time input is supplied, and SHALL default to ZAPAC
when neither is present. Resolution SHALL NOT depend on the host reaching into the
report after load.

#### Scenario: Host-supplied skin is applied on the first frame
- **WHEN** the app embeds the report and supplies `phosphor` as the skin at load time
- **THEN** the report's first painted frame renders the Phosphor console presentation, with no intermediate frame showing ZAPAC colour

#### Scenario: A standalone report defaults to ZAPAC
- **WHEN** a generated report file is opened directly, outside the app, with no skin supplied
- **THEN** the report renders the ZAPAC presentation

#### Scenario: Persisted preference applies without a load-time input
- **WHEN** the report is opened with no skin supplied but a previously persisted skin preference exists
- **THEN** the report applies the persisted skin on the first painted frame

### Requirement: The host keeps an embedded report in sync with live skin changes

The application SHALL keep an already-loaded embedded report in sync when the user
changes skin or colour mode, without regenerating or reloading the report. The
load-time input and the live-sync path SHALL resolve to the same skin, so the two
mechanisms cannot disagree.

#### Scenario: Switching skin updates the embedded report in place
- **WHEN** the user switches the app between ZAPAC and Phosphor while a report is displayed
- **THEN** the embedded report adopts the new skin without a reload and without regenerating the report

#### Scenario: A regenerated report keeps the active skin
- **WHEN** the user regenerates the report while Phosphor is active
- **THEN** the newly loaded report renders in Phosphor from its first frame

### Requirement: Phosphor renders the report as a command console

Under Phosphor, the report SHALL present near-black as its only foundational
surface and SHALL derive hierarchy from borders, hue and luminous glow rather than
translucent glass, blur, film grain or cast drop shadows. Panels SHALL use the
orange double-frame treatment — an outer rule with an inset hairline — and hard or
deliberately chamfered corners. Display headings and labels SHALL use the Phosphor
condensed and monospace faces in upper case, while data-bearing strings such as
model identifiers, file paths, project names and prose SHALL retain their original
casing. The report SHALL remain free of external network requests.

#### Scenario: Phosphor replaces the glass treatment
- **WHEN** the report renders under Phosphor
- **THEN** no panel applies backdrop blur, film grain or an ambient radial glow field, and panels carry the orange double frame

#### Scenario: Data strings stay readable
- **WHEN** a Phosphor report displays model identifiers, project paths or explanatory prose
- **THEN** those strings render in their original casing rather than upper case

#### Scenario: Chamfering does not clip overflowing content
- **WHEN** a Phosphor panel contains a hover tooltip or scaled cell that extends beyond the panel's bounds
- **THEN** that content renders in full and is not sheared by the panel's corner treatment

### Requirement: The CRT pass covers report content

Under Phosphor, the report SHALL apply a non-interactive scanline and vignette pass
that renders above page content rather than behind it, SHALL NOT obscure content,
and SHALL NOT intercept pointer input.

#### Scenario: Scanlines read over panels
- **WHEN** the report renders under Phosphor with content panels on screen
- **THEN** the scanline and vignette pass is visible across those panels rather than being occluded by them

#### Scenario: The CRT pass is inert
- **WHEN** the user clicks or hovers any control in a Phosphor report
- **THEN** the control receives the interaction and the CRT pass intercepts nothing

### Requirement: Chart series colour is skin-supplied, not embedded in chart code

The report's chart code SHALL obtain every series, token-composition and
fill-foreground colour from skin-supplied design tokens, and SHALL NOT contain
colour literals. Series colour SHALL be defined independently of the semantic status
palette, so a skin can assign distinct series hues without disturbing the meaning of
nominal, caution, critical and idle. The ZAPAC report's rendered output SHALL be
unchanged by this indirection.

#### Scenario: No brand colour survives in a Phosphor chart
- **WHEN** a Phosphor report renders a chart containing more series than the skin's primary accents cover
- **THEN** every series, including the overflow series, renders in a Phosphor colour and no ZAPAC brand colour appears anywhere in the document

#### Scenario: Labels on filled surfaces stay legible
- **WHEN** a chart draws a label on top of an accent-filled area under either skin
- **THEN** the label uses the skin's designated on-accent foreground and remains legible against that fill

#### Scenario: ZAPAC output is preserved
- **WHEN** a ZAPAC report is generated after the chart palette moves behind tokens
- **THEN** its rendered charts are visually identical to those generated before the change

### Requirement: Phosphor offers no colour-mode control in the report

Phosphor is dark-only. The report SHALL NOT present a light/dark control while
Phosphor is active. Under ZAPAC the report SHALL retain its existing colour-mode
control and behavior.

#### Scenario: The toggle is absent under Phosphor
- **WHEN** the report renders under Phosphor
- **THEN** no light/dark toggle is presented

#### Scenario: ZAPAC keeps its toggle
- **WHEN** the report renders under ZAPAC
- **THEN** the light/dark toggle is present and switches the report between the ZAPAC light and dark presentations

### Requirement: Skin isolation is guarded against regression

The project SHALL carry an automated check that fails if a colour literal is
reintroduced into the report's shared chart code, or if the generated report's
styles omit the Phosphor skin definition.

#### Scenario: A reintroduced colour literal fails the check
- **WHEN** a colour literal is added to the report's shared chart code
- **THEN** the automated check fails

#### Scenario: A missing skin definition fails the check
- **WHEN** the generated report's assembled styles do not include the Phosphor skin definition
- **THEN** the automated check fails
