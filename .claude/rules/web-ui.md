---
paths:
  - "web/src/**"
---

# Web UI rules

## Routing
- Every view is a real URL (`BrowserRouter`, no basename). `web/src/shell/views.mjs` is the one catalog (`NAV` in Sidebar = rail, `NAV_ITEMS` in AppMenu = More menu, deduped). An unknown id redirects to `/tasks`. `AppShell`'s `view` comes from `useParams`. `localStorage['sing-view']` only remembers where a bare `/` redirects.
- Per-view filters live in the query string via `web/src/hooks/useQueryState.js` (`useQueryState`/`useQueryList`/`useUpdateQuery`). Use repeated params, never CSV (tags and paths contain commas). A param equal to its default is absent. An invalid value degrades to the default. Multi-key changes go through one `useUpdateQuery` patch, because two `setSearchParams` calls in one tick lose the first write.

## Responsive
- Shell viewport decisions import `PHONE_QUERY`/`TABLET_QUERY`/`SHORT_QUERY` from `web/src/shell/breakpoints.js`. Never use `theme.breakpoints.*` for them: ZAPAC and Phosphor Console ship different pixel values. Feature-internal layout may use theme breakpoints or `repeat(auto-fit, minmax(...))`.
- Reuse `components/panelkit/PhonePane.jsx` (Rail editor phone single-pane) and `components/TableScroller.jsx` (dense table below 900px).
- Any new narrow representation needs a responsive spec (`e2e-mock/*-responsive.spec.mjs` or `shell-mobile-nav`/`shell-dock-responsive`), proven to fail before the fix, and looping both skins when the assertion is skin- or column-count-sensitive. `expectNoPageOverflow` measures horizontal overflow only. For bounded scroll regions use `expectReachableByPaneScroll` (`e2e-mock/helpers/responsive.mjs`); `scrollIntoViewIfNeeded()` + `toBeInViewport()` stay green even when the region is removed.

## CodeMirror (`CmEditor`)
- Every `<CmEditor>` needs `key={<visible file>}`. `@uiw/react-codemirror`'s 200ms `typingLatch` otherwise drops the `value` update on a dirty save/discard + navigate, and the editor shows the old file.
- Window keydown handlers for keys CodeMirror also binds (e.g. Alt+↑/↓ tab-cycle vs `moveLineUp/Down`) must register in **capture** phase and `stopPropagation()` once matched. Otherwise the editor mutates the outgoing doc first (`ConfigEditor.jsx:274`, `ExplorerPanel.jsx:260`).

## Canvas libs (cytoscape)
The vendored theme uses MUI CSS-variable schemes: `theme.palette.mode` is static and many palette values are `var()` strings, which a canvas renders as black. Pick concrete hex from the live mode (`useColorScheme()` → `mode==='system' ? systemMode : mode`) and add it to effect deps. `cy.on('tap')` binds once inside async `.then()`, so route it through a ref to avoid a stale closure.
