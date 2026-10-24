---
id: TASK-42.20
title: Move Codex result mapping to Rust
status: Done
assignee: []
created_date: '2026-10-24 12:01'
updated_date: '2026-10-24 12:25'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/codex_usage.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The prior Codex retry migration left response result classification and public 429 delay conversion in Node. Move that bounded result mapping into the Rust backend while retaining Node JSON.parse and its V8-visible errors.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A status-200 parsed JSON value is normalized by the Rust result operation into the existing public Codex DTO, including fetchedAt and omission/null behavior.
- [x] #2 Non-200 outcomes preserve current public errors and fields; 429 retryAfterMs uses a clock captured after credential release, and non-200 bodies are not parsed.
- [x] #3 Malformed and terminated status-200 bodies retain current Node parse error wording; no-session, timeout, transport, retry policy, and call ordering remain unchanged.
- [x] #4 Focused Rust and Node regression coverage exercises status/default DTO, Retry-After numeric/date/malformed/empty values, and post-release clock timing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect bridge dispatch and existing normalizer/retry-after APIs; create this active child task before source changes. 2. Add typed Rust completed-response mapping and bridge wrapper, then replace only the post-release Node mapping. 3. Add focused Rust and Node regressions. 4. Run permitted formatting checks only; validation owner lane runs the tests/build.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner validation receipt run-20261024T121853821Z: schema codex-result-owner-checks/v1, mode full-suite, status ok, failure null; all 9 completed steps exited 0 with cleanup complete. Expected HEAD 9f477c4 matched actual/headAfter 9f477c4cad0a5fe1e9f734edd173e82ccffe8146. Frozen source inputs: 315; before/after snapshots match. Recomputed all six changed source hashes and matched their receipt freeze entries. Binary build/final SHA256 matched: E7440CFB4795C2018FE5956DC637FD621F786FAFA628C8EA559C72B04F863E69. Receipt SHA256: 3F9DF3D4AE336618BC4965D4B4FAB941F6AEED487B26678C9E3892A976DA02E6. Tests: full Node 733 total, 731 pass, 2 skipped; focused Node 87 pass; Rust codex_usage filter 20 pass, retry_after filter 18 pass; full Rust 248 pass plus 3 additional integration tests. Explicit boundary residuals: Node retains JSON.parse and V8 parse/terminated-body wording; successful payload normalization and non-200 result mapping run through Rust. Retry-After date behavior is verified for finite fixtures, not every V8 Date.parse grammar. Static reviews passed after repair of the domain-failure DTO bridge; generic backend error envelopes still reject.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Codex completed-response DTO mapping to Rust while retaining Node JSON.parse and V8-visible body errors. Verified all four acceptance criteria with the successful frozen owner receipt and focused/full Rust and Node test logs; independent bridge and runner reviews found no remaining blocker.
<!-- SECTION:FINAL_SUMMARY:END -->
