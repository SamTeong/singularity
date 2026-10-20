---
id: TASK-37
title: Move window-anchor persistence to Rust
status: Done
assignee: []
created_date: '2026-10-20 13:31'
updated_date: '2026-10-20 13:57'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/window_anchor.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/window-anchor.mjs
  - server/index.mjs
  - server/window-anchor.test.mjs
  - server/rust-backend.test.mjs
  - backlog/tasks/task-37 - Move-window-anchor-persistence-to-Rust.md
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Window-anchor state and run telemetry currently use Node filesystem helpers while request execution and scheduling already use the Rust bridge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust loads and atomically saves window-anchor state at the exact Node-resolved path; async initialization awaits bridge startup.
- [x] #2 Rust appends telemetry lines with mode 0600 and atomically retains the newest 1,000 records.
- [x] #3 Node preserves state-machine, timer, usage, HTTP/WS, bus, and one-shot ownership; captured persistence and event snapshots remain ordered, and save failures still emit snapshots.
- [x] #4 Focused Rust and Node bridge/window-anchor tests pass, along with release build, lint, rustfmt, and diff checks.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rust stores state and telemetry at exact Node-resolved paths. 2. Async initialization follows bridge startup; serialized Node snapshots preserve state/event ordering. 3. Focused tests and required build, lint, format, and diff checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented Rust window_anchor module load/save/telemetry operations, path-specific bridge calls, async init after Rust start, and captured-state persistence/event queue. Groma view returned no owner for the source/test files; architecture links are unavailable and no Groma files were edited. Focused Rust (3 passed), window-anchor Node (12 passed), configured-path bridge Node (1 passed), release build, eslint, rustfmt, and diff check passed. A first bridge run hit the pre-existing release binary before rebuilding; after release build, the focused bridge check passed. Initial asynchronous persistence test reads were raced and now wait on durable file state.

Final full Rust bridge suite after release rebuild: 24 passed, 2 pre-existing filesystem timestamp skips, 0 failed. Final window-anchor suite: 12 passed; Rust storage unit tests: 3 passed; release build, rustfmt check, focused eslint, and git diff --check passed. All four acceptance criteria are recorded but remain unchecked pending independent review.

Corrected telemetry mode assertion: Unix mode 0600 is verified immediately after the first append creates a new JSONL file. The retention test does not assert mode after atomic trimming; replacement follows legacy Node writeAtomic default umask behavior and preserves file permission parity. No production Rust behavior changed.

Finalizer follow-up: moved the Unix 0600 assertion to the initial append before any trim replacement. The 0600 guarantee is creation-only; atomic trim replacement retains legacy Node writeAtomic default umask behavior, and the test makes no post-trim mode claim. Production Rust is unchanged. Focused Rust tests pass (3/3), rustfmt passes; Linux cargo check --tests was not run because WSL reports cargo: not found.

Final verification: full `pnpm test` passed (676 passed, 2 skipped, 0 failed); full `cargo test --manifest-path rust/backend/Cargo.toml` passed (86 passed, 0 failed); Windows cargo successfully compiled all test code for `x86_64-unknown-linux-gnu` with `cargo check --target x86_64-unknown-linux-gnu --tests` (compile-only, not runtime execution). Previously recorded release build, focused lint, rustfmt, and diff checks passed. Unix 0600 is verified on initial telemetry-file creation; atomic trim replacement preserves legacy Node default-umask behavior and has no post-trim 0600 assertion.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved window-anchor state and telemetry persistence into Rust at Node-resolved paths while retaining Node runtime ownership and ordered snapshot events. Verified with full Node and Rust suites, Linux-target test compilation, and previously recorded release build, lint, rustfmt, and diff checks.
<!-- SECTION:FINAL_SUMMARY:END -->
