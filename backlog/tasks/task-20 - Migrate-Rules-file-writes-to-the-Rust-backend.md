---
id: TASK-20
title: Migrate Rules file writes to the Rust backend
status: Done
assignee: []
created_date: '2026-10-20 05:48'
updated_date: '2026-10-20 06:14'
labels: []
dependencies: []
modified_files:
  - server/rules.mjs
  - server/rust-backend.mjs
  - server/index.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/rules.rs
  - server/rules.test.mjs
  - server/rust-backend.test.mjs
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rules file writes still run in Node while the other Rules file services use the Rust backend. Move authorized file mutation behind the existing private stdio bridge while keeping the public gateway and persisted rule-root authority in Node, preserving empty-content and mtime behavior, and removing Rules backups as selected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 PUT /api/rules/file keeps persisted Node root authorization and allows empty string content.
- [x] #2 Rust writes UTF-8 content through the private bridge and returns compatible mtime metadata; optional mtime, 1 ms tolerance, and force behavior are preserved.
- [x] #3 Stale conflicts map to 409, application failures to 400, and bridge transport failures to 500.
- [x] #4 Successful Rules writes create no backup; rejected paths and stale conflicts do not mutate target content.
- [x] #5 Rust unit and real-child bridge tests cover write success and the key error/mtime paths.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add Rust Rules write operation with authoritative optional mtime/force checks. 2. Route authorized Node writes through the private bridge and preserve HTTP error mapping. 3. Add Rust, handler, and real-child parity coverage. 4. Run lint, Node tests, Rust tests, formatting, and release build; record any unavailable checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added Rules handler tests for empty-content pass-through, persisted-root rejection, conflict/transport status mapping, and a real-child bridge write test for UTF-8, mtime accuracy, 1ms tolerance, stale conflict without mutation, force, omitted mtime, and missing parent.

Reviewer fixes: Rules bridge now applies JavaScript Number coercion to non-null mtime and JavaScript truthiness to force only for rules_write; real-child coverage includes returned-mtime reuse, stale numeric-string mtime without mutation, truthy string force, and invalid numeric mtime disabling the guard.

Protocol compatibility fix keeps the generic Rust request force field as JSON Value, so rules-only truthiness normalization does not tighten deserialization for other operations. The Rules writer also rejects non-string content before fs::write; source inspection confirms it cannot become empty content and truncate the destination.

Final review PASS. Focused real-child tests: 19 passed; Rust unit tests: 38 passed; cargo fmt check, release build, pnpm lint, pnpm test (620 passed), and git diff --check passed. Full Node suite preceded the final generic force-field adjustment; focused bridge and Rust tests were rerun afterward. Acceptance criterion 4's stale/rejected no-mutation behavior is covered, but the successful-write backup-directory absence was verified by source inspection only; no direct artifact assertion exists. Groma task-link guide found no established Skills/Rules owner reference to add; no architecture scan/curation was performed.

Follow-up verification added a real-child Node Rules overwrite assertion: after writing prior bytes to a unique configured rule path, successful writeRuleFile leaves its unique hash directory absent under isolated BACKUPS_DIR. Targeted test run pending.

Verified AC4 with targeted real-child test: isolated SINGULARITY_HOME and BACKUPS_DIR, overwrote existing Rules file through Rust bridge, and asserted the path-specific backup artifact directory was absent; node test passed 1/1.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated Rules file writes through the private Rust bridge while retaining Node authorization and compatibility behavior. Reviewed PASS; focused bridge tests (19), Rust tests (38), lint, format, release build, full Node suite (620), and diff check passed. No live daemon was restarted or probed.

Migrated Rules content writes to the Rust backend while preserving Node validation, backup semantics, and conflict behavior. Rust tests passed 38; focused Node tests passed 19; lint and full Node suite passed 620; targeted real-child no-backup artifact check passed 1/1.
<!-- SECTION:FINAL_SUMMARY:END -->
