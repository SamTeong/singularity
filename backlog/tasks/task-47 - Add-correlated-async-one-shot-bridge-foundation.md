---
id: TASK-47
title: Add correlated async one-shot bridge foundation
status: Done
assignee: []
created_date: '2026-10-22 15:53'
updated_date: '2026-10-22 16:20'
labels: []
dependencies:
  - TASK-46
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/async-oneshot-boundary-design.md
modified_files:
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - server/rust-backend.test.mjs
priority: medium
type: feature
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Long provider one-shots currently run inside Rust ordinary stdin dispatch and prevent later Rust policy requests from being read. A private correlated one-shot result lane lets actions complete without blocking the ordinary request FIFO while preserving provider serialization and the current Node stop contract. See the linked design for the EOF boundary and remaining forced-stop gate. Before implementation, verify TASK-46 is committed and its shared main.rs/bridge worktree lease is released; do not overlap edits to those shared files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Node accepts only matching oneshot_reply frames in a pending-one-shot map separate from ordinary and status correlation; malformed, unknown, duplicate, bridge-failure, and stop paths settle each pending promise at most once.
- [x] #2 The existing Node oneShot API routes calls through one dedicated FIFO and retains its current signature, timeout, captured output, and error behavior; while one synthetic one-shot is pending, an ordinary request and a correlated status request can complete.
- [x] #3 Rust handles oneshot_async with spawn_blocking while retaining the legacy synchronous oneshot operation; normal replies preserve the existing one-shot payload and an overlapping async one-shot receives a correlated error.
- [x] #4 Rust associates each Tokio task ID with its request ID, maps a JoinError task ID to a correlated failure reply, reaps completed task mappings on the normal input path, and drains the bounded registry at EOF.
- [x] #5 An offline synthetic-child EOF test closes Rust stdin while work is running and proves the correlated completion is written before process exit; existing stop tests preserve Node stop rejection, stdin close, and the two-second forced kill.
- [x] #6 Existing ordinary and status frame validation, one-shot success/error/timeout behavior, and one-at-a-time provider serialization remain covered without calling a real provider.
- [x] #7 The implementation changes no policy behavior, public route, snapshot owner, cancellation, coalescing, or unsolicited-event protocol; forced Node stop is not claimed to guarantee nested provider cleanup or accepted-result delivery.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the private correlated oneshot_async result lane in the Rust stdin dispatcher and Node bridge. Keep one-shot calls serialized on their own FIFO, preserve ordinary/status lanes and Node stop behavior, and drain accepted Rust work on direct stdin EOF. Extend focused fake-child and EOF coverage; leave forced-stop nested-provider cleanup as a documented gate.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Windows acceptance finalization: reviewer PASS with zero blockers; the seven-step receipt passed fmt, Rust tests (210 library + 3 binary), release build, focused Node (49 passed/0 failed/2 skipped), full Node (728 passed/0 failed/2 skipped), lint, and diff-check. Independently rebound all three source hashes and both Cargo guard hashes to the receipt; all matched before/after. Release executable SHA-256: 625CF08C597D8747A4459C50048E57474CE7F8D20FC21EC689EA990E8B9F4990. All 3 implementation VERIFY anchors and both check-preparation anchors count exactly once. Limitations: release build emitted three unused_assignments warnings for one_shot_active; JoinError panic correlation has no dedicated test; forced Node stop retains rejection/stdin close/two-second kill behavior but does not guarantee nested provider cleanup or accepted-result delivery, and nested-child cleanup ownership remains unknown. TASK-47 does not claim whole-daemon cutover; TASK-42.2 cross-platform validation and broader TASK-42 items remain open.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the private correlated async one-shot bridge in the three listed source files. Accepted verification receipt passed all seven checks: 210 Rust library + 3 binary tests, focused Node 49 passed/2 skipped, full Node 728 passed/2 skipped, fmt, release build, lint, and diff-check; frozen source and Cargo guard hashes matched before/after. Three non-blocking unused_assignments warnings and the untested panic-correlation branch are recorded; forced-stop nested-child cleanup is not guaranteed.
<!-- SECTION:FINAL_SUMMARY:END -->
