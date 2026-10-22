---
id: TASK-42.14
title: Move Claude OAuth refresh transport to Rust
status: Done
assignee: []
created_date: '2026-10-22 12:01'
updated_date: '2026-10-22 12:30'
labels: []
dependencies:
  - TASK-42.13
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-oauth-refresh-service-design.md
modified_files:
  - rust/backend/src/http_attempt.rs
  - rust/backend/src/claude_oauth.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/usage.mjs
  - server/rust-backend.test.mjs
  - server/usage.test.mjs
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Claude OAuth refresh POST still crosses the Node fetch path. Move its transport behind one private Rust attempt while preserving Node retry and credential policy. Implementation design: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-oauth-refresh-service-design.md. Exact ownership: rust/backend/src/http_attempt.rs, new rust/backend/src/claude_oauth.rs, rust/backend/src/lib.rs, rust/backend/src/main.rs, server/rust-backend.mjs, server/rust-backend.test.mjs, server/usage.mjs, server/usage.test.mjs (about 400 lines). Groma has no established owner for server/usage.mjs; do not invent architecture references. Risk high; route-model implementation returned luna.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust uses a fixed HTTPS endpoint, POST method, fixed content-type and fixed client ID composition; the exact Node JSON.stringify body text, including non-string JSON refresh-token values, reaches the wire unchanged.
- [x] #2 The operation is one Node fetchExternal attempt and reuses the shared HTTP attempt/deadline/redirect core; existing GET behavior is preserved and POST redirects follow Fetch 301/302/303 body rewrite plus 307/308 replay rules.
- [x] #3 Offline tests cover redirect statuses/limit, URL and header security, bridge body fidelity, status and raw Retry-After, and ensure no token, body, or raw backend error is logged or returned.
- [x] #4 Node retains retries and Retry-After Number/Date.parse handling, JSON parsing, throttle, merge persistence, Keychain/CLI fallback, credential resolution, and existing 401 order; synthetic offline usage tests cover rotation, failures, guards, fallback, and retry behavior.
- [x] #5 Focused Rust and Node tests, Rust formatting/build, and project lint pass without provider calls or live credential access.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend shared Rust HTTP attempt to support fixed method/body while preserving GET and Fetch redirect behavior. 2. Add private Claude OAuth Rust operation and typed Node bridge with opaque exact JSON body and fixed endpoint/method/content-type. 3. Keep retry and credential policy in Node; add synthetic offline Rust/Node regression coverage. 4. Run permitted focused validation using the existing sysstats-target overrides and record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Independent review PASS and oauth-refresh-checks.receipt.json records all seven selected checks passed with native exit code 0 and all eight accepted source hashes unchanged. No provider calls, live ports, live credentials, or restarts. Residual: direct test for the private Node callback rejecting unexpected URL/method remains absent; callback is lexical to fixed URL/POST and Rust accepts no URL/method, so no test-only API was introduced.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved the Claude OAuth refresh transport attempt to a fixed HTTPS POST in Rust while preserving the exact Node JSON body and Node-owned retry, parsing, credential persistence, Keychain/CLI fallback, and 401 policy. Independent review PASS; all five acceptance criteria are supported by the seven-check verification receipt (Rust 199 library + 3 binary tests, focused Node 101 passed/2 skipped, full Node 715 passed/2 skipped, fmt, release build, lint, diff check). Direct unexpected URL/method callback test remains a documented nonblocking coverage gap.
<!-- SECTION:FINAL_SUMMARY:END -->
