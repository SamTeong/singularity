## Why

Singularity can select the Phosphor skin today, but most app-owned shell and
feature UI still speaks the ZAPAC glass vocabulary, so the result is a token
adapter rather than the deliberate CRT command console shown in
`docs/one-shot/phosphor-layout-02.html`. The vendored Phosphor theme and component
library are already present, making this the right time to complete the
app-level integration without disturbing the finished ZAPAC experience.

## What Changes

- Complete the Phosphor-only shell treatment to match the one-shot reference:
  near-black full-screen console frame, orange structural chrome, phosphor-mint
  active states, condensed/monospace/bilingual type, CRT scanline/vignette pass,
  hard corners, chamfers, glow-as-luminance, and mechanical motion.
- Restyle the sidebar, top/view chrome, overflow menu, kanban board, task-detail
  panel, resizable session dock, session roster, and supporting status/readout
  elements under the Phosphor skin while preserving their existing behavior.
- Apply the Phosphor state vocabulary consistently: mint = nominal/active,
  blue = pending/planning, amber = caution/review/terminal, red = critical, and
  orange = structure only. Active controls use solid-hue/black-content inversion.
- Make terminal and transcript presentation skin-aware so Phosphor uses the
  reference amber-on-black console palette while ZAPAC retains its existing
  light/dark ANSI palettes.
- Replace remaining ZAPAC-only presentation dependencies in shared app UI with
  skin-neutral app primitives or Phosphor-aware variants where required for
  fidelity; remove the temporary Phosphor-to-ZAPAC compatibility shim once no
  runtime consumer needs it.
- Preserve the current skin registry, persisted selection, dark-only Phosphor
  behavior, Appearance workflow, task interactions, dock resize/minimize,
  keyboard operation, responsive collapse, and reduced-motion behavior.
- Add focused theme and end-to-end coverage for switching to Phosphor, rendering
  its defining shell/terminal semantics, and switching back to an unchanged
  ZAPAC skin.

## Capabilities

### New Capabilities

- `phosphor-console-appearance`: The observable visual and interaction contract
  for the Phosphor-skinned shell and app surfaces, including framing, type,
  state color, navigation, task board/detail, overlays, responsive behavior,
  focus, and reduced motion.
- `skin-aware-terminal-presentation`: Selection of terminal and transcript
  palettes and chrome from the active skin, including Phosphor's amber-on-black
  machine-output treatment and preservation of ZAPAC light/dark behavior.

### Modified Capabilities

<!-- No repository-level capability specs exist yet; both contracts are introduced here. -->

## Impact

- **Theme integration:** `web/src/theme/skins/phosphor.jsx`,
  `web/src/theme/contract.js`, the theme registry/provider tests, and potentially
  small skin-neutral presentation primitives under `web/src/components/`.
- **Shell and task surfaces:** `web/src/shell/*`,
  `web/src/features/tasks/TasksBoard.jsx`, and
  `web/src/features/tasks/TaskDetailPanel.jsx`.
- **Terminal surfaces:** `web/src/features/sessions/Terminal.jsx`,
  `web/src/features/sessions/term-theme.js`, and transcript rendering that shares
  the ANSI palette.
- **Other app views:** shared status pills, empty states, search inputs, dialogs,
  and MUI overrides are audited so selecting Phosphor never falls back to ZAPAC
  glass or crashes on a ZAPAC-specific token read.
- **Dependencies:** consume the existing
  `phosphor-console-theme@0.1.0` file dependency and its exported components; do
  not edit or repack the vendored tarball in this change.
- **Tests:** extend theme registry/unit coverage and Playwright appearance,
  shell, tasks, dock, and terminal coverage. No server API or persisted domain
  data migration is expected.
