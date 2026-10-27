---
id: TASK-53
title: Fix Windows PTY test teardown race
status: Done
assignee: []
created_date: '2026-10-27 05:21'
updated_date: '2026-10-27 05:35'
labels: []
dependencies: []
modified_files:
  - server/agents.test.mjs
  - .gitignore
type: bug
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Codex transcript liveness test kills its owned PTY without waiting for process exit. On Windows, file-level cleanup can then hit EPERM while the child still holds its working directory. The test already has a killAndWait helper used by other live-PTY tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The liveness test waits for its owned PTY to exit before file teardown removes the scratch directory.
- [x] #2 The isolated liveness test and full server test file pass on Windows, with liveness assertions preserved.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Await killAndWait in the liveness test finally block and remove its misleading teardown comment. 2. Ignore only the root /brag-output/ path. 3. Run the isolated liveness test on Windows.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Updated server/agents.test.mjs to await killAndWait; groma view reports no enabled scanner owns this test file, so no architecture element reference is available.

Added /brag-output/ to the root ignore file. Isolated Windows liveness test passed (1 pass, 0 fail), command exit code 0; log: C:/Users/sate/.agents/.plan/01a17bb5-7fd7-7f21-bd12-8b1807a481ab/windows-liveness-fixed.log.

Root's full Windows pnpm test run stalled and was terminated at its explicit 8-minute deadline. Static evidence in explore-teardown-stall.notes.md confirmed the liveness test was after beginDrain, whose one-way module-global drain state suppresses the status:exited event awaited by killAndWait. Moved the liveness test block before beginDrain so that drain remains last; no tests rerun per dispatch.

Final validation after moving the liveness test before beginDrain: pnpm lint passed (exit 0); full Windows pnpm test passed (623 tests, 623 pass, 0 fail, exit 0); git diff --check passed. The liveness test still awaits killAndWait, all liveness assertions remain, and beginDrain remains last. Root-only /brag-output/ ignore verified; existing 52 brag-output deletions preserved.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Awaited PTY exit in the Codex transcript liveness test and placed it before beginDrain, whose one-way drain state suppressed the awaited exit event. Added the root-only /brag-output/ ignore. Verified on Windows with pnpm lint and pnpm test (623/623 passed), plus git diff --check; isolated regression test had also passed.
<!-- SECTION:FINAL_SUMMARY:END -->
