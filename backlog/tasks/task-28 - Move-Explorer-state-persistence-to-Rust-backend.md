---
id: TASK-28
title: Move Explorer state persistence to Rust backend
status: Done
assignee: []
created_date: '2026-10-20 08:46'
updated_date: '2026-10-20 08:58'
labels: []
dependencies: []
modified_files:
  - server/explorer.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/src/explorer_state.rs
  - server/explorer.test.mjs
  - server/rust-backend.test.mjs
priority: medium
type: enhancement
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Explorer UI state currently reads and writes its JSON file synchronously in Node. Keeping that state in the native backend removes the Node file owner while preserving the existing GET/PUT contract and fresh disk reads.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET returns defaults on missing or malformed storage without repairing the file, and preserves valid stored unknown keys and wrong-typed values.
- [x] #2 PUT merges only recognized valid patch fields into current stored state, filters and caps arrays, preserves stored unknown keys, and persists even for no-op patches.
- [x] #3 Rust backend owns the fixed explorer-state.json path under SINGULARITY_HOME state; Node delegates both read and write through the serialized bridge queue.
- [x] #4 Isolated tests cover defaults, malformed fallback, merge/filter/caps, external edits, persistence errors, Rust state behavior, and bridge GET/PUT.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement Rust-owned Explorer state read/merge/write and bridge operations. 2. Delegate GET/PUT state routes and add isolated state and bridge tests. 3. Run the required Rust format/tests/build, focused Node tests, lint, full tests, and diff check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented Rust-owned Explorer state persistence and Node bridge delegation. Validation: cargo fmt -- --check passed; cargo test explorer_state::tests -- --test-threads=1 passed (5/5); cargo build --release passed; node --test server/explorer.test.mjs passed (12/12); targeted Rust bridge Node test passed (1/1); pnpm lint passed; pnpm test passed (642 passed, 2 skipped). Full cargo test had one unrelated codex_config_write stale-mtime assertion failure (62 passed, 1 failed). Accepted compatibility deviation: astral Unicode top-level JSON strings are spread by Rust Unicode scalar value, unlike JavaScript UTF-16 code-unit indices.

Independent review passed with no blockers and confirmed all four acceptance criteria. Accepted user deviation: when valid stored state is a top-level JSON string containing astral Unicode, Rust spread indexes Unicode scalar values (one emoji at key 0), unlike JavaScript UTF-16 code-unit indices (keys 0 and 1); custom surrogate serialization was intentionally omitted. The complete cargo test run recorded earlier had 62 passes and one failure in unrelated codex_config_write::tests::writes_utf8_empty_content_checks_stale_force_and_missing_parent at line 115: a successful write violated the fabricated stale-mtime assumption. The reviewer reran that test narrowly; it passed (1 passed, 62 filtered). The full Rust suite was not rerun and is not claimed passing. Explorer state focused Rust tests passed 5/5, release build passed, focused real-bridge Node test passed 1/1, Explorer Node tests passed 12/12, pnpm lint passed, and full pnpm test passed 642 with 2 skipped.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Explorer UI state reads and writes into the Rust backend while preserving the GET/PUT response contract. Verified all four acceptance criteria with the focused Rust state tests (5/5), release build, Explorer tests (12/12), real bridge test (1/1), lint, and full Node suite (642 passed, 2 skipped). The complete Rust suite had one unrelated Codex stale-mtime fixture failure (62 passed, 1 failed); the reviewer reran that test narrowly and it passed. The accepted astral-string scalar-index difference is documented.
<!-- SECTION:FINAL_SUMMARY:END -->
