---
id: TASK-25
title: Move Claude Config writes to Rust
status: Done
assignee: []
created_date: '2026-10-20 07:48'
updated_date: '2026-10-20 08:00'
labels: []
dependencies: []
modified_files:
  - server/config.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/config_write.rs
  - server/config.test.mjs
  - server/rust-backend.test.mjs
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude Config saves currently use Node for both policy checks and the final filesystem write. Keep Node responsible for scope and configured-root authority, parsing, backups, directory creation, and response behavior while moving only the final UTF-8 write and last mtime guard into the existing Rust backend.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Project and local Config writes pass Node scope, configured-root, and JSON checks before reaching the backend; user scope, invalid roots, and invalid JSON never write.
- [x] #2 A first project or local write creates the .claude parent in Node, and an existing config is backed up before the backend replaces it.
- [x] #3 Stale mtimes are rejected before backup when detected by Node and rechecked by Rust immediately before writing; force overrides the stale check.
- [x] #4 Successful writes return {ok:true,backup,path,mtime}, with existing 409 conflict and generic 400 failure mapping preserved.
- [x] #5 The Rust write operation writes UTF-8 bytes, does not create parents, and preserves target bytes when its mtime guard rejects a write.
- [x] #6 Bridge and Node tests cover mtime/force coercion, backup bytes/order, policy rejection, transport failure mapping, and success shape; Rust tests cover signed mtime conversion and native guard behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the Config write bridge while retaining Node policy, parsing, backup, and parent creation. 2. Add Rust final guard and UTF-8 writer with signed mtime handling. 3. Add focused Node and Rust coverage for policy, ordering, coercion, result mapping, and native writes. 4. Run Rust formatting, tests, and release build, then focused Node tests, lint, full pnpm tests, and diff checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Groma first scan curation was declined earlier in this conversation; leave architecture files unchanged. Assigned scope is limited to the Claude Config writer paths.

Validation: cargo test 53 passed; cargo build --release and cargo fmt -- --check passed. Focused Node: 25 passed, 2 skipped; full pnpm test: 635 passed, 2 skipped; pnpm lint passed. Two pre-epoch bridge cases skipped because Windows filesystem did not preserve the requested 1960 mtime; Rust signed conversion unit test passed. Logs: C:/Users/sate/.agents/.plan/01a15847-6e63-74a0-aeb3-71e6fc5e28ce/config-node-focused.log; C:/Users/sate/.agents/.plan/01a15847-6e63-74a0-aeb3-71e6fc5e28ce/config-pnpm-test.log; C:/Users/sate/.agents/.plan/01a15847-6e63-74a0-aeb3-71e6fc5e28ce/config-lint.log.

Final review: independent review found no blockers and verified the six acceptance criteria; all nine change anchors occurred exactly once. Validation retained: Rust 53 passed, focused Node 25 passed with 2 Windows pre-epoch mtime skips, full pnpm 635 passed with 2 skips, lint and diff check passed. The signed conversion is covered by Rust unit tests; no live HTTP probe was run per scope.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Claude Config final UTF-8 writes and the last signed mtime guard into the existing Rust backend while retaining Node authorization, JSON validation, backup sequencing, parent creation, and API error mapping. Independent review found no blockers. Verified with Rust tests/build/format, focused Node tests, lint, full pnpm tests, and diff check; two pre-epoch bridge cases skip on this Windows filesystem.
<!-- SECTION:FINAL_SUMMARY:END -->
