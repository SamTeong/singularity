---
id: TASK-30
title: Move one-shot CLI prompts to Rust
status: Done
assignee: []
created_date: '2026-10-20 09:38'
updated_date: '2026-10-20 09:56'
labels: []
dependencies: []
type: enhancement
ordinal: 30000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 runOneShotPrompt executes claude/codex/ollama prompts through the queued Rust backend.
- [x] #2 Existing stdout JSON/text parsing, stdin end, windowsHide, and timeout semantics remain compatible for both callers (history.mjs, window-anchor.mjs).
- [x] #3 Focused tests cover claude/codex/ollama branches, timeouts, and caller parsing.
- [x] #4 Rust fmt, Rust tests, release build, focused Node tests, lint, and full Node tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add Rust Command-based one-shot prompt op with timeout and windows-hide; bridge from server/one-shot.mjs; keep Node-side env/argv building and caller contracts; add tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation: rust/backend/src/oneshot.rs (std::process::Command, stdin-null, CREATE_NO_WINDOW, deadline kill, 8MB cap) + dispatch 'oneshot' in main.rs/lib.rs; server/rust-backend.mjs oneShot() bridge (execFile-shaped errors with stdout/code/killed); server/one-shot.mjs oneShotSpawn default executor + setOneShotBackend; window-anchor default spawn routes through it; index.mjs wires setOneShotBackend(rustBackend). Tests: server/one-shot.test.mjs (7 tests), rust-backend.test.mjs bridge integration, 4 cargo tests. cargo fmt+test (67 pass), release build, focused node tests 57 pass, lint clean; full suite running.

Final verification: impl review PASS, wait-bound repair review PASS (review-oneshot.notes.md, review-oneshot-repair.notes.md); 10 VERIFY anchors exact-count-1; cargo test --release 68 pass; release exe rebuilt via scripts/build-rust-backend.mjs; full node 657 pass 2 unrelated skips; lint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Routed one-shot CLI prompts (claude/codex/ollama) through the queued Rust backend via new oneshot.rs op and rust-backend oneShot bridge, preserving caller stdout parsing, stdin-end, windowsHide, and timeout semantics (history.mjs, window-anchor.mjs). Post-EOF child wait bounded by the same deadline after review finding. Verified by cargo --release 68 pass + rebuilt release exe, focused one-shot/bridge tests, full Node 657 pass, lint, and two independent review PASSes.
<!-- SECTION:FINAL_SUMMARY:END -->
