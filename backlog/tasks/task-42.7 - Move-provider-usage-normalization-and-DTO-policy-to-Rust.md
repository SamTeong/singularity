---
id: TASK-42.7
title: Move provider usage normalization and DTO policy to Rust
status: Done
assignee: []
created_date: '2026-10-21 23:52'
updated_date: '2026-10-22 02:23'
labels: []
dependencies:
  - TASK-42.6
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-usage-normalization-design.md
modified_files:
  - rust/backend/src/provider_usage.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/usage.mjs
  - server/index.mjs
  - server/usage.test.mjs
  - server/provider-usage-bridge.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The provider usage card combines three existing sources, and their normalization currently lives only in Node even though the production daemon is migrating service policy to the shared Rust backend. Move the existing Claude, Codex, and Ollama result normalization into a typed Rust operation that the live asynchronous provider flows call. Keep Node-owned credentials, fetch/scrape, persistence, caching, identity, gates, scheduling, and routes in place. Preserve the HTTP/WS and provider result shapes, including JS null/coercion edge cases. Design and implementation sequence: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-usage-normalization-design.md. Start only after TASK-42.6 settles the shared bridge files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The live Claude snapshot and OAuth paths, Codex live path, and Ollama parsed-data path use a registered typed Rust bridge normalizer; no unused Rust-only module remains.
- [x] #2 Rust parity cases cover missing versus null values, unstarted/reset windows, model splits, extra usage fallback, Codex duration/coercion and weekly-only windows, and Ollama DTO flags while preserving current property presence and value behavior.
- [x] #3 The existing /usage HTTP and WS usage-document contracts, local-first refresh order, stale behavior, cache/account fingerprint policy, and provider error outcomes remain compatible; routes, credential handling, history, and scheduling remain Node-owned.
- [x] #4 Rust unit tests and focused Node bridge/usage-flow tests verify parity, including bounded normalizeClaude/readClaudeLocal callers and async local snapshot handling.
- [x] #5 Focused Rust tests, isolated release build, cargo fmt check, focused Node tests, and lint pass on Windows using the isolated target and all three Rust binary overrides recorded by TASK-42.6.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Repeat bounded caller audit and inspect finalized bridge wiring. 2. Implement Rust normalization, bridge dispatch, production injection, and parity tests. 3. Run assigned focused tests, isolated release build, fmt check, and lint; record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Review repair: JS Number coercion throws for JSON objects with an own non-callable toString, including such objects reached while converting arrays; ordinary {} still coerces to NaN. Standalone original-runtime oracle saved at C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/provider-number-oracle.log. Groma reports no owner for rust/backend/src/provider_usage.rs; no architecture reference was added.

Added Rust regressions for own-toString errors at Claude session/model/extra/spend and Codex duration/reset-after coercion points, array and nested-array element conversion, plus ordinary-object NaN. Next add spawned bridge assertions for error propagation and the ordinary-object success control.

Review-blocker repair is source-frozen. Final focused evidence: cargo test --release --manifest-path rust/backend/Cargo.toml provider_usage::tests (8 passed, native exit 0); cargo build --release --manifest-path rust/backend/Cargo.toml (native exit 0); cargo fmt --check --manifest-path rust/backend/Cargo.toml (native exit 0); node --test --test-force-exit server/provider-usage-bridge.test.mjs server/usage.test.mjs (62 passed, native exit 0); pnpm lint (native exit 0). Logs: provider-number-rust-test.log, provider-number-release-build.log, provider-number-cargo-fmt.log, provider-number-node-test.log, provider-number-lint.log in C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b. No architecture element owns rust/backend/src/provider_usage.rs per groma view; task ref addition remains unavailable.

Final acceptance: all eight reviewed source hashes match the accepted receipts; implementation and repair VERIFY anchors count once each. Corrected serial Rust suite exited 0 with 168 library and 3 daemon tests passing (0 doc tests); corrected full Node suite exited 0 with 698 total, 696 passed, 2 skipped, 0 failed. Earlier acceptance launch failures were environment-only: wrong Rust working directory, then Node test HOME/toolchain discovery and global USAGE_REPORT_STATE; corrected launchers resolved them without source changes. Focused Rust 8, focused Node 62, release build, fmt check, lint, and diff check passed per recorded receipts. Scope remains normalization only; TASK-42.8 owns snapshot persistence/local reads.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Claude, Codex, and Ollama usage normalization into the typed Rust bridge while keeping provider fetch, credentials, persistence, cache, identity, scheduling, and routes in Node. Verified by the focused Rust and Node checks plus corrected full serial Rust and Node suites; all eight reviewed source hashes match.
<!-- SECTION:FINAL_SUMMARY:END -->
