---
id: TASK-42.5
title: Move Codex thread identity lookup to Rust
status: Done
assignee: []
created_date: '2026-10-21 05:44'
updated_date: '2026-10-21 23:36'
labels: []
dependencies:
  - TASK-42.4
modified_files:
  - rust/backend/src/codex_thread_identity.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/codex-thread.mjs
  - server/agents.mjs
  - server/index.mjs
  - server/pty-ws.mjs
  - server/codex-thread.test.mjs
  - server/agents.test.mjs
  - rust/backend/Cargo.toml
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent spawn, resume, restoration, and registry mapping use Codex rollout identity helpers distinct from transcript list/read/search. Once the transcript data service boundary is established, move findCodexThread and codexThreadExists behind Rust while preserving their current callers and eligibility rules. This task covers identity lookup only; it does not migrate agent lifecycle or policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Spawn-time discovery reads only eligible active Codex session rollouts, parses the first-line session metadata contract, matches normalized cwd and user thread source, excludes archived rollouts, and selects the latest eligible start timestamp subject to the existing spawnedAt tolerance.
- [x] #2 Existing-thread validation confirms the requested thread UUID and normalized cwd against an eligible user thread, preserves current archived-session exclusion and does not add spawn-time filtering to this existence check.
- [x] #3 Missing CODEX_HOME, malformed/missing first-line metadata, mismatched cwd, subagent threads, stale sessions, duplicate matching rollouts, and path separator/case normalization have meaningful Rust parity fixtures and existing Node caller tests.
- [x] #4 agents.mjs spawn/resume/restoration and registry lookup call contracts remain behaviorally compatible; tests exercise those existing contracts without migrating agent lifecycle or changing policy.
- [x] #5 Implementation and focused runtime checks preserve current identity traversal/read bounds and pass on Windows; Linux/macOS runtime validation stays in TASK-42.2.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement Rust Codex identity find/exists operations with explicit CODEX_HOME and parity bounds. 2. Add bridge adapter and await identity through existing agent callers, preserving pin-before-kill respawn behavior. 3. Add focused Rust and Node parity/regression coverage; run focused checks and isolated release build.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finalization: root accepted the review-only verification finding using the post-fix Rust 155+3, Node 701 (699 passed, 2 skipped), release build, fmt, and lint evidence in the implementation receipt.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Codex identity discovery and existing-thread validation behind Rust with explicit CODEX_HOME, preserving caller behavior and rollout eligibility. Verified with focused Rust 5/5, full Rust 158 tests, focused Node 56/56, package Node 701 total (699 passed, 2 skipped), release build, cargo fmt --check, and lint; all recorded native exit files are 0.
<!-- SECTION:FINAL_SUMMARY:END -->
