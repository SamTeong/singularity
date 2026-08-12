## Context

Singularity already has a multi-skin boundary (`AppThemeProvider`), a registry,
persisted skin selection, a ZAPAC descriptor, and a Phosphor descriptor. The
Phosphor descriptor mounts the vendored `phosphor-console-theme@0.1.0` theme and
normalizes its `theme.nerv.*` values into the app's `getTokens()` contract. It
also carries a temporary `theme.zapac` / `palette.glass` compatibility shim
because several app surfaces still render ZAPAC-owned `StatusPill`, `EmptyState`,
and `SearchInput` components.

The current app-owned shell was styled for `docs/one-shot/layout-02.html` and
therefore assumes translucent glass, large radii, a purple-to-cyan gradient, and
smooth transitions. Mapping Phosphor values into those token slots prevents a
crash but cannot create the structural grammar in
`docs/one-shot/phosphor-layout-02.html`: a chamfered orange double frame, a
bilingual tactical masthead, boxed state stamps, segmented readouts,
amber-on-black terminal output, and mechanical state changes.

The supplied `DESIGN.md` and the one-shot page are normative visual references.
The vendored package already implements their palette, typography, MUI
overrides, CRT baseline, focus states, reduced-motion rules, and reusable atoms
such as `Stamp`, `BilingualLabel`, `StatusLegend`, `MeterBar`, and
`DigitalClock`. The application must consume those assets without forking or
repacking the tarball. Existing domain behavior, server protocols, task actions,
resizable layout, and the completed ZAPAC theme remain constraints.

## Goals / Non-Goals

**Goals:**

- Make the running application under the Phosphor skin recognizably match
  `phosphor-layout-02.html` across the shell, task board/detail panel, menus,
  dialogs, session roster, terminal dock, and shared app states.
- Preserve one interaction/state tree across skins; theme selection changes
  presentation, not domain behavior or routes.
- Centralize skin-specific roles and task/session state-to-tone mappings so
  orange is always structural and semantic hues remain consistent.
- Make live xterm and transcript rendering select their palette from the active
  skin while retaining existing ZAPAC light/dark behavior.
- Remove the need for the Phosphor-to-ZAPAC runtime presentation shim.
- Meet WCAG AA, keyboard, responsive, and reduced-motion expectations.

**Non-Goals:**

- Editing or rebuilding either vendored theme tarball.
- Replacing MUI, xterm, CodeMirror, Mermaid, or application domain models.
- Adding a Phosphor light mode or a floating theme toggle.
- Translating user content, source code, terminal output, or long-form prose to
  uppercase/Japanese; the bilingual/all-caps grammar applies to UI chrome only.
- Reproducing demo-only fake telemetry or terminal events that have no real
  application data source.
- Changing task card actions, transcript navigation, session lifecycle, server
  endpoints, or persisted task/session data.

## Decisions

### D1 — Extend the normalized presentation contract; branch structure only at composition points

Extend the skin-neutral theme contract with a small presentation recipe for
shell roles (surface model, structural/active/status colors, frame/chamfer,
focus, motion, and terminal role colors). ZAPAC maps those roles to its current
glass/gradient values; Phosphor maps them to `theme.nerv` and
`theme.vars.palette.nerv`. Existing `getTokens()` consumers continue to work,
while `shellStyles.js` becomes a facade over role names instead of hard-coded
ZAPAC fallbacks.

Most components keep one DOM and behavior path and vary through those roles.
Only true structural signatures branch on `skinId` at their composition owner:
`AppShell` adds the Phosphor frame/masthead, `Sidebar` adds bilingual nav labels,
`TasksBoard` adds the status legend and bilingual column chrome, and the dock/menu
add their Phosphor-specific headers. This avoids both a giant condition in every
`sx` object and a second, behaviorally divergent copy of `AppShell`.

- *Alternative considered:* render a separate Phosphor application shell using
  `ConsoleFrame`. Rejected because it would duplicate a large orchestration
  component and invite drift in dialogs, persistent views, resize behavior, and
  session lifecycle.
- *Alternative considered:* express the entire difference through palette token
  substitution. Rejected because bilingual labels, the masthead, status legend,
  and segmented meters are semantic structure rather than colors.

