---
id: TASK-42.10
title: Migrate forced Codex live usage to Rust service
status: Done
assignee:
  - '@codex'
created_date: '2026-10-22 05:58'
updated_date: '2026-10-22 06:59'
labels:
  - rust-migration codex-usage
dependencies:
  - TASK-42.8
modified_files:
  - rust/backend/src/codex_usage.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/src/status.rs
  - server/external-fetch.mjs
  - server/external-fetch.test.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
  - >-
    backlog/tasks/task-42.10 -
    Migrate-forced-Codex-live-usage-to-Rust-service.md
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the forced Codex live usage adapter described in C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/codex-live-usage-service-design.md, after TASK-42.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Forced Codex requests use the resolved auth path and preserve existing result/error shapes without credential leakage; local snapshot non-force path remains unchanged.
- [x] #2 Each Rust attempt matches GET headers, Fetch redirects including missing Location behavior, 10s headers-only timeout, body UTF-8 replacement/error behavior, and status mapping.
- [x] #3 Node retains retries and JavaScript Retry-After Number()/Date.parse() behavior temporarily, including exact attempt count, jitter/backoff, 429 response-time anchor, long-delay bypass, and final retryAfterMs anchor.
- [x] #4 Existing normalization, provider window semantics, JSON parse error text, daemon request correlation/FIFO/concurrency, and HTTP/WebSocket routes remain preserved.
- [x] #5 Offline Rust wire/service and Node bridge/parity tests cover auth, headers, redirects, body read/parse, retry/timeout/status/Retry-After cases, and successful/unstarted/weekly-only usage without skipped coverage or external calls.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add an isolated Rust Codex usage transport service with explicit auth path, Fetch-compatible redirects and headers-only timeout. 2. Add offline service tests for auth, status, redirect, body and timeout behavior. 3. Run focused Rust tests and cargo fmt --check; record integration handoff for the next stage.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Wire stage adds a typed timeout result because the Node AbortController oracle returns DOMException message This operation was aborted.

Codex live requests now dispatch through the Rust bridge once per shared retry-helper attempt; force=false remains local snapshot only.

Added an offline bridge protocol fixture asserting the correlated codex_usage_fetch op carries only the resolved auth path.

Focused service and Node suites pass; credential pinning across bridge retries remains a parity blocker for the next repair lane.

Repair lane adds a daemon-private credential snapshot table keyed by opaque per-process handles. Node loads once before the shared retry loop, reuses the handle on retries, and releases it in finally; bridge exit drops abandoned snapshots. Added an actual Rust loopback fixture proving auth-file rotation leaves retry headers pinned, a Node forced-fetch retry fixture proving handle reuse and release, bridge op correlation coverage, and response-time Retry-After schedule fixtures for 0x10, March 1, standard HTTP-date, and invalid input. Updated the design to document snapshot lifetime and the stale compatibility wording. Focused verification pending.

Repair validation: cargo fmt --manifest-path rust/backend/Cargo.toml -- --check passed; cargo test --manifest-path rust/backend/Cargo.toml --lib codex_usage::tests -- --test-threads=1 passed 11/11; cargo build --manifest-path rust/backend/Cargo.toml --release passed using C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/sysstats-target. Focused Node usage/bridge/external-fetch tests passed 97, failed 0, with 2 existing pre-epoch mtime skips; pnpm lint and git diff --check passed. Release executable override path resolved to C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/sysstats-target/release/singularity-backend.exe, SHA-256 4E6DEEBC3192D844384FA3D18098D1BC99E260069B4490C3D0B3561A2D790F04; all three Rust binary overrides were set to it, HOME/USERPROFILE/CARGO_HOME were preserved, and USAGE_REPORT_STATE was unset. No provider call, secret credential, daemon restart, commit, or push. A first Rust run failed only the fixture's case-sensitive header assertion; a first release build caught cross-crate visibility that was resolved by encapsulating the snapshot table in CodexUsageSessions. Pre-fix production failure was not captured; the final Rust regression directly exercises auth rotation against loopback.

Finalization evidence: reviewed numeric-auth repair PASS with no blockers; all 9 credential-pinning VERIFY anchors and the numeric-auth VERIFY anchor occur exactly once. Source hashes match the reviewed set: numeric Codex module F16FBF971D6EF0EDF1ACEBBE50C057F6BECE001CD5514462C0D516201BFCB752; status test diagnostic E0C23A2AC6849B0114308CD9229D3FBA97F21226BC512796C0882E76EEAE30AC; other reviewed source hashes unchanged. Focused Rust 12/12 passed, full serial Rust 192 library + 3 main passed after test-only status diagnostics; full Node 704 passed, 0 failed, 2 known pre-epoch filesystem-mtime skips; fmt, release build, and lint passed in supplied receipts. The preceding full Rust attempt had 190 pass/1 status timeout failure; diagnostic rerun passed and the original failure cause remains unknown. Windows live-usage migration is complete for forced fetch transport, while Node still owns retry/backoff/Retry-After parsing and JSON.parse compatibility per the explicit temporary design residual; parent Rust daemon migration remains incomplete. Groma reported no enabled scanner owner for the changed source paths, so no architecture references were invented.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated forced Codex live usage transport into the Rust backend while preserving Node retry and normalization behavior. Verified by the full serial Rust suite (192 library + 3 main), full Node suite (704 pass, 2 known Windows mtime skips), focused Rust 12/12, fmt, release build, lint, and independent review PASS. No live provider calls or credentials were used.
<!-- SECTION:FINAL_SUMMARY:END -->
