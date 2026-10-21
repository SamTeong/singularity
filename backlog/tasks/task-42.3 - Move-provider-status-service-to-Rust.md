---
id: TASK-42.3
title: Move provider status service to Rust
status: Done
assignee: []
created_date: '2026-10-21 05:19'
updated_date: '2026-10-21 06:15'
labels: []
dependencies:
  - TASK-42.1
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-status-design.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/research-provider-http-api-complete.notes.md
  - rust-backend
modified_files:
  - rust/backend/Cargo.toml
  - rust/backend/Cargo.lock
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/index.mjs
  - server/rust-backend.test.mjs
  - server/status.mjs
  - rust/backend/src/status.rs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the fixed OpenAI and Claude Statuspage service behind Rust ownership while preserving the existing /api/status response contract. Keep the Fastify route as a temporary adapter during this slice and preserve provider behavior documented in the linked provider-status design note. The accepted runtime target remains one Rust production daemon; Node is used only to build web assets in the final runtime. Scope excludes shared chat and usage consumers of external-fetch.mjs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Rust service owns the fixed provider catalog, Statuspage normalization and JSON field-presence behavior, request errors, the 20-second per-provider cache, first-error caching, and exact force bypass. After any failed refresh, return the exact prior cached payload without advancing its slot timestamp, including when that payload is a previous ok:false error; keep the /api/status map and only exact force=1 route signal compatible.
- [x] #2 Each request fetches OpenAI then Claude serially; attempts preserve the three-attempt retry policy, retryable statuses, jittered exponential backoff, bounded Retry-After behavior, and a 10-second timeout around response-header acquisition only. Response body reading/JSON decoding and retry waits stay outside that per-attempt timeout.
- [x] #3 Status requests use an async reqwest client on a Rust-owned Tokio runtime and do not block the JSONL reader or ordinary Rust operations. Every bridge-managed request/reply carries an ID envelope; ordinary operations remain single-item FIFO, status replies carry a distinct status_reply discriminator and may resolve out of order, and requests without IDs retain bare legacy replies.
- [x] #4 Status requests remain independent, including overlapping forced refreshes, with no in-flight coalescing. Cache locks are released during network waits; failed refreshes consult the latest cache slot at completion so a concurrent success is retained.
- [x] #5 Production provider URLs remain fixed and cannot be supplied by public query/config input. Tests use an internal injected endpoint/client and deterministic time/backoff with a loopback mock; no test requires external provider access.
- [x] #6 Deterministic tests cover status normalization, cache/force/recovery, first-error caching, stale success and stale ok:false payload retention after a failed refresh with unchanged slot timestamp, retry and errors, provider order and independence, header-timeout versus body-read parity, ordinary FIFO under slow status, concurrent out-of-order status replies, backend failure cleanup, and stop behavior.
- [x] #7 Do not change shared external-fetch behavior or its chat and usage consumers, and do not add or modify unrelated chat/usage helpers.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect the shared dispatcher and bridge; reject ambiguous status-only framing and use IDs for all bridge-managed calls. 2. Add the async Rust provider service with fixed production URLs, a private deterministic loopback test seam, cache/retry parity, and tests. 3. Add correlated status dispatch without blocking ordinary FIFO; reject pending work on failure/stop and suppress late writes. 4. Forward /api/status to Rust with only exact force=1. 5. Run focused checks, isolated release build, formatting, full Rust tests, lint, and Node tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design gate resolved before implementation: config_state_get merges arbitrary persisted fields into its ordinary JSON response, so a payload containing type=status_reply and id could collide with a status-only discriminator. Updated provider-status-design.md to use ID envelopes for all bridge-managed requests/replies while retaining ordinary FIFO and bare legacy replies for no-ID callers.

Repair: Retry-After HTTP dates now use the clock sampled when each response arrives; exact 5000 ms retries and >5000 ms does not are covered. Shutdown transition and status writes share the stdout mutex, tested through production helpers. Added overlapping success-then-failure cache race coverage. Reqwest redirect limit is 20 to match Node Fetch, verified with loopback 20-success/21-failure tests.

Parallel-suite stall root cause: the existing concurrent-call fixture could let one call cache OpenAI before the second began, while its server always waited for four requests. Replaced it with a loopback barrier that withholds both OpenAI responses until both calls are in flight, then verifies two OpenAI requests precede two Claude requests.

All modified status loopback accept and channel waits are bounded to 10 seconds so parallel-suite fixture failures surface instead of hanging.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved fixed-provider status fetching, normalization, cache/retry behavior, and correlated bridge ownership into Rust while retaining the /api/status adapter. Verified with 113 Rust library tests and 1 main test, release build, fmt check, lint, and Node suites (690 passed, 0 failed, 2 known Windows mtime skips). Correlated status replies, overlapping cache races, shutdown ordering, and 20/21 redirect behavior are covered; no public provider calls or live restarts.
<!-- SECTION:FINAL_SUMMARY:END -->
