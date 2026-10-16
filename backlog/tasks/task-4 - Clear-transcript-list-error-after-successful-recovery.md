---
id: TASK-4
title: Clear transcript list error after successful recovery
status: Done
assignee: []
created_date: '2026-10-16 14:55'
updated_date: '2026-10-16 15:53'
labels: []
dependencies: []
modified_files:
  - e2e-mock/transcripts.spec.mjs
  - web/src/features/transcripts/SessionHistory.jsx
priority: low
type: bug
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A failed transcript list request sets an error message that remains visible after a later successful poll returns no rows. The empty list then reports a stale failure despite recovery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A current successful transcript list response clears a prior list error.
- [x] #2 A failed request preserves previously loaded rows and reports an error when the list is empty.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify the stale error on failed-then-empty response behavior and inspect UI test feasibility. 2. Clear the error only on a current successful response; add focused regression coverage if the existing harness supports it. 3. Run focused validation and record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Focused mock UI regression failed before the source fix: after a 503 followed by a successful empty response, No transcripts. did not appear (test-before.log). Focused mock UI regression passed after the fix (1 passed); focused browser recovery regression passed after the fix (1 passed), with red/green output in implement-recovery.notes.md. e2e-mock/transcripts.spec.mjs:66-67 asserts the initial 503 and Failed to load transcripts. message; lines 73-75 verify a successful empty poll clears the error. The separate failed-poll test at lines 78-100 confirms all 32 previously loaded seeded rows remain after a 503. Follow-up verification waits across two animation frames after the mocked 503 resolves before checking rows; the focused browser command passed 2 tests. Final pinned validation at ed8256d67f2a9fb59d7dc1c22dbfa329d619c1e4 passed: pnpm lint, pnpm test (586 passed), and the focused mock Playwright recovery run (2 passed).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Clears the transcript list error after a successful response and preserves already loaded rows after a later failed poll. Verified by the focused mock Playwright run: 2 passed. The current UI shows the error message only when no rows remain.
<!-- SECTION:FINAL_SUMMARY:END -->
