---
id: TASK-9
title: 'Usage history: per-turn Codex tokens from the Stop hook'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-17 01:39'
updated_date: '2026-10-17 02:00'
labels:
  - server
dependencies:
  - TASK-7
modified_files:
  - server/usage-history.mjs
  - server/usage-history.test.mjs
  - .claude/skills/harness-usage-report/scripts/codex.mjs
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Codex hooks record no tokens, cost or session id: the harness Codex Stop hook (`~/.harness/config/hooks/codex-usage-stop.mjs`, wired in `~/.harness/config/hooks.manifest.json`) appends only 5h/weekly % to `codex-usage.jsonl`, so per-session Codex attribution in TASK-7 depends on scanning rollout files. User decision (2026-10-17): option C2: extend the Stop hook to add `session_id` and `last_token_usage` per turn. That hook is harness SSOT: edit under `~/.harness/config`, run `node ~/.harness/app/generate.mjs`, and add a seven-day follow-up in `~/.agents/.todo/`. The `codex.mjs` self-test asserts the current row keys and must be updated with it. Design notes: ~/.agents/.plan/33454c15-68de-4aca-bae5-02d655a742e4/explore-statusline.notes.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each `codex-usage.jsonl` row written by the Stop hook carries `session_id` and `last_token_usage`, and existing readers of the file still parse old and new rows
- [ ] #2 The change is made in `~/.harness/config` and regenerated, with `generate.mjs --check` clean
- [ ] #3 The `codex.mjs` self-test accepts the new keys
- [ ] #4 `GET /api/usage/history` attributes Codex intervals from the hook rows, falling back to rollout parsing for turns with no row
- [ ] #5 Unit tests cover old-row compatibility and the attribution with fallback
- [ ] #6 `pnpm lint && pnpm test` pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Harness SSOT ~/.harness/config/hooks/codex-usage-stop.mjs: read the last token_count payload (same 64KB tail) and add session_id (Stop payload session_id, else rollout filename uuid), last_token_usage and total_token_usage to each row; dedup also keys on [session_id, total_tokens] so every spending turn writes a row. Update the hook self-test and app/test/codex-usage-stop.test.mjs; regen, --check clean, commit in ~/.harness; seven-day follow-up in ~/.agents/.todo.
<!-- SECTION:PLAN:END -->
