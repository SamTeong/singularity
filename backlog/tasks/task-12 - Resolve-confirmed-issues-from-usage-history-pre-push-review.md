---
id: TASK-12
title: Resolve confirmed issues from usage history pre-push review
status: In Progress
assignee:
  - '@codex'
created_date: '2026-10-17 07:19'
updated_date: '2026-10-19 02:48'
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
  - server/wiki.mjs
  - server/wiki.test.mjs
  - .claude/skills/harness-usage-report/INSTALL.md
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
- [ ] #4 The independently confirmed wiki parser defect is fixed and covered by a regression.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Recover stale statusline rotation locks without disturbing a live owner, with regressions for dead/live owners and the >2x retention boundary. 2. Align short usage ticks to local time and label first tick per date, covering Kathmandu and skipped-midnight DST plus tick caps. 3. Prevent model changes in later timestamp seconds from pricing earlier hook rows while preserving same-second ambiguity and tolerance boundaries. 4. Coordinate the separate wiki parser repair under this task. 5. Run focused tests and lint; update task links and review records.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Primary checkout selected for validation: main currently contains the merged alternate implementation in 0328600 and 2d7eb2f; source commit 10e352d is not an ancestor and has an additional mock E2E regression. Validate the current primary target and independently review all commits after 7590329. Validation and root cross-review remain pending.

PR #105 fixture repair: server/usage-history.test.mjs derives the rollout model switch from Date.parse(local(T[0] + 100_000)) + 500 so it stays 500ms after the recorded whole-second hook at every epoch remainder. Deterministic target test failed before the change at remainder 750 (actual thread-m 8.57/thread-n 1.43 vs expected 7.5/2.5); passed after at remainders 250, 750, and 900. pnpm lint passed. pnpm test was invoked, but its captured log ended before the test summary/exit status, so full-suite validation remains unconfirmed pending CI.

PR #105 CI repair: complete local TAP summary confirms 614/614 tests pass; lint and deterministic 250/750/900ms cases pass. Hosted CI is being rerun.

Current review follow-up: implement F9/F10/F11/F7; F12 coverage is folded into those regressions. A separate lane owns the confirmed wiki parser defect. This task remains In Progress.

Wiki parser fix: parseSweepHistory now excludes UNVERIFIED claim bullets and the claim phrase “New partial context” from sweep interruption detection while retaining sweep-level interruption checks. Added regressions for the actual 2026-10-18 NetMediate fetch-failed claim, the 2026-10-04 Roslyn partial-context note, and fallback after a newer interrupted run. node --test --test-force-exit server/wiki.test.mjs passed 16/16. Read-only configured dotnet ledger probe now reports deep 2026-10-18. Live daemon was not restarted per project policy; process may retain the old module. Task remains In Progress pending independent review and final project checks.

Regression confirmation: temporarily restored the original parser, ran node --test --test-force-exit server/wiki.test.mjs, observed expected 2 failures (14 pass, 2 fail; false 2026-10-18 rejection and interrupted fallback returned null), then restored the fix. The fixed run above passed 16/16.

Wiki parser review repair: neutralized only the word “partial” in the New partial context claim phrase, preserving subsequent interruption status. Added semicolon and period-separated incomplete-sweep regressions; targeted wiki tests pass 17/17 and the configured read-only dotnet ledger probe still reports deep 2026-10-18.

Legacy statusline lock boundary: automatic recovery now requires a positively identified dead PID owner; ownerless or unreadable locks remain protected regardless of age. INSTALL.md documents removal only after old statusline writers are stopped and the exact state-root lock path is rechecked. Read-only runtime inspection found cost-history.jsonl at C:/Users/sate/.agents/.harness-usage-report/state (95,230 bytes) and no .lock directory, so no migration was needed or performed. Targeted statusline tests passed 8/8.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The four confirmed P2 findings are implemented in the merged usage-history changes. Primary-checkout validation and independent review of the fix delta remain pending; keep this task In Progress until both are complete.
<!-- SECTION:FINAL_SUMMARY:END -->
