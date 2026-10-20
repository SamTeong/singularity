---
id: TASK-35
title: Restore usage auth subprocess environment parity
status: Done
assignee: []
created_date: '2026-10-20 12:28'
updated_date: '2026-10-20 12:50'
labels: []
dependencies: []
modified_files:
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/usage_auth.rs
  - server/rust-backend.test.mjs
  - rust/backend/src/detached.rs
type: bug
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Rust backend subprocess allowlist omits caller environment entries previously inherited by Node's usage auth subprocesses. This can make auth status inspect a different Claude profile than the Node credential reader. Preserve the bridge's existing environment boundary while forwarding the current Node environment for both usage auth requests and applying it to both nested child commands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 usageKeychain and usageAuthStatus forward the Node process environment through the private bridge
- [x] #2 Rust applies the supplied environment entries to both Keychain and auth-status children while retaining inherited backend values for omitted keys
- [x] #3 Synthetic child tests prove both paths receive a marker environment value and responses expose no marker
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Forward process.env in both Node usage-auth requests and apply supplied env maps in Rust Keychain and auth-status command paths. 2. Add synthetic child and bridge tests for marker forwarding without invoking real auth tools. 3. Run Rust format/tests/release build before focused Node tests, then lint and diff checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented full Node process.env forwarding for usage auth bridge requests and Rust child environment overlays for Keychain and auth status. Groma reports no architecture owner for server/rust-backend.mjs, rust/backend/src/main.rs, rust/backend/src/usage_auth.rs, or server/rust-backend.test.mjs, so no architecture reference applies. Verification: cargo fmt --check; cargo test (83 passed); cargo build --release; node --test server/rust-backend.test.mjs (22 passed, 2 skipped); pnpm lint. Regression proof: with the Rust env overlays temporarily removed, the two new usage_auth marker tests failed (6 passed, 2 failed); overlays restored before final green run.

Additional review repair: synchronized detached_child_probe's read of process-wide SINGULARITY_DETACHED_PROBE/SINGULARITY_DETACHED_VALUE with the existing ENV_LOCK, preventing the parallel spawn test from exposing a partial environment update. cargo fmt --check passed; ordinary parallel cargo test passed 83 tests with 0 failures. No detached production behavior changed.

Finalization: review-auth-env-repair.notes.md passed with no findings; all six VERIFY anchors occur exactly once. Final checks: cargo fmt --check, ordinary parallel cargo test (83 passed), release build, focused bridge Node tests (22 passed, 2 skipped), pnpm lint, and git diff --check. No live daemon or Vite restart; no real credentials used.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Restored Node environment forwarding through both usage-auth bridge paths and applied it to both Rust child commands while preserving inherited values. Synthetic child and bridge tests verify marker delivery and response privacy; all Rust, bridge, lint, format, release-build, and diff checks passed.
<!-- SECTION:FINAL_SUMMARY:END -->
