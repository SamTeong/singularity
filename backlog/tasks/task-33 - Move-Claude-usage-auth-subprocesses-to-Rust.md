---
id: TASK-33
title: Move Claude usage auth subprocesses to Rust
status: Done
assignee: []
created_date: '2026-10-20 11:44'
updated_date: '2026-10-20 12:05'
labels: []
dependencies: []
modified_files:
  - server/usage.mjs
  - server/chat.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/usage_auth.rs
  - server/usage.test.mjs
  - server/chat.test.mjs
  - server/rust-backend.test.mjs
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The usage service invokes macOS Keychain and Claude auth status directly from Node. Move those subprocess calls behind the existing Rust backend while keeping credential interpretation, OAuth refresh, persistence, and gateway behavior in Node.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Usage credential lookup preserves nullish file precedence, expiry filtering, and null behavior for Keychain failures; callers await the bridge.
- [x] #2 Auth status fallback keeps grant-first behavior, shared throttle, configured absolute binary, timeout, and true-after-attempt semantics.
- [x] #3 Stub-based tests cover platform, malformed/empty/process failure, file bypass, refresh fallback, and secret redaction without invoking real auth commands.
- [x] #4 Rust formatting, checks, tests, release build, focused Node tests, and required project lint/full tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory direct OAuth/account-fingerprint callers and existing Rust bridge/process utilities within the bounded scope. 2. Add narrowly scoped Rust operations and bridge methods for darwin Keychain lookup and Claude auth status; propagate async token lookup to chat and usage consumers. 3. Add synthetic stub tests for parity and credential secrecy. 4. Run Rust checks/tests, build release before Node bridge tests, then focused tests and project lint/full suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented Rust-backed Keychain lookup and auth-status invocation with Node retaining credential interpretation, refresh, persistence, and gateway behavior. Preserved original nullish file precedence: a present credential object without accessToken returns null without Keychain fallback; absent/unreadable files may fall back. Post-repair verification: cargo fmt --check, cargo check, cargo test (78 passed), cargo build --release, focused Node tests (90 passed, 2 skipped), pnpm lint, and git diff --check passed. Full pnpm test passed earlier (668 passed, 2 skipped) before the narrow precedence/redaction repair and was not repeated per review instruction. No live auth commands or daemon restart.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved usage Keychain and Claude auth-status subprocesses behind the Rust backend while preserving Node credential and refresh behavior. Verified with Rust formatting/check/tests/release build, focused Node tests, lint, and full project tests (full suite preceded the narrow final repair).
<!-- SECTION:FINAL_SUMMARY:END -->
