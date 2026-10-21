---
id: TASK-42.3
title: Move provider status service to Rust
status: In Progress
assignee: []
created_date: '2026-10-21 05:19'
updated_date: '2026-10-21 05:30'
labels: []
dependencies:
  - TASK-42.1
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-status-design.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/research-provider-http-api-complete.notes.md
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
- [ ] #1 The Rust service owns the fixed provider catalog, Statuspage normalization and JSON field-presence behavior, request errors, the 20-second per-provider cache, first-error caching, and exact force bypass. After any failed refresh, return the exact prior cached payload without advancing its slot timestamp, including when that payload is a previous ok:false error; keep the /api/status map and only exact force=1 route signal compatible.
- [ ] #2 Each request fetches OpenAI then Claude serially; attempts preserve the three-attempt retry policy, retryable statuses, jittered exponential backoff, bounded Retry-After behavior, and a 10-second timeout around response-header acquisition only. Response body reading/JSON decoding and retry waits stay outside that per-attempt timeout.
- [ ] #3 Status requests use an async reqwest client on a Rust-owned Tokio runtime and do not block the JSONL reader or ordinary Rust operations. Keep ordinary request/response framing and single-item FIFO unchanged; correlate only asynchronous status_get requests/replies with a distinct status-reply discriminator and IDs, and allow status replies to resolve out of order.
- [ ] #4 Status requests remain independent, including overlapping forced refreshes, with no in-flight coalescing. Cache locks are released during network waits; failed refreshes consult the latest cache slot at completion so a concurrent success is retained.
- [ ] #5 Production provider URLs remain fixed and cannot be supplied by public query/config input. Tests use an internal injected endpoint/client and deterministic time/backoff with a loopback mock; no test requires external provider access.
- [ ] #6 Deterministic tests cover status normalization, cache/force/recovery, first-error caching, stale success and stale ok:false payload retention after a failed refresh with unchanged slot timestamp, retry and errors, provider order and independence, header-timeout versus body-read parity, ordinary FIFO under slow status, concurrent out-of-order status replies, backend failure cleanup, and stop behavior.
- [ ] #7 Do not change shared external-fetch behavior or its chat and usage consumers, and do not add or modify unrelated chat/usage helpers.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect shared Rust dispatcher and Node bridge; resolve the status-reply discriminator collision gate. 2. Add the async Rust provider service with fixed production URLs, deterministic private test seams, cache/retry parity, and tests. 3. Add status-only correlated async JSONL transport while preserving ordinary FIFO and cleanup on child failure/stop. 4. Route /api/status through the Rust service and retain exact force=1 behavior. 5. Run focused Rust and Node checks, release build, formatting, full Rust suite, lint, and Node suite using the isolated target directory.
<!-- SECTION:PLAN:END -->
