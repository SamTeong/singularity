---
id: TASK-42.9
title: Make Rust status timeout test deterministic under parallel execution
status: Done
assignee: []
created_date: '2026-10-22 00:11'
updated_date: '2026-10-24 02:22'
labels: []
dependencies:
  - TASK-42.6
modified_files:
  - rust/backend/src/status.rs
parent_task_id: TASK-42
priority: low
type: task
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A full parallel Rust test run recorded one failure in the existing status header-timeout test, and a later parallel rerun hung. The focused and serial full-suite runs pass. Evidence does not establish a production defect or prove the original cause. Make this test fixture bounded and deterministic so it exercises the intended timeout contract reliably under parallel load.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The status timeout test completes under parallel full-suite execution and verifies the intended timeout contract without a scheduling-sensitive 10 ms header assumption.
- [x] #2 The local server fixture bounds accepted-stream header reads so a missing request cannot leave the test process hung.
- [x] #3 A full parallel Rust test run passes with this test included, and the receipt distinguishes fixture behavior from production timeout behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Bound the delayed-loopback fixture header reads and surface worker termination; 2. Replace the 10 ms test assumption with explicit timeout/body margins; 3. Prepare an isolated owned runner and defer project test/build execution to the validation lane.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Terminal receipt SHA256 BC9CD8B20D1E15CE223BC1E936D724FD5F28FDD677D6DF4BB92EB9AA697023CE; HEAD 76f5ed9518fb3e7c5b1fe1f8972c96dceb26e5a9; source SHA256 A60619E899A60B4585031AE5BA2A5782CE866C9A064C0163D6DB6273696E4F02. All 42 frozen inputs match before and after. Five runner steps exited 0 with cleanup complete in an isolated target: rustfmt, focused retry/body contract test, focused incomplete-header test (1 passed, 0.31s), full parallel release suite using default Cargo threading (240 lib tests + 3 bin tests passed; 0 doc tests), and diff check. The receipt distinguishes fixture header deadline behavior from unchanged production timeout behavior. Historical hang cause remains unproven; this fix addresses the confirmed fixture hazard.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bound the status test server's accepted-stream header reads and replaced scheduling-sensitive timing margins while preserving production timeout behavior. The terminal runner receipt records focused tests and the full default-thread parallel release suite passing.
<!-- SECTION:FINAL_SUMMARY:END -->
