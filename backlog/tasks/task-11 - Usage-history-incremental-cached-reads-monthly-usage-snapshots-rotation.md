---
id: TASK-11
title: 'Usage history: incremental cached reads + monthly usage-snapshots rotation'
status: Done
assignee:
  - '@claude'
created_date: '2026-10-17 06:46'
updated_date: '2026-10-17 07:04'
labels:
  - usage perf
dependencies: []
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every /api/usage/history poll re-reads raw logs synchronously (2 MB tail for 5h, 8 MB tail of usage-snapshots.jsonl for 7d, plus cost-history and codex-usage tails) and recomputes all chart points, although history rows never change; each open tab multiplies the cost. usage-snapshots.jsonl (USAGE_SKILL_STATE, shared with the harness-usage-report skill) is 19.4 MB, grows 3-5 MB/week and is never rotated; the skill's stats.mjs forecast reads the whole file and needs multi-week history. User decisions 2026-10-17: cache parsed raw rows per file and read only appended bytes; recompute the per-session split in memory only when an input changed (it cannot be append-only: top-8 ranking and late transcript spend change old intervals); rotate usage-snapshots.jsonl into monthly archives usage-snapshots-YYYY-MM.jsonl with the daemon as the only rotation owner; update stats.mjs in both the repo copy and the ~/.harness/config SSOT. Explore notes: C:/Users/sate/.agents/.plan/33454c15-68de-4aca-bae5-02d655a742e4/explore-cache.notes.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A poll after the first reads only bytes appended since the previous read for each log the history route reads (usage-snapshots, codex-usage, ollama-usage, cost-history and its .1); no poll re-reads an unchanged 8 MB tail
- [x] #2 The reader cache resets when a file shrinks or is replaced (rotation, rewrite) and prunes rows older than the 7d window
- [x] #3 getUsageHistory returns the cached doc when no input changed; the estimated per-session split is recomputed in memory when an input changed, and the output equals a cold computation
- [x] #4 On the first daemon append in a new calendar month the daemon renames usage-snapshots.jsonl to usage-snapshots-YYYY-MM.jsonl atomically, retrying on EBUSY/EPERM, without losing rows
- [x] #5 Daemon readers (7d/5h history totals and readClaudeSnapshot) read across the newest archive and the live file when the window spans the boundary or the live file is empty
- [x] #6 stats.mjs _load_usage_snapshots reads all monthly archives plus the live file in both the repo copy and the ~/.harness/config SSOT (regenerated)
- [x] #7 Unit tests cover incremental append, shrink/replace reset, cache-hit equality, rotation and cross-boundary reads; pnpm lint and pnpm test pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. tailRows: per-file incremental tail cache (byte-budget trim equal to a cold tail read; reset on shrink/identity change/in-place rewrite). 2. readTotals spans newest monthly archive + live. 3. getUsageHistory memo keyed on input stats + price table; attribution recomputed in memory on change. 4. Daemon rotateClaudeHistory: first-row month < current month -> link+unlink live to usage-snapshots-<first-row YYYY-MM>.jsonl, retry on failure. 5. readClaudeSnapshot archive fallback. 6. stats.mjs reads archives + live (repo copy; ~/.harness/config/skills/harness-usage-report is a junction to it). 7. Tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Review pass (no blockers); minors m1-m3 fixed: rotation by first-row month (another writer cannot postpone it), link+unlink instead of exists+rename (no archive overwrite race between daemons sharing USAGE_SKILL_STATE), month cached only after a valid parse. Measured worst-case cache heap ~25 MB. codex-usage/ollama-usage still unrotated (out of scope).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
History polls now read only appended bytes per log (warm==cold proven by randomized test) and return a memoized doc when no input changed; usage-snapshots.jsonl rotates monthly into usage-snapshots-YYYY-MM.jsonl owned by the daemon, with daemon readers and stats.mjs reading across archives. Verified: pnpm lint clean, pnpm test 609/609, independent review pass.
<!-- SECTION:FINAL_SUMMARY:END -->