### D2 — Use the vendored Phosphor system as the source of truth, selectively

Stock controls, dialogs, drawers, menus, tables, and inputs remain MUI components
so the Phosphor theme's existing overrides style all states consistently. Import
console-specific atoms from `phosphor-console-theme/components` when their
semantics match (`Stamp`, `BilingualLabel`, `StatusLegend`, `MeterBar` or
segmented meters, monogram/clock primitives). Keep application-specific
containers—task cards, task dossier, sidebar, dock—because they own real behavior
and data, but compose them from the shared tokens/atoms.

Do not copy package source into `web/src`, hand-code duplicate hex values, or
modify `vendor/phosphor-console-theme-0.1.0.tgz`. Phosphor-only adapters live in
the skin module or small app presentation components.

- *Alternative considered:* hand-port all CSS from the one-shot HTML. Rejected
  because the vendored package already encodes the same design system with MUI
  state coverage and reduced-motion behavior.

### D3 — Replace ZAPAC-owned presentation primitives with local semantic primitives

Create or consolidate skin-neutral app primitives for status pills/stamps,
empty states, and rail search. Under ZAPAC they reproduce the existing look;
under Phosphor they render the console grammar, preferably delegating to the
vendored `Stamp` where appropriate. Migrate runtime consumers away from ZAPAC
presentation exports, then remove the temporary `theme.zapac` and
`palette.glass` assignments from `skins/phosphor.jsx`. The normalized
`theme.tokens` mapping remains.

The ZAPAC color-mode hook may remain temporarily because it is behavioral and
works through MUI's color-scheme context; it is not used to paint Phosphor.

- *Alternative considered:* retain the compatibility shim indefinitely.
  Rejected because it masks ZAPAC-specific assumptions and makes visual regressions
  in new skins silent.

### D4 — Centralize domain state → Phosphor tone and bilingual label mappings

Define one shared mapping used by sidebar counts, task columns/cards/detail,
session rows, and status primitives:

| Domain meaning | Phosphor tone | Bilingual treatment |
| --- | --- | --- |
| queued / idle | dim/map green | `待機 / QUEUED` |
| planning / pending | blue | `立案 / PLANNING` |
| running / nominal | mint | `稼働 / RUNNING` |
| review / caution | amber | `審査 / REVIEW` |
| done / merged | mint, filled inversion | `完了 / MERGED` |
| failed / disconnected / destructive | red | explicit symbol + text |

Safety orange is excluded from the mapping and reserved for frame lines,
dividers, axes, metadata keys, and chrome-level controls. Selected/active state
uses a solid semantic fill with `#0A0A0A` content; ordinary hover/focus does not
invent a new hue. Large kanji always has an adjacent English caption, and
screen-reader labels remain clear English descriptions.

- *Alternative considered:* allow each feature to choose its nearest MUI color.
  Rejected because the reference's identity depends on hue having one stable
  meaning everywhere.

### D5 — Preserve the real shell mechanics inside the Phosphor frame

The root shell gains an outer Phosphor frame and masthead only while that skin is
active. The existing `Sidebar + selected view` row, horizontal dock resize
handle, and full-width `SessionDock` remain the inner layout, preserving refs,
stored dimensions, persistent mounted views, and terminal LRU behavior.

The masthead uses real state only: product identity, loopback address, connection
status, aggregate agent/daemon health, and local time. Demo metadata without a
real source is omitted rather than fabricated. At narrower widths, secondary
metadata/health collapses first; the bilingual label remains paired, and the
existing sidebar/dock structural collapse continues. Overlays remain portaled or
fixed outside clipped/chamfered ancestors so menus and the task dossier are not
cut off.

- *Alternative considered:* copy the one-shot's fake health animation and fixed
  numbers. Rejected because production telemetry must reflect application state.

### D6 — Select xterm and transcript palettes by skin plus color mode

Replace the current `TERM_THEME[mode]` lookup with a resolver such as
`getTerminalTheme(skinId, resolvedMode)`. It returns the existing ZAPAC light or
dark palette unchanged, or a Phosphor palette with void background, amber primary
text/cursor, AA-safe dim rust, mint success/assistant accents, blue pending, and
red errors. `Terminal.jsx` and `TranscriptView.jsx` consume the same resolver so
ANSI colors do not drift.

