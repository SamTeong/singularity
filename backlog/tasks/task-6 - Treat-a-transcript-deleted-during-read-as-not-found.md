---
id: TASK-6
title: Treat a transcript deleted during read as not found
status: Done
assignee: []
created_date: '2026-10-16 16:12'
updated_date: '2026-10-16 16:22'
labels: []
dependencies: []
modified_files:
  - server/sessions.mjs
  - server/sessions.test.mjs
priority: low
type: bug
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A Claude or Codex transcript can be deleted after readSession checks that its path exists but before the asynchronous file read. That ENOENT should produce the same not-found result used when the transcript is already absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 If a Claude or Codex transcript disappears before readFile opens it, readSession returns { ok: false, error: not found }.
- [x] #2 A read error other than ENOENT propagates unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Catch ENOENT only around Claude and Codex transcript reads; rethrow other errors. 2. Add deterministic readFile-mock coverage without a production injection hook and run the focused session suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The new regression deterministically deletes both Claude and Codex fixture files inside a mocked node:fs/promises readFile call. It also verifies an EIO read error propagates. The regression failed on the unfixed reader with ENOENT (1 failed), then the focused suite passed all 19 tests after both fixes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Claude and Codex transcript reads now treat ENOENT after path lookup as not found and preserve other read errors. The deterministic regression failed on unfixed code, then `pnpm exec node --test server/sessions.test.mjs` passed all 19 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
