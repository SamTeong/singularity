---
id: TASK-38
title: Add dedicated Rust PTY service and Node bridge
status: Done
assignee: []
created_date: '2026-10-20 14:00'
updated_date: '2026-10-20 15:11'
labels: []
dependencies: []
modified_files:
  - rust/backend/Cargo.toml
  - rust/backend/Cargo.lock
  - rust/backend/src/pty.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-pty-backend.mjs
  - server/fixtures/rust-pty-protocol-fixture.mjs
  - server/fixtures/rust-pty-child.mjs
  - server/rust-pty-backend.test.mjs
  - docs/rust-pty-compatibility.md
type: feature
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace only the live PTY process boundary in a staged migration. This first slice supplies a dedicated Rust service process and Node bridge that the later registry integration can adopt without changing session policy or registry behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Rust executable supports a separate --pty JSON-lines mode using pinned portable-pty 0.9.0 while the ordinary backend mode remains isolated.
- [x] #2 The bridge distinguishes response and event envelopes, preserves per-generation event ordering and UTF-8 decoder state, buffers early events until handlers are activated, and rejects stale generations.
- [x] #3 Rust handles PTY spawn, reads, queued writes, resize, kill, wait/reap, and shutdown without blocking the control loop on PTY input writes.
- [x] #4 Focused tests cover protocol handling and real PTY behavior on the available host, including final output ordering, backpressure responsiveness, and shutdown.
- [x] #5 A developer document records the approved Windows ConPTY DLL selection difference and its runtime evidence limits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the pinned portable-pty crate and a dedicated --pty service with serialized JSON-lines responses/events, per-session workers, lifecycle cleanup, and focused Rust tests. 2. Add a standalone Node bridge with generation-scoped buffering/UTF-8/event dispatch and focused protocol plus real helper-PTY tests. 3. Document the approved Windows DLL loading difference, then run focused checks and record runtime/platform limits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Focused Windows kill repair: duplicated the PTY child process handle before waiter ownership, fixed BOOL handling through a narrow Kernel32 adapter, retained portable-pty cloned killer on non-Windows, and verified already-exited state with GetExitCodeProcess. Windows ordinary and backpressure kill/exit/reap acceptance tests pass. The separate headless DSR startup response remains pending; do not mark TASK-38 Done.

Windows startup handshake: Rust PTY reader now recognizes and suppresses only an exact leading ESC[6n on Windows, sends ESC[1;1R through the writer before queued user input, and preserves other bytes including later DSR. This handshake change is pending focused validation.

Updated the real Windows bridge test to rely on the service startup reply and to assert later app DSR is delivered.

Extended the PTY helper to emit an application-originated DSR query on command, with explicit test response round-trip.

Added the Windows ConPTY inherited-cursor startup contract, Windows-only filtering policy, and current test scope to compatibility docs.

The first bridge run reached READY without a startup responder and suppressed ESC[6n. An added app-DSR integration assertion was invalid in cooked ConPTY mode because Windows handles that query; removed it. Pure Rust filter tests cover later application-query forwarding at the reader boundary.

Restored the helper fixture to its original input behavior after removing the cooked-mode-only DSR probe.

Documented that later application-query byte preservation is asserted at the Rust reader filter boundary, since cooked Windows ConPTY handles its own app DSR behavior.

Recorded failed app-DSR integration probe precisely: helper wrote APP_QUERY:\\x1b[6n\\n in cooked ConPTY mode; captured output was APP_QUERY:\\r\\n^[[5;11R, with original DSR consumed by ConPTY and its response line-buffered from the helper. This did not implicate the Rust filter. Added direct writer-order unit coverage for startup reply before queued input.

Clarification: the preceding doubled backslashes are only textual escaping. The helper output literal was APP_QUERY:\x1b[6n\n; captured cooked-ConPTY output was APP_QUERY:\r\n^[[5;11R. ConPTY consumed the query before the Rust service reader could observe it.

Review repairs: defer unexpected Node service-exit handling until readline closes, after all complete frames are consumed; add protocol and real PTY final split-UTF-8 ordering tests. Roll back spawned child when killer clone, reader clone, or writer setup fails; Windows rollback calls TerminateProcess on the still-owned original process handle, confirms prior exit after a failed termination call, and only waits once termination or exit is confirmed to avoid an unbounded wait after uncertain termination. Focused Windows debug and release PTY bridge suites pass; 92 Rust tests pass; Linux-target compile check passes with existing procs.rs unused-import warning. Clippy remains unavailable per prior stage.

Added a focused independence check: an ordinary backend one-shot remains active while the dedicated PTY accepts a 1 MiB write, resize, and kill within the responsiveness bound; test passes on Windows debug and release binaries.

Final verification: pnpm test passed (686 tests, 684 passed, 2 skipped, 0 failed); task-specific Rust, bridge, release, Linux compile, formatting and lint checks were already recorded as passing in the implementation/review records. The startup DSR handshake follow-up and final-frame close-order review repairs are included in this completed scope.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the dedicated Rust PTY service, Node bridge, helper tests, startup handshake, shutdown ordering and compatibility documentation. Verified with pnpm test (686 tests: 684 passed, 2 skipped, 0 failed), plus focused Rust and bridge checks, release build, Linux-target compile check, formatting, lint and diff checks.
<!-- SECTION:FINAL_SUMMARY:END -->
