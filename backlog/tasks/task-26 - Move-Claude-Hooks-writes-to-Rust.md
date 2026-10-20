---
id: TASK-26
title: Move Claude Hooks writes to Rust
status: Done
assignee: []
created_date: '2026-10-20 08:03'
updated_date: '2026-10-20 08:25'
labels: []
dependencies: []
modified_files:
  - server/hooks.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/lib.rs
  - server/hooks.test.mjs
  - server/rust-backend.test.mjs
  - rust/backend/src/hooks_write.rs
type: feature
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Claude Hooks editor currently writes hook files in Node after validating configured hook-root containment and backing up existing bytes. Move only the final file write into the shared queued Rust backend while preserving Node authorization, backup behavior, conflict responses, and the existing Hooks API contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Only paths authorized by the existing Node hook-root guard reach the native writer; rejected paths do not invoke it.
- [x] #2 Node checks mtime before backup and after the awaited backup; stale writes return the existing conflict result without a new backup.
- [x] #3 Rust checks the supplied mtime after queue wait immediately before writing, writes UTF-8 including empty content, honors force, and does not create missing parents.
- [x] #4 Successful Hooks PUT responses retain {ok:true,backup,path,mtime}; stale writes remain HTTP 409 and other write errors remain generic HTTP 400.
- [x] #5 Focused Node and Rust tests cover authorization, backup ordering, bridge coercion, final stale guard, and absent-parent behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve the Node hook-root guard and backup sequence while delegating the actual write to Rust. 2. Add queued bridge dispatch and a Hooks-specific Rust final mtime guard/write. 3. Add focused Node bridge/route and Rust tests. 4. Run Rust checks, rebuild the release binary, then focused Node tests, lint, and the full Node suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation evidence: cargo fmt --manifest-path rust/backend/Cargo.toml -- --check passed; cargo test --manifest-path rust/backend/Cargo.toml passed (56 Rust tests); scripts/build-rust-backend.mjs release build passed; focused Node tests server/hooks.test.mjs and server/rust-backend.test.mjs passed (24 passed, 2 platform skips); pnpm lint passed; pnpm test passed (637 passed, 2 platform skips). The first focused run exposed an incorrect test expectation that the first backup would be null for a pre-existing source; corrected the assertion to verify original bytes, then reran successfully. Groma reported no owner for server/hooks.mjs and rust/backend/src/main.rs; all edited paths are recorded as modified files. No agent identity was provided, so this task remains unassigned.

Review repair: deferred non-string Hooks content rejection until after Node pre-mtime check, awaited best-effort backup, and post-backup mtime recheck. Added stale-invalid precedence and matching-mtime backup/no-backend regression checks in server/hooks.test.mjs. Focused Hooks+bridge tests: 24 passed, 2 existing pre-epoch filesystem skips; pnpm lint passed. Full Node/Rust suites are carried forward from implementation stage and were not rerun for this ordering-only repair.

Final acceptance review: checked AC 1, 2, 3, and 5 from the final implementation, production-order repair, isolated backup-fixture test, and passing review. AC 4 remains unchecked because no HTTP route probe was run; the handler mapping and service result contract were inspected, but end-to-end serialization is unverified. Final verification chronology: Rust suite 56 passed, formatting, release build, lint, and full Node suite 637 passed with 2 known Windows filesystem skips passed before the localized production ordering repair; after that repair the focused suite passed 24 with 2 known skips and lint/diff-check passed; after the test-fixture-only correction the targeted test passed 1 with no skips and diff-check passed. No green checks were rerun during finalization. No live HTTP probe or forced queued-delay test was run.

AC 4 reconciliation: checked based on the exact criterion's contract-compatibility requirements. server/hooks.test.mjs:67 asserts the successful service result keys backup, mtime, ok, and path; server/hooks.mjs:113-118 preserves changed-on-disk conflicts, converts other backend failures to the generic hook write failed result, and returns the backend success result with backup and authorized absolute path; server/index.mjs:647-649 maps changed-on-disk to HTTP 409 and all other write failures to HTTP 400, then returns the service result. The independent reviews accepted this unchanged route mapping plus service/bridge tests and recorded the lack of a runtime HTTP probe as a known limit, not a blocker. AC 4 requires contract compatibility and does not specify an HTTP runtime probe; no live or isolated route probe was added.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved the final authorized Hooks file write into the queued Rust backend while preserving Node root authorization, backup ordering, stale conflict handling, and the Hooks API contract. All 5 acceptance criteria are checked: focused Node/Rust tests cover authorization, backups, bridge semantics, and stale writes; server/hooks.test.mjs asserts the success response keys, while the unchanged route maps stale errors to HTTP 409 and other errors to HTTP 400. Rust 56 passed, full Node 637 passed with 2 known Windows filesystem skips, lint and release build passed before the localized production ordering repair; focused Node 24 passed with 2 known skips and lint passed after it; the final isolated backup regression passed 1 test.
<!-- SECTION:FINAL_SUMMARY:END -->
