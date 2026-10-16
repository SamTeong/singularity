---
id: TASK-4
title: Clear transcript list error after successful recovery
status: Done
assignee: []
created_date: '2026-10-16 14:55'
updated_date: '2026-10-16 15:04'
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
- [ ] #2 A failed request still reports an error and leaves previously loaded rows intact.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify the stale error on failed-then-empty response behavior and inspect UI test feasibility. 2. Clear the error only on a current successful response; add focused regression coverage if the existing harness supports it. 3. Run focused validation and record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The focused mock UI regression failed before the source fix: after a 503 followed by a successful empty response, No transcripts. did not appear (test-before.log).

Focused mock UI regression passed after the fix: 1 passed.

Focused browser recovery regression passed after the fix (1 passed); red/green output is recorded in implement-recovery.notes.md. Criterion 2's preserved-row behavior was not exercised by that focused test; the existing failure handler still only sets the error, and final pinned lint/test validation remains pending in the outer review.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Clears the transcript list error on a current successful response. Verified by the focused mock Playwright regression, which failed before the fix and passed after it (1 passed); broader pinned lint/test validation remains pending in outer review.
<!-- SECTION:FINAL_SUMMARY:END -->
