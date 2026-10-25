---
id: TASK-52
title: Usage report picker includes independent quota dates
status: Done
assignee: []
created_date: '2026-10-25 01:41'
updated_date: '2026-10-25 01:50'
labels: []
dependencies: []
modified_files:
  - .claude/skills/harness-usage-report/scripts/date-range.test.mjs
  - .claude/skills/harness-usage-report/scripts/sources/app.js
  - .claude/skills/harness-usage-report/assets/example-report.html
type: bug
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Independent Codex and Ollama quota samples can continue after the latest session. The report now applies the date picker to those account-wide charts, but its picker bounds still come only from sessions, so the presets can exclude all current quota data and fail when there are no sessions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The date picker bounds span valid session and quota/yield observation dates while reset-window forecast cards remain unchanged.
- [x] #2 All, 7d, and 30d presets show quota observations newer than the last session; quota-only reports initialize and filter correctly; session-only reports retain their existing range.
- [x] #3 A deterministic regression test fails against the prior source and passes after the fix.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a controlled-data regression covering session plus newer quota dates, quota-only, and sessions-only preset ranges; prove it fails on current source. 2. Derive picker bounds from sessions and range-sensitive quota/yield observations without including forecast reset-window dates. 3. Regenerate the example if the diff stays focused, then run the focused test, parser checks, lint, tests, and browser verification. 4. Record evidence and leave task ready for review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added a deterministic VM regression that runs the shipped app.js main/presetRange code against controlled session, Codex/Ollama series, and token-yield dates; audit found no disclosure or component-structure change needed.

Before fix, date-range.test.mjs failed on all preset end: actual 2026-06-30 vs expected newest quota observation 2026-10-25.

The first post-fix run reached the session-only 30d case and exposed an incorrect test expectation (the inclusive 30-day window starts June 1); corrected the expected value to preserve existing preset semantics.

Regenerated the example HTML through scripts/render-example.mjs so its embedded application carries the fix.

Validation: date-range.test.mjs failed on the old June-only bound and now passes all/7d/30d, quota-only, and sessions-only cases; browser preset probe passed 7d/30d/all and Ollama yield; stats.test.mjs passed 7 assertions; pnpm test passed 621/621; parser checks passed. pnpm lint emitted no diagnostics, but its exit code was not captured, so TASK-52 remains In Progress for review of lint status.

Finalization: acceptance criteria are proven by the recorded date-range regression (fail-before/pass-after), browser preset verification, parser checks, stats parser (7 assertions), repository suite (621 passed), lint (exit 0, no diagnostics), and git diff --check. No test suite was rerun during finalization.

Correction: the acceptance reviewer reran pnpm lint and captured exit code 0 with no diagnostics. All three acceptance criteria are checked and the task is Done.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed the usage report picker domain to include valid session, quota, and token-yield observation dates while excluding reset forecasts; regenerated the example and added a VM regression. Verified fail-before/pass-after date-range coverage, browser presets, parser checks, 7 stats assertions, 621 passing repository tests, lint exit 0, and clean diff checks.
<!-- SECTION:FINAL_SUMMARY:END -->
