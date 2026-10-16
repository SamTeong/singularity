---
id: TASK-5
title: Detect interruptions after long wiki claim rows
status: Done
assignee: []
created_date: '2026-10-16 15:50'
updated_date: '2026-10-16 16:22'
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
Historical regression evidence: wiki.test.mjs:104 covers the interruption marker after long claim rows. It failed on the original parser with 12 passed and 1 failed, then passed after the parser fix with 13 passed. The later completion and continuation regressions at wiki.test.mjs:112-124 failed on the intermediate round-1 code with 13 passed and 1 failed, then passed after the shared-summary fix with 14 passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All parser status checks now use the same claim-stripped, 1200-character summary. The focused wiki suite passed all 14 tests, including long-claim completion and continuation regressions that failed before the fix.
<!-- SECTION:FINAL_SUMMARY:END -->
