---
id: TASK-42.21
title: Move guarded process kill policy to Rust
status: Done
assignee: []
created_date: '2026-10-24 12:34'
updated_date: '2026-10-24 13:42'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/procs_guard.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/procs.mjs
  - server/procs.test.mjs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - backlog/tasks/task-42.21 - Move-guarded-process-kill-policy-to-Rust.md
parent_task_id: TASK-42
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The process API currently keeps daemon denial and the Windows PID-reuse re-query in Node, separate from the Rust kill primitive. Move that guard into a focused Rust operation while Node retains scan authorization, request validation, and post-scan registry sampling.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The existing kill route continues to validate integer PIDs and authorize only the first matching classified scan row; no-row requests do not call the guarded operation.
- [x] #2 The Rust guard denies daemon rows before query or kill, preserves the exact Windows CIM command and one-shot defaults, and permits the existing kill only for trimmed True; Darwin skips the query.
- [x] #3 Spawn, nonzero-exit, timeout, changed-process, and kill-result behavior retain current public error/result semantics through deterministic injected test seams.
- [x] #4 Node bridge and Rust tests cover operation fields, ordering, guard decisions, query failures, Darwin behavior, and kill result without live process queries or kills.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the typed guarded operation to the Node bridge and Rust JSON-lines dispatch. 2. Move daemon denial, Windows name/PID re-query, exact True gate, and existing Rust kill invocation into a testable Rust guard module. 3. Retain Node scan authorization and route it through the guarded bridge; add deterministic bridge and guard tests. 4. Run native rustfmt check and permitted Node syntax checks; validation owner runs tests and builds.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Validated from machine-populated receipt run-20261024T133055858Z; receipt SHA-256 independently matched Get-FileHash. All nine ordered checks exited 0 with cleanup complete; 316 frozen inputs and before/after source maps match. All seven task source files match both frozen maps. HEAD matched the receipt expected/actual/post-run value; built binary matched build and after-check hashes. Rust tests: 253 + 3 passed. Full Node: 733 passed, 0 failed, 2 skipped. Focused Node: 45 passed, 0 failed, 2 skipped. Guard retains exact ECMAScript trim set (CR/LF/BOM included; NEL and U+180E excluded), first-row authorization and scan-then-registry sampling order, host PID, query defaults, and error/result behavior. Node remains composition owner; its temporary/full-rewrite story is incomplete. No definition-of-done items are defined.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved guarded process-kill policy into Rust while preserving Node scan authorization and route behavior. Verified by the receipt-bound full validation run: all nine checks passed with cleanup complete, 253 + 3 Rust tests and 733 Node tests passed (2 skipped), frozen inputs and built binary matched. Node composition remains temporary pending full rewrite.
<!-- SECTION:FINAL_SUMMARY:END -->
