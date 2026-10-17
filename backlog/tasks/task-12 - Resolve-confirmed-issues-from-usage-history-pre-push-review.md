---
id: TASK-12
title: Resolve confirmed issues from usage history pre-push review
status: In Progress
assignee:
  - '@codex'
created_date: '2026-10-17 07:19'
updated_date: '2026-10-17 12:15'
labels: []
dependencies: []
modified_files:
  - .claude/skills/harness-usage-report/scripts/statusline.mjs
  - .claude/skills/harness-usage-report/scripts/statusline.test.mjs
  - server/usage-history.mjs
  - server/usage-history.test.mjs
  - web/src/features/usage/UsageHistoryPanel.jsx
  - web/src/features/usage/stepTicks.mjs
  - web/src/features/usage/stepTicks.test.mjs
type: task
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track confirmed in-scope defects found while reviewing the 22 unpushed commits from 88a638adea7e527f62d400bc4118fe8dd093165a to 75903297ec8a04b160a2aa2e5e8735a5da1a9e19. Keep this task limited to findings recorded in the project-review run and their necessary fixes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every confirmed in-scope review finding has a focused fix or a documented reason it remains open.
- [ ] #2 Relevant tests and project checks pass for each fix.
- [ ] #3 The project-review finding and report artifacts reflect verified fix status.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Primary checkout selected for validation: main currently contains the merged alternate implementation in 0328600 and 2d7eb2f; source commit 10e352d is not an ancestor and has an additional mock E2E regression. Validate the current primary target and independently review all commits after 7590329. Validation and root cross-review remain pending.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The four confirmed P2 findings are implemented in the merged usage-history changes. Primary-checkout validation and independent review of the fix delta remain pending; keep this task In Progress until both are complete.
<!-- SECTION:FINAL_SUMMARY:END -->
