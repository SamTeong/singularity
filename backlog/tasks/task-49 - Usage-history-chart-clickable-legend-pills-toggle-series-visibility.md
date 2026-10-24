---
id: TASK-49
title: 'Usage history chart: clickable legend pills toggle series visibility'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-24 15:37'
updated_date: '2026-10-24 15:48'
labels: []
dependencies: []
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The usage history chart renders an implicit MUI legend. Users need to isolate a series: with none selected a click solos that series, a click on an unselected pill while others are selected adds it, and deselecting the last one restores all. The harness-usage-report HTML (reports/report-2026-10-18_202515.html, .swatch-legend + .legend .lg-item) is the reference behavior. Applies to the 7d chart (7d % / 5h %) and the per-session 5h charts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every multi-series chart renders one clickable pill per series with the series color swatch and aria-pressed state; the MUI default legend is not duplicated
- [x] #2 Clicking a pill with none selected shows only that series; clicking an unselected pill while others are selected adds it; clicking a selected pill hides it and an empty selection shows all series
- [x] #3 Series colors stay identical to today's chart colors when toggling
- [x] #4 e2e-mock spec proves the solo/add/hide/restore sequence on the 7d chart; pnpm lint && pnpm test green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Panel: build series with explicit colors from the x-charts default palette (fallback local palette) so toggling never recolors. 2. Local legend state Set; a hidden series gets all-null data (index-stable colors), empty set = all visible; solo on first click. 3. Render swatch pills with aria-pressed inside the figure; hide the MUI default legend. 4. e2e-mock: prove solo/add/hide/restore on the 7d chart and one 5h session pill. 5. pnpm lint && pnpm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Panel keeps index-stable colors from the chart own default palette (rainbowSurgePalette, resolved per color scheme via useColorScheme, so Phosphor dark keeps dark-mode hexes); a hidden series keeps its slot with all-null data instead of being filtered, so no series recolors when toggling. Pills render only when series.length > 1, with an 11px swatch, aria-pressed, opacity 0.45 when unpressed; the implicit MUI legend is hidden with hideLegend. Selection is a Set: empty = all visible, first click solos, adding is additive, removing the last restores all; it resets when provider or window changes via a guarded render-phase update because react-hooks/set-state-in-effect forbids the effect form. Deviations: blueberry is not exported by @mui/x-charts 9.15.0 (only *Palette factories), so rainbowSurgePalette is used; slotProps.legend.hidden is a no-op in 9.15.0, hideLegend is used. Line counting in e2e uses path.MuiLineChart-line:not([d=empty]) semantics - a hidden series still emits a path whose d is empty. Known limits: hovering a hidden series shows no values; the peak label follows the 7d pct even when that series is hidden. Validation: pnpm lint clean, pnpm test 621/621, mock build, usage + usage-history-responsive 16/16.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The usage history chart now has clickable legend pills (swatch + aria-pressed) for every series: with none selected a click solos that series, a click on an unselected pill adds it, and deselecting the last one restores all series. Hidden series keep their slot with null data so colors never shift, colors come from the chart own mode-aware default palette, and the implicit MUI legend is suppressed. Covered by the 7d solo/add/hide/restore sequence and a 5h session solo in e2e-mock; lint, 621 unit tests and 16 mock e2e tests pass.
<!-- SECTION:FINAL_SUMMARY:END -->
