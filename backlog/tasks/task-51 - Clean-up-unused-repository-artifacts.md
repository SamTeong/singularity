---
id: TASK-51
title: Clean up unused repository artifacts
status: Done
assignee: []
created_date: '2026-10-25 01:34'
updated_date: '2026-10-25 01:36'
labels: []
dependencies: []
modified_files:
  - .worktrees/feat-rust-read-services/.gitignore
type: chore
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository hygiene is needed to remove confirmed regenerable Cargo caches from the root checkout and prevent a custom Cargo target directory from appearing as untracked work in the feature checkout. Keep this separate from TASK-42.23 and preserve the feature checkout's live backend and unknown-ownership sysstats target.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The feature checkout ignores only its root-level /sysstats-target/ path.
- [x] #2 Only the two approved root Cargo cache directories are removed after fresh safety guards; all protected user, task, source, live process, and plan artifacts remain.
- [x] #3 The cleanup task stays separate from TASK-42.23 and records its changed file paths through Backlog CLI.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify the root Cargo target candidates resolve exactly to the approved paths, are not reparse points or tracked, contain Cargo cache markers, and have no active executable or build writer using them. 2. Add only /sysstats-target/ to the feature checkout .gitignore and immediately record that path through Backlog CLI. 3. Delete each approved root cache only after a fresh process-path and active-writer check; verify absence, unchanged protected process identities, ignore coverage, and unchanged feature source paths. 4. Read task-finalization guidance, verify acceptance criteria, and mark Done if all are met.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verified both allowlisted root caches absent after guards. Feature git diff contains only /sysstats-target/ at line 25; git check-ignore reports .gitignore:25. Feature sysstats-target, feature backend target, and both plan-local target directories remain present. Backend PIDs 73972 and 56416 still run from the protected feature target. Feature HEAD remains 8d419c70535683950be3375d5624c33c679a86ee. Feature source/task/note paths from the initial inventory are preserved; only the intended ignore rule was added. No tests/build run (cleanup-only task; no tests requested).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed only the guarded root Cargo caches rust/backend/target and sysstats-target. Added /sysstats-target/ to the feature checkout ignore rules and recorded .worktrees/feat-rust-read-services/.gitignore as this separate task's modified file. Verified both cache paths absent, ignore coverage active, feature and plan artifacts preserved, backend PIDs unchanged, and feature HEAD still 8d419c70535683950be3375d5624c33c679a86ee. No tests/build run.
<!-- SECTION:FINAL_SUMMARY:END -->