Changing the skin updates app terminal chrome and the xterm palette without
altering buffered bytes, copy/paste, keyboard shortcuts, scrollback, attach
state, or WebGL fallback. Because an already-running CLI may have selected its
own theme at process spawn, skin changes with live sessions use the existing
respawn-confirmation mechanism rather than silently claiming the child TUI has
fully restyled.

- *Alternative considered:* reuse the ZAPAC dark palette for all dark skins.
  Rejected because the terminal is a signature Phosphor surface and the
  purple/cyan palette breaks its semantic color system.

### D7 — Mechanical motion is state feedback, never page choreography

Phosphor transitions use immediate changes, `linear`, or `steps()` for short
state feedback. Blinking is limited to genuinely in-progress indicators;
segmented meters may fill stepwise. The app does not animate page entry or hide
content until animation completes. `prefers-reduced-motion: reduce` disables
blink, strobe, scan movement, stepped fill, and drawer/menu flicker while
rendering the final visible state immediately. ZAPAC retains its current motion
recipe.

## Risks / Trade-offs

- **[Cross-skin regression] Shared shell components are touched for Phosphor** →
  Keep ZAPAC role values byte-for-byte equivalent, add switch-away/switch-back
  coverage, and review both skins at the same checkpoints.
- **[Contract sprawl] A presentation contract can become a dumping ground** →
  Expose semantic roles only; keep one-off component layout local and document
  each required group in the contract assertion.
- **[Mixed visual vocabulary] Unmigrated ZAPAC components can leak glass/radii** →
  inventory all `@zapac/mui-theme` presentation imports, migrate shared
  primitives first, then remove the compatibility shim so missed reads fail in
  development instead of silently rendering incorrectly.
- **[Dense console harms readability] Tiny uppercase labels and glow can reduce
  legibility** → Keep reading prose sentence-case, maintain AA contrast, cap glow
  to display/status elements, and test at narrow widths and browser zoom.
- **[Clipped overlays] The frame chamfer creates an overflow/stacking context** →
  keep menus, dialogs, and the task detail panel in MUI portals or fixed layers
  above the frame with the semantic z-index scale.
- **[Terminal child process mismatch] xterm can update live but a running CLI's
  self-selected theme may not** → reuse the existing live-session respawn prompt
  on skin changes and describe why; never discard a session automatically.
- **[Bundle cost] Importing the full console component barrel can retain unused
  code depending on transpilation/tree-shaking** → use exported subpath with
  named imports, inspect the production bundle, and prefer MUI overrides where a
  stock component already suffices.

## Migration Plan

1. Extend and test the normalized skin/presentation contract with equivalent
   ZAPAC roles and native Phosphor roles.
2. Add local semantic presentation primitives; migrate ZAPAC-owned status,
   empty-state, and search presentation consumers; remove the Phosphor shim.
3. Add the Phosphor root frame/masthead and restyle sidebar/menu while preserving
   the existing layout and callbacks.
4. Apply the state mapping and vendored atoms to Tasks, the task dossier, and
   related filters/progress/readouts.
5. Restyle the session roster/dock and make terminal/transcript palettes
   skin-aware.
6. Audit remaining views, dialogs, editors, and responsive states for ZAPAC
   leakage, focus, contrast, overflow, and reduced motion.
7. Run unit/build/e2e suites and manual visual comparisons at desktop, narrow
   viewport, zoomed text, and reduced-motion settings for both skins.

Rollback is a normal code revert: the change adds no server schema or persisted
domain-data migration. Persisted unknown skin ids already fall back to ZAPAC.

## Open Questions

- Whether the first implementation pass should ship the full masthead at all
  desktop widths or collapse it below the same `820px` threshold used by the
  one-shot. Default: preserve the masthead identity but hide secondary metadata
  and health progressively.
- Whether the production bundle remains acceptably small with named imports from
  the TypeScript-source component package. Measure during implementation; if
  tree-shaking is insufficient, use MUI overrides plus a smaller set of atoms
  without changing the visual contract.
