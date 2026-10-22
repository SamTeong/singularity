---
id: TASK-42.13
title: Move Claude credential lookup reads to Rust
status: Done
assignee: []
created_date: '2026-10-22 09:32'
updated_date: '2026-10-22 11:57'
labels: []
dependencies:
  - TASK-42.11
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-credential-read-service-design.md
modified_files:
  - rust/backend/src/claude_credentials.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
  - server/index.mjs
  - server/chat.test.mjs
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude usage and chat still resolve the credential file in Node even though the Rust daemon already handles other private service operations. Move only credential lookup reads behind the private Rust bridge so production consumers share one file-read boundary while Node keeps interpreting the raw JSON and applying current auth policy. Credential refresh and its persistence merge read, macOS Keychain, CLI fallback, 401 handling, and authenticated provider requests remain separate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All production credential lookup, fingerprint, and no-credential diagnostic reads use the private Rust bridge; Node retains CLAUDE_CONFIG_DIR and home-path resolution.
- [x] #2 Missing, unreadable, malformed, and valid files preserve file precedence, Darwin Keychain fallback, and existing error classifications.
- [x] #3 Raw JSON interpretation preserves current Node JSON.parse, property access, truthiness, Number, and String behavior; tokens and file contents never enter logs, errors, public routes, or persistent Rust state.
- [x] #4 The refresh/persistence merge read, OAuth refresh, Keychain, CLI fallback, one-time 401 handling, and chat/usage provider calls retain their current ownership.
- [x] #5 Synthetic offline tests cover bridge outcomes, auth lookup/fingerprint consumers, path configuration, malformed/missing data, and token privacy without live credentials or provider calls.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a private Rust operation that reads bytes and returns file/missing/read_failure with UTF-8 replacement. 2. Add a typed private Node bridge method and move async lookup, fingerprint, and failure classification to raw-text JSON parsing while preserving the refresh-only Node read. 3. Use isolated credential fixtures and verify focused Rust/Node behavior plus formatting/build/lint/diff checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation assigned to pointer-implementer; no assignee identity is available.

Implemented the private Rust credential-file read and migrated async lookup/fingerprint/failure classification to its raw-text bridge while retaining the refresh merge read in Node. Added synthetic coverage for fixed outcomes, JS coercions, malformed/null/BOM fallback, auth classifications, and account fingerprint switching. Verification: focused Rust 2/2; focused Node 5/5; Rust fmt check, release build, pnpm lint, and diff --check passed. Full serial Rust and full Node suites remain for the review stage.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Claude credential lookup, fingerprint, and no-credential diagnostic reads behind the private Rust bridge while preserving Node JSON/auth policy and refresh ownership. Verified with focused credential tests, full Rust (196 library + 3 daemon), full Node (711 passed, 2 known skips), lint, formatting, release build, and diff checks; independent review passed.
<!-- SECTION:FINAL_SUMMARY:END -->
