---
id: TASK-36
title: Move task and shared Git subprocesses to Rust
status: Done
assignee: []
created_date: '2026-10-20 12:52'
updated_date: '2026-10-20 13:27'
labels: []
dependencies: []
modified_files:
  - server/tasks.mjs
  - rust/backend/src/oneshot.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/index.mjs
  - server/tasks.test.mjs
  - server/projects.test.mjs
  - server/project-review.test.mjs
  - server/git-process-fixture.mjs
  - server/rust-backend.test.mjs
  - rust/backend/src/detached.rs
type: task
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Task and shared project services still start Git through Node child-process helpers. Moving child execution into the Rust backend keeps the existing Git behavior and error details while retaining Node as the authority for task state and worktree policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns all task and shared Git child-process execution.
- [x] #2 Git argv, noninteractive environment, timeout, UTF-8 trimmed stdout, stderr handling, stream caps, and error metadata preserve the existing Node contract.
- [x] #3 Synchronous gitSync is removed and all direct consumers await the Rust-backed operation.
- [x] #4 Rust backend readiness completes before asynchronous task recovery and listener startup.
- [x] #5 Focused tests cover real Rust subprocess success, errors, spawn failure, timeout, stdin, output caps, argv, and environment.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect current Git wrappers and bounded direct callers; record project architecture references. 2. Add a Git-specific Rust process operation and Node bridge mode preserving argv, stdin, environment, timeout, output caps, and error causes. 3. Remove synchronous Git usage and await its direct consumers while preserving Node readiness ordering. 4. Add focused behavior tests and run Rust plus relevant Node checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the Rust Git process operation and async task callers. Verification on Windows: cargo fmt -- --check; cargo test (83 passed); cargo build --release; focused Node task/project/review/Rust backend tests (84 passed, 2 skipped); ESLint clean. Groma returned no owning architecture element IDs for the touched sources.

Review repair: Git cap termination now reports killed/SIGKILL; spawn failures carry Rust error kind/raw OS code and map to Node-compatible codes; Unix exit signals are serialized. Added cap metadata and non-ENOENT directory-spawn assertions. Windows Rust tests 83 passed, release build passed, focused Node 84 passed/2 skipped, ESLint and diff check passed; Linux target cargo check passed with existing procs.rs unused-import warning. Still In Progress pending independent review.

Final rerun after restricting metadata fields to Git mode: Rust test command had 82 passed / 1 failed on existing detached spawn timing assertion (spawn_returns_before_child_exits exceeded 300 ms); no retry. Release build, focused Node 84 passed/2 skipped, ESLint, diff check, and Linux compile check passed.

Detached test repair: replaced the 300 ms spawn latency assertion and fixed child delay with ready/release/completion markers; parent Drop guard releases the child on assertion failure, and both child and parent waits have deadlines. Groma reports no owning architecture element for rust/backend/src/detached.rs.

Review follow-up: replaced hard-coded Unix signal numbers with libc target constants; cfg Unix unit test covers SIGBUS and SIGUSR1 names. Windows formatting check and diff check passed. Linux compile/release checks pending final worker Cargo test to avoid competing build output.

Final signal mapping follow-up: switched to libc signal constants with Linux/Android-only SIGSTKFLT and SIGPWR; Unix tests assert SIGBUS/SIGUSR1 and Linux-specific names. fmt, Linux cargo check --tests, Windows release build passed; parent reports final Rust suite 83 passed after detached fixture repair. No macOS runtime claim.

Signal mapper coverage completed for known Linux/Android and macOS standard names using libc constants: Linux/Android SIGSTKFLT/SIGPWR and macOS SIGEMT/SIGINFO have target cfg tests. Latest fmt, Linux cargo check --tests, Windows release build, and diff checks passed; macOS target is not installed, so no macOS compile/runtime claim.

Final verification: pnpm test passed (676 total, 674 passed, 2 skipped, 0 failed); final Rust test after detached fixture repair passed 83/83; prior focused Rust Git tests, Node tests, format, release build, Linux compile check, ESLint, and diff check passed as recorded above. All 16 implementation VERIFY anchors and the detached fixture VERIFY anchor occur exactly once. macOS compile/runtime remains unverified; no Apple runtime claim.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved task and shared Git subprocess execution into Rust while retaining Node task/worktree policy and error contract. Verified with Rust and focused Node suites, full pnpm test (674 passed, 2 skipped), lint, formatting, release build, Linux target compile check, and diff check.
<!-- SECTION:FINAL_SUMMARY:END -->
