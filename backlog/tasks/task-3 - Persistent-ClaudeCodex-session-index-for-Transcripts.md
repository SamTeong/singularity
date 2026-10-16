---
id: TASK-3
title: Persistent Claude+Codex session index for Transcripts
status: To Do
assignee: []
created_date: '2026-10-15 14:37'
labels: []
dependencies: []
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a persistent index of Claude and Codex sessions so the Transcripts sidebar lists without rescanning rollouts. List metadata only; search keeps reading files. Add a typed origin field: interactive | review | subagent | headless. Review signal for Codex: source.subagent.other === 'guardian' (thread_source=subagent alone is unsafe: 58 reviews carry it). Follow-up from TASK-2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Sidebar list is served from the index without full rollout reads on cold start
- [ ] #2 Each entry carries origin typed as interactive/review/subagent/headless; hideReviews uses it
- [ ] #3 Index invalidates correctly on changed/removed/new sessions, with regression tests
<!-- AC:END -->
