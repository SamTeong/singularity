---
id: TASK-21
title: Migrate Skills file writes to the Rust backend
status: Done
assignee: []
created_date: '2026-10-20 06:09'
updated_date: '2026-10-20 06:27'
labels: []
dependencies: []
modified_files:
  - server/skills.mjs
  - server/skills.test.mjs
  - server/rust-backend.mjs
  - server/index.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/skills.rs
type: feature
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Skills listing and reads already use the private Rust bridge, but SKILL.md and supporting text-file mutations still run in Node. Move the actual content writes behind the bridge while keeping Node's existing root fallback, validation, path derivation, and backup behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Both SKILL.md and supporting text-file writes perform actual filesystem mutation in Rust through the private bridge; HTTP result shapes and 400/409 behavior remain compatible.
- [x] #2 Node retains explicit-root/default-root semantics, NAME_RE validation, flat and grouped path derivation, supporting-segment validation, and image-file rejection.
- [x] #3 Existing Node backup location, prior-byte contents, best-effort failure behavior, backup-before-write order, pre/post-backup mtime checks, 1 ms tolerance, and JavaScript force/mtime coercion remain; Rust rechecks after bridge queue wait unless force or mtime is absent.
- [x] #4 Empty and Unicode string content round-trips as UTF-8; writes do not create missing parent directories and return compatible mtime metadata.
- [x] #5 Rust unit tests and real-child Skills tests cover successful writes, backup behavior, stale conflicts without mutation, force, optional mtime, invalid paths/names/image files, and queued final conflict behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a shared Rust Skills write operation with the queued final mtime guard and compatible result shape. 2. Add the private bridge method and delegate both Node writers after existing validation and backup checks. 3. Extend real-child and Rust tests for content, paths, backup ordering, conflicts, force, and rejection behavior. 4. Run Rust formatting/tests/release build, focused Skills tests, lint, full Node tests, and diff checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delegated both validated writers through shared writeSkillContent; Node retains backup ordering and both mtime checks, while backend transport rejection now has a distinct sentinel for HTTP 500 mapping.

Added the skill_write dispatch arm using the existing generic path/content/mtime/force request fields, with JavaScript-compatible boolean decoding after bridge normalization.

Rust skill_write now performs the post-queue optional mtime check at a 1 ms threshold, writes UTF-8 bytes synchronously without creating directories, and returns compatible mtime metadata.

Added a private skillWrite bridge method that preserves JavaScript Number conversion for non-null mtime and truthiness for force at the protocol boundary.

Added a testable Skills write handler that preserves 400 application errors and 409 stale conflicts while mapping child transport failures to the established generic 500 response.

The /skill route now uses the tested handler factory; returned application errors keep 400/409, while private bridge transport failures map to 500.

Added Rust unit coverage for UTF-8, empty content, mtime conflict/force, and no parent creation; real-child JS test expansion is next.

Added real Rust child coverage for empty/Unicode SKILL.md and supporting writes, prior-byte backups, flat paths, missing-parent behavior, optional mtime, final conflict guard, coercion, and HTTP 400/409/500 mapping.

Lint initially flagged one unused local in the new optional-mtime case; removed it. Re-running required checks against final source.

Backup regression check now snapshots only each fixture-derived source hash directory and requires a newly created .bak with unique prior bytes for both SKILL.md and supporting-file writes; unrelated persistent backup artifacts cannot satisfy it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Skills file content writes into the Rust child through the private bridge while preserving Node validation, backups, mtime conflicts, and HTTP responses. Verified with focused Skills tests (29 passed), full Node suite (622 passed), full Rust suite (39 passed), pnpm lint, cargo fmt check, release build, and git diff --check.
<!-- SECTION:FINAL_SUMMARY:END -->
