---
id: TASK-50
title: >-
  Usage report: timeframe filter misses Ollama/Codex charts; Codex
  window-balance axis broken
status: Done
assignee: []
created_date: '2026-10-24 16:20'
updated_date: '2026-10-24 16:26'
labels: []
dependencies: []
type: bug
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
In the harness-usage-report skill, the "last 7 days / last 30 days / all time" presets only re-filter session-derived sections. The Ollama and Codex 5h/7d utilization charts and the Ollama token-yield view kept rendering all-time data next to the Claude chart that did follow the range. Separately, the Codex "5h-window to 7d-window" chart plots most points at 1970-01-21: codex-usage.jsonl mixes epoch-second numeric resets_at from the daemon polling with ISO strings from the rollout ingestion, and _parse_reset_at feeds a number straight to new Date(), which reads it as milliseconds.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Timeframe presets re-filter the Ollama and Codex 5h/7d utilization charts and the Ollama token-yield view
- [x] #2 Window-balance and rate-limit-forecast cards stay reset-window keyed, and SKILL.md says so
- [x] #3 _parse_reset_at resolves numeric epoch seconds, numeric milliseconds and ISO strings to the same second, covered by asserts in stats.test.mjs
- [x] #4 stats.mjs forecast --force yields Codex window-balance buckets dated 2026 and a regenerated assets/example-report.html with a normal x-axis
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Playwright probe on the regenerated example report: all-time -> 7d plotted samples 798->170 (Codex util), 786->72 (Ollama util), 158->0 (Ollama token yield); no 1970 x label; window-balance x labels <= 7. node scripts/stats.test.mjs: 7 asserts pass; reverting _parse_reset_at reproduces the 1970 bucket. stats.mjs forecast --force: 0 of 39 Codex window buckets before 2026-01-01. pnpm lint and pnpm test exit 0. PR #109 open on fix/usage-report-timeframe.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Range-filtered the Ollama/Codex utilization charts and the Ollama token-yield view (CUR_RANGE), left window balance and forecast reset-window keyed and documented that boundary. Fixed _parse_reset_at to normalize epoch seconds/ms and ISO strings so Codex window-balance buckets stop landing in 1970, and thinned its x labels. Known limits: residual r=0 lower-bound points from sparse early windows; Sonnet/Haiku absence from token yield is a capture gap (no statusline rate_limits on those sessions), not a chart bug. Verified with stats.test.mjs, forecast rebuild, Playwright preset probe, pnpm lint and pnpm test.
<!-- SECTION:FINAL_SUMMARY:END -->
