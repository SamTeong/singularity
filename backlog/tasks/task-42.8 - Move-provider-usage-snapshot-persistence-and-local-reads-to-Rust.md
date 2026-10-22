---
id: TASK-42.8
title: Move provider usage snapshot persistence and local reads to Rust
status: Done
assignee: []
created_date: '2026-10-22 00:11'
updated_date: '2026-10-22 05:53'
labels: []
dependencies:
  - TASK-42.7
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-snapshot-service-design.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-usage-normalization-design.md
modified_files:
  - rust/backend/src/usage_snapshot.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/index.mjs
  - server/usage.mjs
  - server/usage.test.mjs
  - server/provider-snapshot-bridge.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the provider usage snapshot persistence and local file-read contract from Node into the existing shared Rust JSON-lines backend after TASK-42.7. The usage card depends on these local tiers to avoid provider calls, and usage-history consumes the same three configured JSONL files plus Claude's monthly archives. Preserve the existing configured paths, file formats, freshness rules, best-effort write behavior, dedupe/heartbeat policy, and Claude rotation semantics. Keep provider credentials and refresh, normalization, network/browser fetching, cache and identity policy, 429/stale decisions, scheduling, and routes outside this task. Keep usage-history chart attribution and its reader/cache in Node. The configured application write exceptions are documented in `.claude/rules/server.md`; preserve those existing targets without migrating data or changing write ownership. Development verification must use fixture-only roots and must not read or write real external user data.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The live Claude, Codex, and Ollama snapshot append and local JSONL read paths use a registered typed operation on the existing shared Rust backend; Node callers await the bridge, and no snapshot-only Rust module is left unused.
- [x] #2 Ollama and Codex dedupe, Codex five-minute heartbeat, unstarted-window distinction, best-effort append failure, and retry-after-failure behavior match the current implementation.
- [x] #3 Claude monthly rotation preserves first-row local-month selection, hard-link then unlink, archive collision safety, same-inode unlink retry, and retry visibility for malformed heads or filesystem failures; usage-history continues to discover archives and invalidate its existing file-based caches.
- [x] #4 Focused Rust and Node tests use only temporary fixture paths with SINGULARITY_HOME and USAGE_REPORT_STATE isolated, cover the three provider formats plus missing/stale/malformed/rotation/write-failure cases, preserve raw JSON passthrough including escaped UTF-16 surrogate values, and run with all three Rust binary overrides recorded in the linked design.
- [x] #5 Provider JSONL names, exact record shapes, configured path roots, timestamps, and local freshness/tail-read behavior remain compatible: Claude and Codex use the last non-empty tail row and return no snapshot when that row is malformed or stale, while cost-state reads skip unusable fresh candidates and choose the newest usable one; existing account/cache policy remains in Node.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rust-only lane: implement typed explicit-path snapshot storage, local-time/file-identity helpers, and focused temporary-fixture tests in usage_snapshot.rs; export the module. 2. Keep production bridge registration and Node caller activation for the subsequent TASK-42.8 integration step; acceptance criterion 1 and task completion require that integration, review, and all acceptance checks. 3. Run focused Rust tests and cargo fmt check with the isolated MSVC toolchain.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Repairing review findings: ISO snapshot timestamp coercion now handles partial/expanded forms, canonical millisecond UTC output is being enforced, and fixture directories use atomic create/retry. Groma reports no architecture owner for rust/backend/src/usage_snapshot.rs; no architecture reference was added.

Rust blocker repair slice now includes 2026-10, signed expanded UTC date/datetime, invalid -000000 and TimeClip fixtures, canonical .mmmZ formatting assertions, and atomic create_dir/retry temp fixtures. Changes remain in rust/backend/src/usage_snapshot.rs; Groma has no owner mapping for this file.

Focused test first run compiled the Rust module, passed 10/11 snapshot tests, and identified a partial-ISO fixture mismatch. Added a direct parser assertion to isolate the observed value; focused verification is being rerun after that test-only edit.

Second focused run isolated the bug: Rust string slicing with get(5..10) rejected the short YYYY-MM input because the end exceeded the source length. Parser now selects a 2- or 5-byte ISO date suffix before extracting the rest. Focused test will be rerun after this code fix.

Applied rustfmt after focused Rust tests passed; rerunning the focused suite against the formatted final source before recording the Rust-fix milestone. Production bridge and Node integration remain for the next lane.

Postrepair acceptance runtime evidence (2026-10-22): the source-mtime month-boundary bridge test passed 1/1 with all three Rust binary overrides; serial Rust passed 180 library + 3 binary tests (doc tests 0); pnpm test passed 698/700 with 0 failures and 2 unrelated pre-epoch filesystem skips; pnpm lint exited 0. Fixture-only SINGULARITY_HOME was used, inherited USAGE_REPORT_STATE was unset, and HOME/USERPROFILE/CARGO_HOME were unchanged. Full acceptance receipt: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/accept-snapshot-postrepair.notes.md

Finalization 2026-10-22: independent production review and source-mtime re-review passed; all eight accepted source hashes matched the post-repair receipt. Post-repair evidence: serial Rust 180 library + 3 binary passed; pnpm test 698 passed, 2 unrelated pre-epoch skips; pnpm lint exit 0; focused mtime bridge regression passed. Groma has no enabled scanner owner for rust/backend/src/main.rs or server/usage.mjs, so architecture references remain incomplete and no IDs were invented.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved provider usage snapshot appends and local reads through the typed shared Rust backend while keeping history archive selection and cache ownership in Node. Independent review and mtime re-review passed; all five acceptance criteria are checked against post-repair full Rust/Node/lint and focused mtime evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
