---
id: TASK-43
title: Move Claude OAuth refresh credential persistence to Rust
status: Done
assignee:
  - '@codex'
created_date: '2026-10-22 12:54'
updated_date: '2026-10-22 13:20'
labels: []
dependencies:
  - TASK-42.15
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-credential-write-design.md
modified_files:
  - rust/backend/src/claude_credentials.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
priority: high
type: feature
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude OAuth refresh still writes credential JSON through Node. The filesystem effect belongs in the private Rust credential service, while JavaScript must retain parsing, object merge, serialization, and the established error boundaries. The earlier read migration task must finish first. See the linked design for the exact baseline behavior and Windows/Unix limits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Refresh persistence sends Node-serialized JSON through a private credential-specific Rust bridge operation using the configured credentials path and exact Node PID-derived temp path.
- [x] #2 Rust preserves temp write, rename, direct-write fallback, boolean result, mode 0o600 behavior where supported, and does not add cleanup or parent-directory creation.
- [x] #3 Node retains JSON parse/spread/assignment/stringify semantics and the baseline read, merge, serialization, writer-failure, refresh, and CLI fallback boundaries.
- [x] #4 Offline scratch tests cover rotation and sibling fields, existing destination replacement, temp/rename fallback, direct-write failure, path identity, and no credential logging.
- [x] #5 Focused and full Node checks, lint, and Rust tests pass; Windows behavior and POSIX permission-bit limitations are documented.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement credential-only Rust write, bridge request adapter, Node persistence handoff, offline synthetic tests, and Rust formatting; leave execution checks to the delegated runner.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation slice: added a credential-specific Rust temp-write/rename/direct-write helper, private bridge operation, and Node persistence adapter preserving Node JSON and rejection boundaries. Added synthetic bridge and usage coverage for exact payload/path, rotation and sibling fields, writer false/rejection, Rust fallback outcomes, replacement, and Unix private mode. cargo fmt completed. No test/build commands run in this implementation lane; delegated runner owns validation.

Finalization evidence: independent reviewer accepted TASK-43 and the final acceptance receipt is accepted. Original receipt SHA-256 3280B8D36C30B5E09D905B8027B323D4F4B7011205E402499DD0DF5A4C814326 binds all seven checks: fmt, 202 library + 3 daemon Rust tests, release build, focused Node (104 passed/2 skipped), full Node (718 passed/2 skipped), lint, and diff-check. The post-repair receipt SHA-256 445BCD36ACA2987F2860634D8DEB0144A525DCDBFB3B586C6474DFE0AB713CAC binds fmt, five focused claude_credentials Rust tests, and diff-check; unchanged source hashes match the accepted receipt. The Unix cfg(unix) mode test is written but was not executed on Windows; no POSIX ACL claim is made for Windows. Linux/macOS runtime checks remain with TASK-42.2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved OAuth credential file writes into a credential-specific Rust bridge operation while preserving Node merge and serialization behavior. Independent review accepted the implementation; the original seven-check receipt and post-repair three-check receipt passed with matching source hashes. The Unix mode test was not run on Windows, and no Windows POSIX ACL guarantee is claimed.
<!-- SECTION:FINAL_SUMMARY:END -->
