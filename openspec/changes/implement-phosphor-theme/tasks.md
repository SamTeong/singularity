## 1. Theme contract and semantic foundation

- [x] 1.1 Inventory every app-owned ZAPAC presentation import, direct skin namespace read, glass-specific helper, and terminal palette consumer; record the migration target for each before editing shared UI.
- [x] 1.2 Extend `web/src/theme/contract.js` with documented semantic presentation groups for shell/frame, chrome, status, focus/motion, and terminal roles while keeping existing token reads backward-compatible.
- [x] 1.3 Populate the new presentation roles in both `web/src/theme/skins/zapac.jsx` and `web/src/theme/skins/phosphor.jsx`, mapping ZAPAC to its current values and Phosphor to `theme.nerv` / `theme.vars.palette.nerv` without duplicating design hex values in app components.
- [x] 1.4 Update contract/registry unit tests to assert both built-in skins satisfy the required groups, Phosphor is dark-only, persisted/unknown ids resolve correctly, and ZAPAC remains the default.
- [x] 1.5 Add one shared domain-state mapping for queued/idle, planning/pending, running/nominal, review/caution, done/merged, and failure/disconnection, including Phosphor tone, filled state, Japanese label, English label, and accessible text.
- [x] 1.6 Refactor `web/src/shell/shellStyles.js` into semantic role helpers that preserve current ZAPAC output and expose the Phosphor frame/chrome recipes without ZAPAC literal fallbacks leaking into Phosphor.

## 2. Skin-neutral shared presentation primitives

- [x] 2.1 Add a skin-neutral status primitive that reproduces the current ZAPAC status pill and uses the vendored Phosphor `Stamp` grammar, including filled, blinking/in-progress, semantic-tone, and accessible-label states.
- [x] 2.2 Add or consolidate skin-neutral Empty State and rail Search primitives that reproduce the current ZAPAC behavior and inherit native Phosphor MUI presentation.
- [x] 2.3 Migrate all app runtime consumers from ZAPAC-owned `StatusPill`, `EmptyState`, and `SearchInput` exports to the local primitives and verify their default, hover, focus, disabled, loading, and error/empty states.
- [x] 2.4 Remove the temporary `theme.zapac` and `palette.glass` assignments from `web/src/theme/skins/phosphor.jsx`; keep only the normalized `theme.tokens` adapter and confirm development contract checks emit no missing-token warnings.
- [x] 2.5 Build the production bundle and inspect the Phosphor component imports/output size; keep named vendored atoms that tree-shake acceptably and use existing MUI overrides for stock controls.

## 3. Phosphor application frame and masthead

- [ ] 3.1 Add a Phosphor-only root frame around the existing `AppShell` interaction tree: void surface, orange double border, deliberate chamfers, semantic z-layers, and no glass blur or cast elevation.
- [ ] 3.2 Add the Phosphor masthead using real product, connection, agent/load, loopback-address, and local-time data; pair every Mincho label with English and omit unsupported demo telemetry.
- [ ] 3.3 Ensure the vendored CRT scanline/vignette pass covers the shell exactly once, remains pointer-transparent, and does not obscure or stack above menus, dialogs, tooltips, or the task dossier.
- [ ] 3.4 Implement progressive masthead/frame behavior at desktop, intermediate, narrow, zoomed-text, and short-height layouts so secondary metadata collapses first and no bilingual pair or primary control is orphaned.
- [ ] 3.5 Confirm the existing persistent view state, dialog orchestration, terminal LRU, sidebar row, and dock resize band remain the same behavior/state tree inside the Phosphor frame.

## 4. Sidebar and overflow navigation

- [ ] 4.1 Add bilingual metadata to primary and overflow navigation definitions, then render Phosphor New Session, Tasks, Automation, Usage, and More controls as hard-edged boxed console controls while preserving ZAPAC markup and styling.
- [ ] 4.2 Replace the ZAPAC active gradient treatment with Phosphor semantic inversion and stamped live counts only under Phosphor; keep click, repeated-click collapse, tooltip, and keyboard behavior unchanged.
- [ ] 4.3 Render Phosphor usage from the existing provider data as segmented or theme-native meter readouts with real percentages/placeholders and no fabricated providers or telemetry.
- [ ] 4.4 Render daemon connectivity and address as a semantic Phosphor stamp/readout, including an explicit red disconnected state and accessible non-color label.
- [ ] 4.5 Restyle `AppMenu` as an orange-framed Phosphor console menu with bilingual items, real system readings, visible focus, portaled unclipped placement, and red destructive restart treatment while preserving all destinations/actions.

## 5. Tasks board and task dossier

