---
id: TASK-8
title: 'Usage history: per-render Claude cost/token capture via statusline'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-17 01:39'
updated_date: '2026-10-17 01:44'
labels:
  - server
dependencies:
  - TASK-7
modified_files:
  - .claude/skills/harness-usage-report/scripts/statusline.mjs
  - .claude/skills/harness-usage-report/SKILL.md
  - .claude/skills/harness-usage-report/INSTALL.md
  - server/usage-history.mjs
  - server/usage-history.test.mjs
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-7 attributes each 5h interval to Claude sessions by re-pricing transcript tokens with pricing.json, because the only cost history is sessions.jsonl (one row per session, appended at SessionEnd by `stats.mjs record`). The repo-owned statusline (`.claude/skills/harness-usage-report/scripts/statusline.mjs`) already receives Claude Code's own `cost.total_cost_usd`, token counts and `rate_limits.five_hour` on every render but overwrites `cost-state/<sid>.json` with no history. User decision (2026-10-17): option A+B: the statusline appends a deduped row per render, and the daemon reads that series for Claude attribution instead of re-pricing transcripts. Appending changes the skill capture contract (`SKILL.md` "Capture contract (statusline)", INSTALL.md), so update those docs. Design notes: ~/.agents/.plan/33454c15-68de-4aca-bae5-02d655a742e4/explore-statusline.notes.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 statusline.mjs appends `{ts, session_id, cost_usd, tokens, five_hour_pct, five_hour_resets_at}` to a jsonl under the skill state dir on each render, skipping rows whose cost and 5h % are unchanged since that session's last row
- [ ] #2 The appended file is bounded by rotation or pruning to at most a fixed retention, and the cap is documented
- [ ] #3 The skill capture-contract docs describe the new file and its fields
- [ ] #4 The daemon reads the per-render series (read-only) and `GET /api/usage/history` attributes Claude intervals by Claude Code's reported cost deltas, falling back to transcript re-pricing only for sessions with no rows
- [ ] #5 Unit tests cover the append dedup, rotation, and the attribution switch with fallback
- [ ] #6 `pnpm lint && pnpm test` pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. statusline.mjs: before overwriting cost-state/<sid>.json, read the previous payload; if cost.total_cost_usd or rate_limits.five_hour.used_percentage changed (or none), appendFileSync one row {ts, session_id, cost_usd, tokens, five_hour_pct, five_hour_resets_at} to <state>/cost-history.jsonl. All in try/catch.
<!-- SECTION:PLAN:END -->
