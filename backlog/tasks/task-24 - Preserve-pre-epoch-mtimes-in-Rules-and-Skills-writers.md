---
id: TASK-24
title: Preserve pre-epoch mtimes in Rules and Skills writers
status: Done
assignee: []
created_date: '2026-10-20 07:38'
updated_date: '2026-10-20 07:45'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/rules.rs
  - rust/backend/src/skills.rs
type: bug
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rules and Skills mtime conversion currently drops or errors on filesystem modification times before the Unix epoch. This prevents signed Node-style mtime values from being used consistently by these writers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rules mtime conversion preserves positive and negative SystemTime values as signed fractional milliseconds.
- [x] #2 Skills mtime conversion preserves positive and negative SystemTime values as signed fractional milliseconds.
- [x] #3 Existing metadata failure behavior, the greater-than-1ms conflict guard, force behavior, and backup semantics remain unchanged.
- [x] #4 Deterministic unit tests cover positive and negative timestamps in both domains.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Update Rules and Skills timestamp conversion locally and add deterministic signed-time unit tests. 2. Run the requested Rust, release, and focused Node bridge checks. 3. Record results and filesystem limits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented signed SystemTime-to-millisecond conversion in Rules and Skills with deterministic ±2750.125 ms unit tests. Verification: cargo tests 50 passed; cargo fmt check, release build, and git diff --check passed. Focused Node Skills/Rust bridge run reported 40 passed, 1 failed, 1 skipped: Rules bridge startup timed out waiting for its ready signal while the release build ran concurrently; Skills bridge cases passed. Per the one-run constraint, the Node command was not repeated. Existing Rules/Skills backup behavior was left untouched. Groma reports no enabled scanner owner for these Rust files, so no architecture reference could be added.

Follow-up verification: after the concurrent release build completed, ran only the previously failing Rules bridge case by test-name pattern; it passed (1 passed, 0 failed, EXIT=0). The initial timeout was transient under concurrent startup load; focused bridge verification now passes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rules and Skills now preserve signed fractional millisecond mtimes with deterministic positive and negative SystemTime tests. Verified with 50 passing Rust tests, cargo fmt check, release build, diff check, and focused Skills/Rules bridge coverage; an initial concurrent Rules startup timeout passed on isolated rerun. Negative filesystem mtime integration remains unavailable on this Windows filesystem.
<!-- SECTION:FINAL_SUMMARY:END -->
