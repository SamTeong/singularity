---
id: TASK-2
title: Fix slow transcripts sidebar loading
status: In Progress
assignee:
  - '@codex'
created_date: '2026-10-15 12:11'
updated_date: '2026-10-15 12:20'
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
- [ ] #1 Opening /transcripts loads the sidebar without minute-long delays for the reported transcript corpus, with measured before/after evidence.
- [ ] #2 Automatic sidebar refresh does not accumulate redundant overlapping transcript-list work.
- [ ] #3 Transcript list behavior and review filtering remain correct, with regression coverage for the confirmed cause.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Confirmed investigation: transcript discovery performs sequential pre-cache head reads, a 200-entry cache thrashes across about 4598 transcripts, and 15-second frontend polling overlaps slow list requests. Apply the minimal cache/scan and refresh fix with regression tests demonstrated failing before and passing after the fix. Run scoped tests, pnpm lint, pnpm test, and measured original-corpus reproduction. Commit only session-owned files and complete cross-review, then read task-finalization and verify acceptance criteria before completion.
<!-- SECTION:PLAN:END -->
