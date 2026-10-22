---
id: TASK-42.11
title: Move Claude live usage GET to Rust
status: Done
assignee: []
created_date: '2026-10-22 07:03'
updated_date: '2026-10-22 07:46'
labels: []
dependencies:
  - TASK-42.10
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-live-usage-service-design.md
  - server/usage.mjs
  - server/external-fetch.mjs
  - rust/backend/src/codex_usage.rs
modified_files:
  - rust/backend/src/http_attempt.rs
  - rust/backend/src/claude_usage.rs
  - rust/backend/src/codex_usage.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/usage.mjs
  - server/usage.test.mjs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The forced Claude usage read still performs its authenticated provider GET in Node. Move only that one-attempt transport through the private Rust bridge so this provider request joins the Rust service migration while credential ownership and caller behavior remain with their current Node owners. Keep access-token lookup, refresh and persistence, Keychain and CLI fallback in Node; retain Node retry/Retry-After, parsing, history append, normalization, and local snapshot fast path. Design: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-live-usage-service-design.md. Groma architecture references are unavailable for this bounded slice; no element IDs were inferred.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Forced live Claude usage sends the existing fixed GET and application headers through a typed one-attempt Rust bridge operation.
- [x] #2 Node keeps credential lookup/refresh, per-attempt token snapshot, one-time 401 refresh recursion, local non-force fast path, retry policy, response mapping, JSON parsing, history append, and normalization behavior.
- [x] #3 Rust transport preserves the documented redirect, Authorization stripping, header-timeout, body-read, UTF-8, and redacted error behavior without exposing the token in results, errors, or logs.
- [x] #4 Offline bridge and Rust fixture tests cover success, 401 refresh with a new second token, retryable and mapped statuses, malformed/body failures, redirects, and token redaction without provider calls or live credentials.
- [x] #5 Change stays within 12 source/test files and 30 dependency edges; broader auth, Keychain, CLI, retry, JSON parsing, and whole-daemon cutover ownership remain explicit residuals.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extract the existing Codex HTTP attempt behavior into a private shared Rust module and preserve Codex behavior. 2. Add the typed Claude one-attempt operation and Node bridge adapter while preserving Node policy. 3. Convert Claude usage tests to guarded bridge fixtures and add offline Rust transport coverage. 4. Run the required focused and full checks with the assigned target directory, then report source freeze for independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Acceptance is verified with focused Rust usage tests (47 passed), serial Rust suite (194 library + 3 main passed), cargo fmt check, release build, focused Node usage/bridge/retry tests (101 passed; 2 known mtime skips), pnpm lint, full pnpm test (710 total: 708 passed, 2 known mtime skips), and diff check. Independent review passed. Scope remains 9 source/test files. Node-owned residuals are credential lookup/refresh/persistence, Keychain and CLI fallback, 401 refresh coordinator, retry policy, JSON parsing, history append, normalization, and local fast path; whole-daemon migration remains outside this task. A focused Node invocation without the project-standard --test-force-exit stayed alive after test output; exact cause remains unknown, while focused and full standard invocations with --test-force-exit exited successfully.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved the forced Claude OAuth usage GET through a private Rust one-attempt service using the shared Codex HTTP core. Node retains credential lifecycle, retries, parsing, history and normalization. Offline fixtures verify fixed headers, status/error behavior, token redaction, refresh token rotation, and FIFO header-deadline accounting. Full Rust and Node suites, focused checks, lint, release build, formatting, and independent review passed.
<!-- SECTION:FINAL_SUMMARY:END -->
