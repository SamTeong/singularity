---
id: TASK-42.4
title: Move transcript data service to Rust
status: In Progress
assignee: []
created_date: '2026-10-21 05:44'
updated_date: '2026-10-21 06:19'
labels: []
dependencies:
  - TASK-42.3
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/transcript-substrate-design.md
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After provider status has moved behind the Rust service boundary, the app still relies on Node for configured transcript-root persistence, Claude and Codex discovery, JSONL parsing, reads, search, and nested subagent metadata. Move this coherent transcript data service behind the existing routes while preserving external read-only roots and the current response contracts. Keep TASK-3 persistent product indexing, route-owned registry/live/scope enrichment, stats/usage/history, chat policy, and Codex agent lifecycle outside this task. Rust remains the production runtime target; Node is allowed only for browser asset builds.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Configured Claude root selection and persistence continue to use the configured SINGULARITY_HOME state location; explicit/saved roots resolve consistently, external Claude and Codex transcript trees remain read-only inputs, and Rust never substitutes its default home.
- [ ] #2 Claude and Codex discovery, list rows, nested-subagent metadata, read, and search preserve the existing observable route contracts, including identity fields, ordering, review filtering, result caps, malformed or truncated record tolerance, deletion races, and filesystem error outcomes.
- [ ] #3 Claude and Codex JSONL parsing matches existing behavior for metadata, model/title normalization, message shaping/truncation, wrapper filtering, and duplicate Codex user-event suppression, with meaningful shared parity fixtures exercised by both Rust tests and existing Node-facing tests.
- [ ] #4 Path normalization and confinement tests cover platform separators/case behavior and reject escapes for selected Claude roots, Claude subagents, and CODEX_HOME-relative rollout paths.
- [ ] #5 Process-local cache invalidation, traversal/concurrency caps, and scan/read size limits preserve the existing contract; targeted tests cover same-size/m-time cache behavior and configured-root boundaries.
- [ ] #6 Existing HTTP routes keep their status/body contracts for root get/set, transcript list/read/search, and subagent list; registry-derived live state and scopes remain route-owned, while stats, usage/history, chat policy, and /transcripts/codex-thread identity remain outside this service migration.
- [ ] #7 Focused Rust parity fixtures and Node-facing route/service contract tests pass on Windows; Linux/macOS runtime validation remains tracked separately by TASK-42.2.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add shared Claude/Codex JSONL fixtures that freeze current Node parser output. 2. Implement the Rust parser/model normalization against explicit catalog input and match the shared fixture outputs. 3. Run focused Rust parser tests, Node fixture parity tests, and formatting checks; record parser-stage limitations without marking the full task done.
<!-- SECTION:PLAN:END -->
