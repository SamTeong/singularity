---
id: TASK-23
title: Migrate Memory file writes to the Rust backend
status: Done
assignee: []
created_date: '2026-10-20 07:20'
updated_date: '2026-10-20 07:37'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/memory.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/memory.mjs
  - server/index.mjs
  - server/memory.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Memory file writes still happen in Node while other Memory services can move through the existing private Rust bridge. Move the authorized content mutation to the shared Rust child while preserving persisted Node root authority, the existing HTTP contract, and Memory backups.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 PUT /api/memory/file retains persisted Node root authorization and accepts empty string content.
- [x] #2 Memory writes pass through the shared Rust bridge and Rust performs the final optional mtime check immediately before writing; the 1 ms tolerance and force behavior remain compatible.
- [x] #3 Memory backupFile is awaited before dispatch, and the Node post-backup mtime check remains in place.
- [x] #4 Stale conflicts map to HTTP 409; required-field, application, and bridge transport failures retain HTTP 400; success response shape remains {ok:true,mtime}.
- [x] #5 Rust unit and real-child bridge tests cover write success, conflict, missing parent, empty content, and bridge coercion; Node tests cover root confinement, backups, and HTTP behavior.
- [x] #6 Node and Rust read/list/search/root preference services remain Node-owned, and no Rules backup behavior changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a Rust Memory write operation with an mtime guard immediately before fs::write. 2. Keep path authority, backup, and pre/post-backup conflict checks in Node, then use the shared Rust backend. 3. Preserve the existing /api/memory/file response and status mapping. 4. Add meaningful Node, HTTP, bridge, and Rust tests. 5. Run focused tests, rustfmt, Rust tests and release build, lint, full Node suite, and diff check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Groma backlog guide: source ownership is unmapped because the architecture is at its first scan; no Groma owner reference was invented. Track all owned source paths in Modified files and leave architecture files untouched per user direction.

Implementation: Node retains persisted-root path guard, pre/post-backup mtime checks, and awaited best-effort backup; the shared Rust bridge performs the final mtime guard and synchronous UTF-8 write. Transport exceptions log details and retain Memory's HTTP 400 mapping. Final-guard coverage is through the real child without a forced queue wait; no safe queue-blocking injection exists in the current bridge. Verification: focused Node tests 25/25, Cargo tests 46/46, release build passed, cargo fmt --check passed, pnpm lint passed, full pnpm test 630/630, git diff --check passed. Initial focused Node run used the stale release child and failed; after release build it passed.

Reviewer repair: Rust Memory mtime conversion now returns signed milliseconds for both sides of UNIX_EPOCH; pure unit tests cover -1500 ms and +2750 ms. Real filesystem pre-epoch coverage is capability-limited here: Rust File::set_times returned PermissionDenied (OS error 5) in the first attempt, and the real-child Node test reports an explicit skip because Windows utimes did not retain the requested value (observed mtimeMs 3979348096000). Direct conversion evidence passes. Same issue confirmed but left unchanged in rust/backend/src/skills.rs:227-231 and rust/backend/src/rules.rs:194-205; these are separate domains.

Finalization evidence: reviewer PASS after the signed pre-epoch repair; Rust tests 48/48, focused Node tests 25 passed / 1 skipped, rustfmt, release build, and diff check passed after repair. Earlier full Node suite 630/630 and lint passed before the Rust-only repair. Windows filesystem did not retain a negative mtime, so real-child pre-epoch integration skipped; pure signed conversion tests passed. Forced queue-delay coverage was not run.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Memory content writes through the shared Rust child while retaining Node path authorization, awaited backup, HTTP mappings, and Node-owned read/list/search/root preference. Verified with Rust 48/48, focused Node 25 passed / 1 skipped, release build, rustfmt, diff check, and earlier full Node 630/630 plus lint; reviewer passed. Windows could not retain negative mtimes and forced queue delay was not tested.
<!-- SECTION:FINAL_SUMMARY:END -->
