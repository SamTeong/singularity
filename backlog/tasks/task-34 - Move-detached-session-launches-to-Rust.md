---
id: TASK-34
title: Move detached session launches to Rust
status: Done
assignee:
  - '@sate'
created_date: '2026-10-20 12:08'
updated_date: '2026-10-20 12:26'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/detached.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/detached-launch.mjs
  - server/index.mjs
  - server/detached-launch.test.mjs
  - server/detached-child-fixture.mjs
  - server/rust-backend.test.mjs
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External terminal and session-folder launch routes still spawn their launcher processes directly in Node. Add a Rust spawn-and-return bridge for these detached children while leaving launcher construction and daemon restart ownership in Node.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust detached spawn returns after OS process creation, redirects all standard streams to null, applies optional cwd, and separates the child session/process group using supported platform behavior.
- [x] #2 External-terminal launch preserves the registry row when spawn fails and removes it only after spawn succeeds; existing response shape and error mapping remain.
- [x] #3 Session-folder launch remains Windows-only, waits for process-creation success/error, uses stable failure text, and inherits cwd.
- [x] #4 Synthetic-child tests cover immediate return, spawn failure, argv/cwd/environment, and detached lifecycle where feasible; no GUI launcher is invoked.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect launcher routes and Rust bridge patterns; record architecture links before source edits. 2. Add Rust detached spawn operation, Node bridge method, and route wiring/tests while retaining daemon restart in Node. 3. Format and run focused Rust, Node, lint, and build checks without restarting live services.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added detached process spawn module with null stdio, platform session setup, child reaping thread, and synthetic child tests. Groma has no enabled owner for these Rust source paths.

Registered detached spawn module in Rust library.

Added detached_spawn JSON request dispatch with optional cwd.

Added spawnDetached bridge method with typed {ok:true} success and rejected spawn errors.

Added injectable HTTP handlers for external handoff and Windows session-folder opening to enable route-order tests without GUI launches.

Wired the two user-facing launch routes to the detached Rust bridge handlers; retained the Node spawn import and /restart implementation.

Added HTTP handler tests for spawn acceptance ordering, failure retention, Windows-only behavior, inherited cwd, and stable explorer failure response. Tests use synthetic bridge methods and no GUI launchers.

Added a synthetic Node child fixture for end-to-end bridge testing of argv, cwd, inherited environment, and immediate return.

Added real bridge coverage for synthetic child completion after delayed marker write and Rust spawn-failure mapping.

cargo fmt applied to detached.rs after the initial --check reported formatting differences.

Configured std::io only on Unix after Windows-target test reported an unused import.

Adjusted route tests to await the synthetic spawn attempt and compare the platform-normalized Windows executable path after the first run exposed timing/path assumptions.

The first end-to-end bridge test failed because Rust starts with a restricted environment; forwarding Node process.env in detached_spawn is required to preserve Node detached-child inheritance.

Detached spawn now applies an explicitly forwarded environment map when provided, preserving the original Node child environment despite the Rust backend startup environment filter.

Forwarded the detached_spawn request environment into the Rust process operation.

spawnDetached now sends Node process.env by default; its optional fourth argument allows explicit overrides in tests/callers.

Removed the now-unused path.resolve import after pnpm lint caught it.

Strengthened bridge test to stop the Rust backend immediately after spawn and then verify the detached fixture still completes; spawn-failure mapping uses a separate backend instance.

Final verification: pnpm test passed (672 passed, 0 failed, 2 skipped; detached-final-full-test.log). Review passed with all 10 VERIFY anchors matching exactly once. git diff --check passed. No GUI launcher or live service restart was used.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved external-terminal and session-folder detached launches to the Rust spawn-and-return bridge while keeping launcher construction and daemon restart in Node. Verified with focused Rust, bridge, route, lint, release-build, and final full-suite checks (672 passed, 0 failed, 2 skipped); independent review passed.
<!-- SECTION:FINAL_SUMMARY:END -->
