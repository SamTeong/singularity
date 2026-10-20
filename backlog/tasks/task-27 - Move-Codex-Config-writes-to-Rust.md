---
id: TASK-27
title: Move Codex Config writes to Rust
status: Done
assignee: []
created_date: '2026-10-20 08:34'
updated_date: '2026-10-20 08:44'
labels: []
dependencies: []
modified_files:
  - server/codex-config.mjs
  - server/rust-backend.mjs
  - server/index.mjs
  - rust/backend/src/codex_config_write.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/codex-config.test.mjs
  - server/rust-backend.test.mjs
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Codex config editor currently performs file writes in Node while sibling config writers use the native backend. Keep authorization, TOML validation, backups, and parent creation in Node while moving the final write and stale-file guard into Rust.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Codex config writes retain root/scope authorization, server-derived paths, TOML validation, backup behavior, and response shape.
- [x] #2 Native writes enforce the final mtime guard and do not create parent directories.
- [x] #3 Tests cover bridge UTF-8 writes, empty content, coercions, stale/force behavior, missing parents, and helper ordering.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add the Rust codex_config_write operation and JS bridge method; inject it into the Codex config writer while preserving validation and backup ordering. Add helper and bridge coverage, then run the prescribed validation sequence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Independent review passed with no blockers. Reviewer verified Node validation/backup order, native final stale guard and response mapping, and all 9 verification anchors. Limits: no actual-index HTTP test or live daemon/Vite probe; the route validation/status mapping is unchanged and helper plus real bridge tests passed. The two Windows pre-epoch filesystem tests remain skipped. Verification recorded in the implementation receipt: 58 Rust passed; focused Node 32 passed plus 2 skips; release build, lint, full pnpm test (642 passed, 2 skipped), and diff check passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Codex Config file writes and the final mtime guard to the Rust backend while keeping path authorization, TOML parsing, backups, and parent creation in Node. Verified with cargo tests (58 passed), focused Node tests (32 passed, 2 existing skips), release build, pnpm lint, and pnpm test (642 passed, 2 skipped); independent review passed.
<!-- SECTION:FINAL_SUMMARY:END -->
