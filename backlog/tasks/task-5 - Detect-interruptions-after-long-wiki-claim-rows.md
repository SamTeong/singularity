---
id: TASK-5
title: Detect interruptions after long wiki claim rows
status: Done
assignee: []
created_date: '2026-10-16 15:50'
updated_date: '2026-10-16 15:53'
labels: []
dependencies: []
modified_files:
  - server/wiki.test.mjs
  - server/wiki.mjs
priority: low
type: bug
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sweep-history parsing truncates a ledger body at 1200 characters before removing supported NEW, UPDATE, and OVERTURNS claim rows. A failed lane after a long claim section can therefore be recorded as a completed sweep.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Supported claim rows do not hide a later interruption marker beyond the summary cap.
- [x] #2 Existing completion and interruption parsing behavior remains covered by server tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a focused regression with claim content beyond 1200 characters followed by a failed-lane marker and verify it fails on the current parser. 2. Strip supported claim rows before applying the summary cap. 3. Run the focused wiki test and record the result.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Focused verification: node --test server/wiki.test.mjs passed all 13 tests after the fix. The added long-claim regression failed before the fix (12 passed, 1 failed) and passes now.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved the interruption-status cap after removal of supported NEW, UPDATE, and OVERTURNS claim rows. Verified with the focused wiki suite (13 passed), including a regression that failed before the parser change.
<!-- SECTION:FINAL_SUMMARY:END -->