- [ ] 5.1 Add the Phosphor Tasks viewbar and bilingual status legend using the centralized lifecycle mapping, existing Board/History segmented interaction, live task stats, and New Task action.
- [ ] 5.2 Restyle Phosphor board columns with bilingual headers and stamped counts while preserving the existing accessible column names, drag targets, filters, history switch, and data ordering.
- [ ] 5.3 Restyle task cards as void, hard-edged, state-bordered console records with stamps, repo/branch metadata, tags, actual stats, and segmented progress; keep activation, drag, hover actions, and screen-reader names unchanged.
- [ ] 5.4 Restyle `TaskDetailPanel` as the Phosphor dossier with chamfered fixed sheet, semantic status/id, tabular stats, directive/details, ordered activity, optional segmented progress/gate, and sticky Transcript/Open Session actions.
- [ ] 5.5 Verify the dossier continues to trap/restore focus, close by button/scrim/Escape, reflect live task updates, handle removal gracefully, and render outside the clipped frame at narrow widths and reduced motion.
- [ ] 5.6 Verify create/edit task dialogs, tag/filter controls, task History, empty/loading/error states, and all task operations inherit coherent Phosphor MUI presentation without changing API calls or task data.

## 6. Session dock, terminal, and transcripts

- [ ] 6.1 Replace the mode-only terminal palette table with a tested `skinId + resolvedMode` resolver that preserves both existing ZAPAC palettes and adds the Phosphor void/amber/mint/blue/red palette with an AA-safe dim foreground.
- [ ] 6.2 Update `Terminal.jsx` to consume the active skin palette and apply palette changes without clearing xterm buffers or changing attach, WebGL fallback, input, selection, copy/paste, keyboard cycling, resize, or scrollback behavior.
- [ ] 6.3 Update transcript terminal/ANSI rendering to use the same palette resolver while preserving normal user/assistant prose casing and message hierarchy.
- [ ] 6.4 Restyle `SessionDock` under Phosphor as a flat orange-ruled dock with bilingual zone header, amber terminal bar, semantic connection state, hard-edged controls, and unchanged minimize/resize mechanics.
- [ ] 6.5 Restyle `SessionRow` and subagent indicators from the centralized status mapping, including filled selected state, accessible status text, and unchanged session action availability/reorder behavior.
- [ ] 6.6 Route skin selection through the existing live-session respawn confirmation: prompt with the live count, never respawn automatically, and skip the prompt when no live sessions exist.
- [ ] 6.7 Verify minimized dock, persisted dock/list sizes, active session selection, terminal remount/reattach, transcript prompt, and all duplicate/fork/resume/restart/external/remove actions under both skins.

## 7. Cross-view quality audit

- [ ] 7.1 Visit every primary and overflow view under Phosphor and fix any remaining ZAPAC gradient, glass, large-radius, drop-shadow, or missing-token presentation using theme overrides or semantic app roles.
- [ ] 7.2 Audit dialogs, drawers, menus, tooltips, snackbars, tables, inputs, editors, CodeMirror, Mermaid, markdown, search, empty/loading/error states, and destructive confirmations for complete Phosphor interaction states.
- [ ] 7.3 Audit typography so chrome uses the condensed/mono/bilingual system but user prose, paths, source code, terminal output, and long-form content retain original case and readable line length.
- [ ] 7.4 Measure foreground/background contrast for body, secondary, placeholder, status, error, terminal normal, and terminal dim text; adjust semantic tokens rather than one-off component colors until WCAG AA is met.
- [ ] 7.5 Keyboard-test nav, menus, dialogs, task cards/dossier, session actions, segmented controls, and both resize separators; ensure visible focus, accurate names, and no focus hidden beneath the CRT layer.
- [ ] 7.6 Test `prefers-reduced-motion: reduce` and ensure blink, strobe, flicker, stepped fill, drawer/menu motion, and animated CRT effects stop while every final state remains visible.

## 8. Automated and visual verification

- [ ] 8.1 Extend Appearance e2e coverage for selecting/persisting dark-only Phosphor, live-session respawn confirmation, no-live-session switching, and switching back to unchanged ZAPAC light/dark controls.
- [ ] 8.2 Add focused Phosphor shell e2e assertions for the frame/masthead, bilingual navigation, semantic current state, live counts/connection, portaled menu, and absence of ZAPAC glass identifiers.
- [ ] 8.3 Extend Tasks e2e coverage under Phosphor for status legend/columns/cards, card-to-dossier behavior, dossier dismissal/actions, drag/filter/history regressions, and narrow-viewport overlay containment.
- [ ] 8.4 Extend dock/terminal tests for persisted resize/minimize, semantic session state, skin-aware palette resolution, transcript palette parity, and unchanged terminal/session operations.
- [ ] 8.5 Run `pnpm lint`, `pnpm test`, `pnpm build`, and the full `pnpm test:e2e` suite; resolve all failures without weakening existing ZAPAC assertions.
- [ ] 8.6 Perform and record a manual side-by-side visual review against `docs/one-shot/phosphor-layout-02.html` at desktop, intermediate, narrow, short-height, 200% zoom, and reduced motion, then repeat a ZAPAC light/dark regression pass.
