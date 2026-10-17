---
id: TASK-10
title: 'Usage history: 5h/7d window toggle'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-17 02:32'
updated_date: '2026-10-17 02:40'
labels: []
dependencies:
  - TASK-7
modified_files:
  - server/usage-history.mjs
  - server/index.mjs
  - server/usage.mjs
  - web/src/mock/routes/telemetry.js
  - web/src/features/usage/UsageHistoryPanel.jsx
  - server/usage-history.test.mjs
  - e2e-mock/usage.spec.mjs
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a 5h/7d toggle to the Usage history panel. 7d shows each provider's account weekly % as a single total line (no per-session split; option A in explore-7d notes). 5h view unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/usage/history accepts window=5h|7d (default 5h); 7d returns weekly % points in the current weekly window per provider (Claude raw.seven_day, Codex/Ollama weekly) with estimated:false and no session split
- [x] #2 Claude 7d reads enough of usage-snapshots.jsonl to cover the week (tail larger than 2 MB, downsampled)
- [x] #3 Mirage mock handler supports window=7d
- [x] #4 Panel has a 5h/7d toggle; 7d x-axis labels each local midnight, vertical grid every 6h; y 0-100%
- [x] #5 Unit tests for 7d window and mock; e2e-mock covers the toggle
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Server: window=5h|7d on GET /api/usage/history; 7d = weekly % total line per provider (estimated:false), larger bounded tail, 15-min downsample. 2. Mock handles window=7d. 3. Panel 5h/7d toggle; tick helper generalised by step; 7d midnight labels, 6h grid. 4. Fix stale usage.mjs comment. 5. Unit + e2e-mock tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented window=5h|7d (7d = weekly % total line, estimated:false, 8 MB tail, 15-min downsample), mock 7d, panel 5h/7d toggle with stepTicks, stale usage.mjs comment fixed. pnpm lint, pnpm test (603 pass), e2e-mock usage specs (16 pass) green.

Validation: pnpm lint clean, pnpm test 603/603, e2e-mock usage specs 16/16. Independent review pass, no blockers. Option A per user: 7d = weekly % total per provider, no per-session split. Deviation: 5h ticks now aligned to local UTC offset (fixes :45 zones). Known limit (review M1): 7d reads an 8 MB tail of usage-snapshots.jsonl synchronously on each poll, uncached; add a cache if polling cost shows.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
GET /api/usage/history takes window=5h|7d (unknown values 400). 7d charts each provider's account weekly % (Claude raw.seven_day, Codex/Ollama weekly) over the current weekly window, bucketed to 15 min, no session split. The panel has a 5h/7d toggle; 7d labels each local midnight with 6h grid lines. Mock backend supports 7d. Verified with lint, 603 unit tests, 16 e2e-mock tests and an independent review.
<!-- SECTION:FINAL_SUMMARY:END -->
