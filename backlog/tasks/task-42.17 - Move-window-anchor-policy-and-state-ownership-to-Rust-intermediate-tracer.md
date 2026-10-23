---
id: TASK-42.17
title: Move window-anchor policy and state ownership to Rust (intermediate tracer)
status: Done
assignee:
  - '--plan'
created_date: '2026-10-22 23:44'
updated_date: '2026-10-23 15:26'
labels: []
dependencies:
  - TASK-47
  - TASK-42.16
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/window-anchor-policy-design.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/async-oneshot-boundary-design.md
modified_files:
  - rust/backend/src/window_anchor.rs
  - rust/backend/src/main.rs
  - rust/backend/src/usage_snapshot.rs
  - server/rust-backend.mjs
  - server/window-anchor.mjs
  - server/window-anchor.test.mjs
  - server/rust-backend.test.mjs
  - server/index.mjs
  - server/pty-ws.mjs
  - server/pty-ws.test.mjs
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rust currently owns only window-anchor persistence; Node owns the live policy state machine. Move policy and state transitions into a focused Rust service over the correlated private bridge. This is an intermediate policy/state migration: Node temporarily retains actual timer handles, usage-bus subscription, preflight refresh, model routing, async one-shot invocation, ordered effect execution, and event relay. Final daemon cutover must move actual clock/timer ownership and direct event delivery into Rust, then remove this adapter. Implement only after TASK-42.16 is completed and its pricing changes are accepted and committed because its work overlaps main.rs and rust-backend.test.mjs. Preserve that work and layer on accepted TASK-47 baseline 969894dedcd6d16b4ba3286801cfaf7f2e56cc3d. Preserve production routes /window-anchor and /window-anchor/poke. The test-only /api/window-anchor mismatch is a known pre-existing defect: preserve and report for a separately authorized route-contract task. Exact eight-file source/test boundary: rust/backend/src/window_anchor.rs; rust/backend/src/main.rs; server/rust-backend.mjs; server/window-anchor.mjs; server/index.mjs; server/pty-ws.mjs; server/window-anchor.test.mjs; server/rust-backend.test.mjs. Two narrowly scoped exceptions are also permitted, making ten files total: rust/backend/src/usage_snapshot.rs for its documented existing helper, and server/pty-ws.test.mjs for the independently reviewed asynchronous-initialization fixture repair documented in accept-pty-storage-fixture.notes.md and audit-anchor-final-acceptance.notes.md. That test-only repair is required for full Node validation of the asynchronous WebSocket snapshot initialization. Do not include server/usage.mjs or any other files; stop for review if required runtime proof cannot fit these seams. Groma reports no current owner; do not invent refs or scan/curate the architecture map.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns authoritative enablement, provider snapshots, usage and timer/manual-poke decisions, timer generations/deadlines, active-window skip, dedupe/retry history, attempt timestamps, action results, and ordered effects; Node has no parallel policy or snapshot cache.
- [x] #2 All specified correlated window_anchor_* operations preserve request fields, response and snapshot/telemetry shapes, startup-default behavior, provider iteration order, and ordered persistence/event effects; failed append/save warns while later effects continue, and manual poke awaits its effects.
- [x] #3 Node executes returned explicit window-anchor effects in order while retaining temporary timer wakeups, usage/event/preflight/model adapters, and the accepted TASK-47 async one-shot FIFO; ordinary policy and snapshot requests progress during a delayed one-shot.
- [x] #4 Both snapshot consumers preserve the production HTTP body and WebSocket frame shape/order; WebSocket initialization buffers all outbound frames in order up to 256 frames and 1 MiB, closes 1013 on overflow, clears on close, and sends initial frames before buffered frames.
- [x] #5 Deterministic tests cover timer generations and accepted-preflight behavior, preflight success/failure and FIFO ordering, force/manual gates, dedupe/retry/alias/re-init cases, effect order/failure continuation, concurrent action completions, async one-shot progress, route/snapshot compatibility, and WebSocket queue overflow/close behavior without wall-clock sleeps or provider calls.
- [x] #6 Focused Rust and Node checks plus isolated Windows runtime acceptance pass against fake usage/one-shot inputs; persisted state/telemetry, restoration, effect/timer/event order, and snapshot contracts are evidenced. Final daemon clock/timer/event cutover remains explicitly deferred.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement Rust window-anchor ownership, ordered Node effects and async snapshots, then deterministic tests; record hashes and delegated verification commands.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final acceptance: frozen Windows runtime receipt C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/anchor-frozen-execution/run-20261023T152135780Z/execution-receipt.json passed against HEAD 906e66bf2094bfd94d33f07897f7e2063f425e14; owner checks, binary freeze, syntax checks, WebSocket probe and final freeze exited 0 with complete cleanup. Reused bridge/adapter/routes checks: 17/9/5; WebSocket probe: 5 checks; frozen sources: 9, guards: 5. Persisted state, restoration, and delivery evidence is in the frozen owner receipt. Final daemon clock/timer/event cutover remains deferred; Node retains intermediate timer, usage/preflight/event, model-routing, async one-shot, and effect adapters. Groma ownership was unavailable; references remain empty.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved authoritative window-anchor policy and state ownership to Rust while preserving production routes and ordered Node adapters. All six acceptance criteria are checked against the frozen terminal Windows runtime receipt at HEAD 906e66bf2094bfd94d33f07897f7e2063f425e14: owner checks passed; bridge/adapter/routes checks 17/9/5; WebSocket attachment probe 5 checks; final binary freeze passed. Final clock/timer/event cutover remains deferred.
<!-- SECTION:FINAL_SUMMARY:END -->
