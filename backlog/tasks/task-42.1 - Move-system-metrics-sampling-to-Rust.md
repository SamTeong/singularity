---
id: TASK-42.1
title: Move system metrics sampling to Rust
status: Done
assignee: []
created_date: '2026-10-20 23:52'
updated_date: '2026-10-21 05:27'
labels: []
dependencies:
  - TASK-41
modified_files:
  - rust/backend/src/sysstats.rs
  - rust/backend/Cargo.toml
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/Cargo.lock
  - server/rust-backend.mjs
  - server/index.mjs
  - server/sysstats.test.mjs
  - server/sysstats.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The current system metrics service is a compact Node-owned service with a two-second sampler, CPU delta baseline, and bounded one-hour history, exposed through the existing status API. Migrating this service advances domain ownership after the in-progress config-state migration and creates a verified Rust-owned sampler before transport cutover. Keep the existing route and response shape during this slice.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns system metric collection, two-second sampling cadence, CPU delta baseline, and bounded one-hour history while the Node gateway remains temporarily available.
- [x] #2 The existing metrics response shape and polling behavior remain compatible, including first-sample and history edge cases.
- [x] #3 A focused Rust source/API decision is verified before adding any dependency; no crate version is assumed by this task.
- [x] #4 Windows runtime tests cover metric values, sampling cadence, history bounds, startup, and stop behavior.
- [x] #5 Linux and macOS compile/runtime evidence is recorded as follow-up work and is not a Windows acceptance blocker.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the verified sysinfo 0.39.6 API with minimal features and a persistent sampler with bounded aligned history. 2. Expose snapshot via Rust JSON-lines dispatch and route GET /sysstats through the shared bridge. 3. Add focused deterministic and Windows runtime coverage, update stale design/evidence receipts, and run focused checks plus the release build.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-21 Windows verification: isolated release build succeeded; sysstats bridge contract passed against the isolated executable; route delegation check passed; pnpm lint passed; pnpm test passed (684 passed, 6 skipped); full Rust suite passed (102 passed). Rust fmt was already checked successfully and Rust sources were unchanged in this verification lane. Linux/macOS compile/runtime evidence remains a TASK-42.2 follow-up. Live main and feature listeners were preserved.

Correction 2026-10-21: full pnpm test rerun with both SINGULARITY_SYSSTATS_TEST_BINARY and SINGULARITY_RUST_PTY_BINARY set to the isolated sysstats release executable; all four real PTY tests ran. Result: 690 total, 688 passed, 0 failed, 2 skipped. Named skips: Rust Config bridge preserves and checks pre-epoch mtimes; Rust Memory bridge saves pre-epoch files and rejects stale pre-epoch mtimes (Windows filesystem did not retain the requested pre-epoch mtime). See sysstats-pnpm-test-pty-final.log.

Independent review PASS with no blockers. Finalization evidence: corrected full Node suite 690 total, 688 passed, 0 failed, 2 Windows pre-epoch mtime skips; Rust suite 102 passed; focused bridge, lint, fmt, and isolated release build passed. Linux/macOS verification remains explicitly tracked by TASK-42.2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved system metrics sampling and history ownership to the Rust backend, preserving the /sysstats response and Node gateway during this slice. Verified with isolated Windows release build, focused bridge test, lint, corrected full Node suite (690 total, 688 passed, 0 failed, 2 Windows filesystem mtime skips), Rust suite (102 passed), and fmt check. Independent review passed; Linux/macOS evidence is tracked by TASK-42.2.
<!-- SECTION:FINAL_SUMMARY:END -->
