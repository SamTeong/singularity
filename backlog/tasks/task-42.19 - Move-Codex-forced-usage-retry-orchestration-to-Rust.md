---
id: TASK-42.19
title: Move Codex forced usage retry orchestration to Rust
status: Done
assignee: []
created_date: '2026-10-24 07:59'
updated_date: '2026-10-24 09:38'
labels: []
dependencies:
  - TASK-42.12
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/codex-retry-design.md
modified_files:
  - rust/backend/src/codex_usage.rs
  - server/usage.mjs
  - server/usage.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move only the Codex forced-usage retry orchestration into the existing Rust codex_usage_fetch operation. Keep the existing JSON-lines request/reply and private response shape; do not add a parser operation, bridge call, or response field. Preserve the Node non-force local snapshot path and one credential snapshot handle across Rust attempts, released once in finally. Rust uses its response-time Retry-After anchor only for retry scheduling. After the bridge returns and the handle is released, Node continues computing public retryAfterMs from the final raw header at its existing result-time Date.now() anchor. Node status/result mapping and JSON.parse wording remain later migration residuals. The current bridge caller supplies no signal or header-timeout option: queue wait has no deadline or queued abort, and each one-attempt Rust transport's fixed 10-second header timeout begins at transport dispatch. Preserve this behavior; do not add queue deadline/cancellation modernization. The bounded design and parser evidence are recorded in C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/codex-retry-design.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One forced Codex logical fetch makes one existing codex_usage_fetch bridge request; Rust retries only statuses 408, 429, 500, 502, 503, and 504 plus current retryable transport/header-timeout failures, for at most three total attempts, with the existing 250 ms exponential jitter schedule capped at 5000 ms.
- [x] #2 Each attempt preserves the existing fixed 10000 ms header timeout starting when Rust transport dispatch begins; time spent waiting in the bridge queue has no deadline or queued-abort behavior, as today. Terminal body-read and JSON parse failures do not cause retries or duplicate Node scheduling.
- [x] #3 Only 429 Retry-After affects Rust retry scheduling, using the shared helper and a response-receipt anchor; delay greater than 5000 ms returns immediately. Public retryAfterMs is still computed in Node after credential release from the final raw header with its existing result-time Date.now() anchor.
- [x] #4 The non-force local snapshot path avoids the bridge; the original credential handle is reused for every Rust attempt and released once after completion/error. Credential lookup, Node result/status mapping, JSON.parse wording, history, normalization, and non-Codex fetchExternal behavior remain unchanged and explicitly Node-owned.
- [x] #5 Deterministic offline Rust and Node tests cover retry status/network matrices, attempt count, jitter bounds, Retry-After shared vectors, response-time scheduling and result-time public anchors, fixed timeout/queue behavior, handle pin/release, terminal body failures, and no duplicate Node retry; no provider calls or live credentials.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement Rust-owned Codex retry orchestration with private deterministic seams and existing retry policy. 2. Keep one bridge fetch per forced logical request; preserve Node result mapping, public Retry-After conversion after credential release, non-force bypass, and terminal body failures. 3. Adapt focused Rust/Node tests; run only allowed rustfmt/source checks; report project tests unrun.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation source ownership: rust/backend/src/codex_usage.rs; server/usage.mjs; server/usage.test.mjs. Corrected design and review receipts are in C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/. --plain

Rust retry loop and focused deterministic retry tests are implemented; Node now issues one Codex bridge fetch and keeps final public Retry-After conversion after release. Source-only checks passed: rustfmt, node --check on usage.mjs and usage.test.mjs, and git diff --check. Project tests/builds remain pending the assigned validation runner. --plain

Final validation receipts: run 20261024T092205464Z passed fmt-check, release build, focused Codex/retry-after tests, focused Node (86), and full Rust (245 lib + 3 bin); lint initially failed on the orphaned CODEX_USAGE_API_URL. The authorized continuation run 20261024T093516268Z passed focused Node (86), lint, full Node (729), and diff check; all fresh steps report cleanup complete and 315 frozen inputs unchanged. Hashes verified: codex_usage.rs 1FBD8CF95B55ACC5876F9EC8DB849C8C6C32F7B1C82559B606235298A522BFDB; usage.mjs 45A3554A564C53F9C7C6397926B4ADDF76AA8CEDADEDDD1E455DBA56783C9222; usage.test.mjs D5F62D19B2969BB3089D17576F24CA2F11FB9636F70A345A47705CCF39839E62. Binary contents are not cryptographically bound by the runner receipt. Rust owns internal retry orchestration; Node retains the single bridge call, pinned credential lifetime, result/status mapping, JSON parsing, and public Retry-After conversion. No force or public 429/JSON changes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Codex forced-usage retry orchestration into the existing Rust operation while preserving one Node bridge call, pinned credential lifetime, and Node-owned result mapping. All five acceptance criteria are supported by the static review and the recorded offline Rust/Node validation receipts; focused/full Node, Rust release tests/build, formatting, lint, and diff checks passed. Runner limitation: the built binary contents are not cryptographically bound by the receipt.
<!-- SECTION:FINAL_SUMMARY:END -->
