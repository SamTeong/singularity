---
id: TASK-42.12
title: Move Claude forced usage retry orchestration to Rust
status: Done
assignee: []
created_date: '2026-10-22 09:20'
updated_date: '2026-10-24 01:00'
labels: []
dependencies:
  - TASK-42.11
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-retry-service-design.md
modified_files:
  - rust/backend/src/retry_after.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/usage_snapshot.rs
  - rust/backend/src/claude_usage.rs
  - server/fixtures/retry-after-parity.json
  - server/external-fetch.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the Claude-only transient forced usage retry loop from Node into the existing Rust Claude usage service while preserving current Fetch and Retry-After behavior. Keep Node credential lookup and refresh, the one-time 401 coordinator, result mapping, JSON parsing, history append, normalization, and the non-force local fast path. Do not modify shared retry policy or Codex behavior. Design blocker: current policy parses each 429 Retry-After using JavaScript Number() then Date.parse(), anchored to Node Date.now() after the response returns. Rust has no demonstrated arbitrary-V8-compatible parser and the existing one-request JSON-lines bridge does not provide a per-attempt Node decision callback. Do not narrow this compatibility silently; the attached design records the unresolved protocol/design choice.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Claude retry policy preserves three total attempts and the existing retryable status set {408, 429, 500, 502, 503, 504}; other providers remain unchanged.
- [x] #2 Transient transport and per-attempt header-timeout failures retain the existing retry count and randomized exponential backoff (250 ms base, 5,000 ms cap); terminal response and body handling do not create duplicate retries.
- [x] #3 429 Retry-After preserves JavaScript Number() then Date.parse() behavior, the 5,000 ms shortcut, and the current response-time anchor, or implementation stops pending an explicit approved compatibility boundary.
- [x] #4 The existing queue-removal behavior for an aborted undispatched bridge request and FIFO enqueue-to-header deadlines remain intact; cancellation of dispatched Rust work or between-retry backoff is outside this production-parity task.
- [x] #5 401 still returns to Node for at most one credential refresh and a single second logical fetch using the refreshed token; auth, body parse, history, normalization, and local fast path stay Node-owned.
- [x] #6 Offline deterministic Rust and bridge tests cover status and network retry matrices, Retry-After compatibility cases, existing queued-abort/deadline behavior, one-time 401, and no duplicate retries; no provider calls or live credentials.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Resolve bounded Retry-After compatibility: support the existing raw-string Number and Date.parse inputs and response-time anchor with parity evidence, or stop pending an explicit compatibility boundary; do not claim universal V8 parity. 2. Do not gate on adding a caller cancellation protocol: production Claude usage has no outer/client cancellation signal today; preserve existing timeout and queued-abort behavior and treat dispatched cancellation as a separate enhancement. 3. Once Retry-After compatibility is resolved, implement Claude-local retries over the existing one-attempt Rust transport while retaining Node auth/401, JSON, history, normalization, and local fast path. 4. Add deterministic offline Rust and bridge parity tests, then run focused and project-required checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design remains blocked on arbitrary JavaScript Retry-After compatibility and a per-attempt decision seam. No Groma component ownership was available; leave architecture references empty. See C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-retry-service-design.md.

Prerequisite update (2026-10-22): production route server/index.mjs:371-374 passes no request-abort signal to getUsage, and the production Claude usage caller supplies only the internal per-attempt timeout to the Rust bridge. No outer/client cancellation protocol exists on this path, so introducing one is an enhancement and not a blocker to production behavior parity. The Rust bridge can cancel queued requests but not dispatched operations; preserve that existing behavior and describe it accurately. The remaining implementation blocker is the raw Retry-After conversion/response-time compatibility question. Existing snapshot date parsing and JSON-value number helpers are useful precedents but do not prove universal V8 compatibility; do not claim that.

Added deterministic TimeoutFailure-to-200 coverage in rust/backend/src/claude_usage.rs, asserting the initial 321 ms remaining header budget, two attempts, fresh 10 s retry timeout, 125 ms backoff, and terminal body. Groma reports no owning architecture component for this source file, consistent with the existing note.

Finalization evidence: passed terminal receipt SHA-256 9C1FE8FFFF16C83BD25BF5E8D955D9DC4E919B4B99C3B77D7B76911F3AE179C8; all seven validation steps exit 0. Accepted Retry-After boundary is shared parity vectors and response-time/cutoff tests, not universal V8 Date.parse equivalence. Dispatched/backoff cancellation remains outside this task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Claude forced usage retry orchestration into Rust while retaining Node-owned auth, 401 refresh, parsing, history, normalization, and local fast path. Verified by receipt 9C1FE8FFFF16C83BD25BF5E8D955D9DC4E919B4B99C3B77D7B76911F3AE179C8: 241 Rust tests, 85 focused Node tests, 728 full Node tests passed (2 skipped); all seven steps exited 0. Retry-After parity is bounded to approved vectors, not universal V8 compatibility.
<!-- SECTION:FINAL_SUMMARY:END -->
