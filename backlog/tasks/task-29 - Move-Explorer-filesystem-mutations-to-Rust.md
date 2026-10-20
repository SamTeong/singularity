---
id: TASK-29
title: Move Explorer filesystem mutations to Rust
status: Done
assignee: []
created_date: '2026-10-20 09:01'
updated_date: '2026-10-20 09:20'
labels: []
dependencies: []
modified_files:
  - server/explorer.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/explorer_fs.rs
  - server/explorer.test.mjs
  - server/rust-backend.test.mjs
type: enhancement
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Explorer currently performs arbitrary absolute-path write, create, delete, and rename operations in Node. Execute the final filesystem mutations through the queued Rust backend while preserving the existing route contracts, Node-side backup and parent-creation ordering, path acceptance, and precheck semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All four Explorer filesystem mutations execute in Rust through the existing shared queue.
- [x] #2 Existing absolute-path validation, error precedence, side-effect ordering, route status/body contracts, and write freshness behavior remain compatible.
- [x] #3 Tests cover isolated file and directory mutations, errors, stale/forced writes, and symlink cases including target preservation where supported.
- [x] #4 Rust formatting, Rust tests, release build, focused bridge and Explorer tests, lint, and full Node tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add Rust bridge methods and queued Rust filesystem operations with final write mtime guard. 2. Route Explorer write/create/delete/rename mutations through the bridge while retaining Node-side validation, backups, parent creation, and route mappings. 3. Add isolated fixture parity tests and run Rust, bridge, focused Explorer, lint, and full Node checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added isolated backup artifact assertions for successful overwrite, matching-mtime invalid content, initial stale rejection, and queued stale rejection after backup; verified exact prior bytes and unchanged targets.

Final verification: independent review PASS (backup repair, review-explorer-backup-repair.notes.md); 9 VERIFY anchors each matched exactly once; explorer tests 18 passed; Rust suite 63 passed, release build ok; full Node suite 645 passed 2 skipped; lint pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Routed Explorer write/create/delete/rename mutations through the queued Rust backend (new explorer_fs module) with final write mtime guard, preserving Node-side validation, backups, parent creation, and route contracts. Verified by Rust suite 63 pass + release build, full Node suite 645 pass, focused Explorer/bridge tests including backup-artifact coverage, lint, and independent review PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
