---
id: TASK-50
title: >-
  Usage report: timeframe filter misses Ollama/Codex charts; Codex
  window-balance axis broken
status: To Do
assignee: []
created_date: '2026-10-24 16:20'
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
- [ ] #1 Timeframe presets re-filter the Ollama and Codex 5h/7d utilization charts and the Ollama token-yield view
- [ ] #2 Window-balance and rate-limit-forecast cards stay reset-window keyed, and SKILL.md says so
- [ ] #3 _parse_reset_at resolves numeric epoch seconds, numeric milliseconds and ISO strings to the same second, covered by asserts in stats.test.mjs
- [ ] #4 stats.mjs forecast --force yields Codex window-balance buckets dated 2026 and a regenerated assets/example-report.html with a normal x-axis
<!-- AC:END -->
