---
id: TASK-2
title: Fix slow transcripts sidebar loading
status: Done
assignee:
  - '@codex'
created_date: '2026-10-15 12:11'
updated_date: '2026-10-15 14:36'
labels: []
dependencies: []
modified_files:
  - server/sessions.test.mjs
  - server/sessions.mjs
  - web/src/features/transcripts/SessionHistory.jsx
type: bug
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Opening /transcripts leaves the session sidebar loading for minutes. The reported network trace shows repeated transcripts requests with root under .claude/projects and hideReviews=1, around 3 MB each, taking 14-72 seconds and initiated from SessionHistory.jsx:149.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Opening /transcripts loads the sidebar without minute-long delays for the reported transcript corpus, with measured before/after evidence.
- [x] #2 Automatic sidebar refresh does not accumulate redundant overlapping transcript-list work.
- [x] #3 Transcript list behavior and review filtering remain correct, with regression coverage for the confirmed cause.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Confirmed investigation: transcript discovery performs sequential pre-cache head reads, a 200-entry cache thrashes across about 4598 transcripts, and 15-second frontend polling overlaps slow list requests. Apply the minimal cache/scan and refresh fix with regression tests demonstrated failing before and passing after the fix. Run scoped tests, pnpm lint, pnpm test, and measured original-corpus reproduction. Commit only session-owned files and complete cross-review, then read task-finalization and verify acceptance criteria before completion.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Validation at 72834c8: pnpm lint exit 0; pnpm test 579/579. Corpus 4641 rows (3.39 MB), isolated daemon: /api/transcripts cold 4.8/4.2 s (was 22.0 s at 8846bbe; user trace 14-72 s), warm 0.24-0.63 s (was 13.6 s). Playwright probe with delayed response: single-flight calls=1, 5000 rows rendered. Regression tests fail before fix (C1 history row.file, C2 meta cache, C4 allow-list, review-scan guard). Cross-review: round 1 REVISE (F1 medium fixed, F2 low fixed), round 2 APPROVED (reviewer Claude opus fallback, Codex usage 100%). Open low F5: review-scan catch drops the row on any error, not only ENOENT; transient flicker only. Commits: 8846bbe, 03c5fbe, 72834c8.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Sidebar load cut from 22 s cold / 13.6 s warm to ~4.5 s cold / ~0.4 s warm on the 4641-row corpus. Fixed: bounded cached scan, history backfill via row.file async parse, meta.json cache, streaming review scan with source allow-list, single-flight refresh. Verified by measured corpus timing, Playwright single-flight probe, lint, 579/579 tests, cross-review APPROVED.
<!-- SECTION:FINAL_SUMMARY:END -->
