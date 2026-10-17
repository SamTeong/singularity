---
id: TASK-7
title: 'Usage view: collapsible 5h history panel'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-17 01:04'
updated_date: '2026-10-17 01:36'
labels:
  - frontend server
dependencies: []
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Usage view shows only the current 5h % per provider, so there is no way to see how the window filled up or which sessions consumed it. Providers report only account-level %; the per-session split must be estimated. Decisions (user, 2026-10-17): chart via `@mui/x-charts` (new dependency); attribution weight = cost (Claude `cost.total_cost_usd` deltas from `sessions.jsonl`; Codex token-derived cost from rollout `token_count` events); Ollama tab shows total only (no per-session data exists); range = current 5h window; refresh toggle off/10s/30s/60s (data no finer than daemon sampler: claude/codex 5s, ollama 60s). History sources under `USAGE_SKILL_STATE` are external and read-only; any new daemon state goes through `server/app-dir.mjs`. Exploration notes: ~/.agents/.plan/33454c15-68de-4aca-bae5-02d655a742e4/explore-usage.notes.md and explore-gaps.notes.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A collapsible "5h history" panel sits between the provider cards and the usage report in the Usage view; its open state persists in localStorage like `sing:usage-open`
- [x] #2 The panel has one tab per visible provider (claude, codex, ollama per capabilities)
- [x] #3 Claude and Codex tabs show the current 5h window as a stacked chart, one series per session, with each interval's % change split by session cost share
- [x] #4 The chart is labelled as estimated attribution
- [x] #5 The Ollama tab shows the account-level 5h % line only and says per-session data is unavailable
- [x] #6 A refresh toggle offers off/10s/30s/60s and re-fetches history at the chosen rate only while the Usage view is visible
- [x] #7 A new `GET /api/usage/history` route is registered in `server/index.mjs` with a co-located `*.test.mjs` and a Mirage handler in `web/src/mock/routes/`
- [x] #8 The panel works at phone width, covered by an `e2e-mock/*-responsive.spec.mjs` check
- [x] #9 `pnpm lint && pnpm test` pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Server: new `server/usage-history.mjs` reads current 5h window points per provider (Claude: `usage-snapshots.jsonl` + `sessions.jsonl` cost deltas; Codex: `codex-usage.jsonl` + rollout `token_count` events; Ollama: `ollama-usage.jsonl` totals), attributes each interval % delta by session cost share, returns `{provider, windowStart, resetsAt, points:[{ts, pct, sessions:{id:pct}}], sessions:[{id,label}], estimated:true}`. Read-only on `USAGE_SKILL_STATE`.

2. Register `GET /api/usage/history?provider=` in `server/index.mjs`; co-located `server/usage-history.test.mjs` (node:test, mkdtemp fixtures).

3. Mirage handler in `web/src/mock/routes/telemetry.js` with fixture series.

4. Add `@mui/x-charts`; `web/src/features/usage/UsageHistoryPanel.jsx` collapsible (localStorage `sing:usage-history-open`), provider tabs, stacked area chart, "estimated" caption, refresh toggle off/10s/30s/60s gated on view visibility; mount between cards and UsageReportView in `UsageView.jsx`.

5. `e2e-mock` responsive check at phone width; `pnpm lint && pnpm test`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented in worktree C:/git/singularity/.claude/worktrees/agent-a395d6f011a487796 branch worktree-agent-a395d6f011a487796 commit 8294c9c. Deviation: Claude per-interval cost comes from transcript message usage priced via pricing.json, not sessions.jsonl (sessions.jsonl holds one row per session end, so it cannot split intervals). Change record: ~/.agents/.plan/33454c15-68de-4aca-bae5-02d655a742e4/implement-task7.notes.md

Validation at add7727 (worktree, same SHA fast-forwarded onto main): pnpm lint clean; pnpm test 595/595; e2e-mock 52/52 incl. usage-history-responsive.spec.mjs and usage.spec.mjs (reload persistence, Ollama tab, estimated caption, 10s polling stops when view hidden). Independent review pass after fix round 1 (expired window, exact stack sums, bounded parse cache). Claude interval cost uses transcript usage priced via pricing.json because sessions.jsonl has one row per session end; user requested per-turn statusline collection as follow-up.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a collapsible 5h history panel to the Usage view: GET /api/usage/history (server/usage-history.mjs) builds the current 5h window per provider and splits each interval's % change across sessions by cost share (labelled estimated); Ollama shows the account total only. UI uses @mui/x-charts with provider tabs and an off/10s/30s/60s refresh toggle that polls only while the view is visible. Verified with lint, 595 unit tests, 52 e2e-mock tests including a phone-width spec, and an independent review.
<!-- SECTION:FINAL_SUMMARY:END -->
