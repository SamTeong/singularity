---
id: TASK-45
title: Move Codex account fingerprint to Rust
status: Done
assignee:
  - '@codex'
created_date: '2026-10-22 14:12'
updated_date: '2026-10-22 15:10'
labels: []
dependencies:
  - TASK-44
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/codex-fingerprint-design.md
modified_files:
  - rust/backend/src/codex_account_fingerprint.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/Cargo.toml
  - rust/backend/Cargo.lock
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
priority: high
type: feature
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Codex account identity currently depends on a synchronous Node auth-file read and hash in the usage pull path. Move the read and digest computation behind the Rust service while preserving the explicit configured path, digest-only boundary, existing pre-gate timing, and null/cache semantics. Keep this as a separate service slice from Ollama browser-mode config, forced Claude retry orchestration, and live Codex usage. Synthetic probing found that whole RawValue validation accepts the tested surrogate cases, while the existing String-key RawFields visitor fails on an unrelated surrogate key; implementation must resolve that projection gap without leaking auth JSON or claiming universal JSON.parse equivalence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Rust operation reads only the explicit configured auth path and returns a lowercase SHA-256 digest or null; it never returns auth JSON, account ID, access token, or secret-bearing errors.
- [x] #2 Projection hashes only a nonempty string at the effective tokens.account_id path; malformed/unreadable input, missing fields, empty strings, and non-string values return null.
- [x] #3 Synthetic parity tests cover escaped ASCII property names, last-duplicate-wins behavior at both object levels, nested/array shapes, malformed and trailing input, tested surrogate account strings, unrelated surrogate values, and unrelated surrogate keys; valid tested documents are not silently mapped to null.
- [x] #4 The Node usage pull awaits fingerprint lookup at its existing pre-gate point and reuses the single observed value for invalidation, rate-gate selection, and successful snapshot assignment; null and account-switch behavior remain covered.
- [x] #5 Focused bridge and usage tests prove explicit-path and digest/null contracts with synthetic credentials only, and focused Rust/Node checks plus repository lint/test pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect existing fingerprint behavior; implement digest-only Rust operation and bridge; integrate one awaited pre-gate lookup; add synthetic Rust/Node coverage; record each modified file through Backlog CLI; run cargo fmt --check and diff check only.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Codex account fingerprint lookup into the private Rust bridge and reused its single pre-gate digest across invalidation, rate-gate selection, and successful snapshot assignment. Accepted after independent review; continuation evidence passed focused Node (109 passed, 2 skipped), full Node (723 passed, 2 skipped), lint, and diff-check; reused original fmt, Rust (207 library + 3 daemon), and release-build checks. Nine source hashes matched the continuation receipt. The original Cargo.lock byte transition remains unexplained; final diff adds only the intended direct ring dependency edge.
<!-- SECTION:FINAL_SUMMARY:END -->
