---
id: TASK-48
title: 'Usage 7d history: add 5h % series to the 7d chart'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-24 15:28'
updated_date: '2026-10-24 15:33'
labels: []
dependencies: []
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 7d history panel currently plots only the provider's weekly % as a single line. Each raw usage row already carries both windows (five_hour + seven_day, session + weekly), but the 7d response path discards the 5h column. Users comparing weekly burn against the 5h window must switch tabs. The 5h window charts keep their per-session breakdown and must not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/usage/history?window=7d points carry pct5h from the same row's 5h selector (null when absent); the 5h doc shape is unchanged
- [x] #2 The 7d chart renders a second line series labelled '5h %' beside '7d %', y axis stays 0-100%
- [x] #3 Mirage mock 7d handler returns pct5h and the existing 46% peak assertion still passes
- [x] #4 Unit test covers pct5h in the 7d doc; pnpm lint && pnpm test green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Server: readTotals carries pct5h per 7d row; buildDoc 7d points expose it (5h doc shape untouched). 2. Panel: non-estimated chart adds the '5h %' line when points carry pct5h. 3. Mock 7d handler returns pct5h. 4. Server unit test asserts pct5h (incl. null for Ollama). 5. pnpm lint && pnpm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Server: readTotals attaches pct5h from the 5h selector only on the 7d path; buildDoc adds pct5h to 7d points only, so Ollama 5h points keep {ts,pct,sessions}. Panel: non-estimated branch adds the '5h %' line when any point carries pct5h; null points stay gaps. Mock 7d carries a pct5h sawtooth; pct curve (max 46%) unchanged. Validation: pnpm lint clean, pnpm test 621/621, e2e-mock usage + usage-history-responsive 16/16, and the 7d toggle spec now asserts the '5h %' legend (1/1 with the assertion added). Known limit: the 5h line sawtooths as the 5h window rolls each cycle; that is the raw per-reading value, not a derived series.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
GET /api/usage/history?window=7d points now carry pct5h from the same row's five_hour/session reading, and the 7d chart draws a second '5h %' line beside '7d %' (null gaps, y axis still 0-100%). The 5h per-session charts and their doc shape are unchanged. Verified with lint, 621 unit tests, 16 e2e-mock usage specs, and a new '5h %' legend assertion in the 7d toggle spec.
<!-- SECTION:FINAL_SUMMARY:END -->
