---
id: TASK-19
title: Migrate model pricing GET to Rust
status: Done
assignee:
  - '@sate'
created_date: '2026-10-20 04:59'
updated_date: '2026-10-20 05:28'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/model_prices.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/Cargo.toml
  - rust/backend/Cargo.lock
  - server/model-prices.mjs
  - server/usage-history.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - server/model-prices.test.mjs
  - server/rust-backend.test.mjs
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move GET /api/models/prices parsing and normalization into Rust while Node retains path authority and all PUT validation and writes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust receives the Node-selected absolute pricing.json path, performs no file writes, and distinguishes child transport failure from invalid-file fallback.
- [x] #2 GET preserves the bare normalized response for absent, unreadable, corrupt, legacy, and layered pricing files; async callers are updated and PUT behavior is unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Parse pricing.json with serde_json arbitrary_precision and preserve_order to match the retained Node normalizer for supported values and duplicate properties. 2. Route GET through Rust using the absolute path selected by Node; retain Node-owned PUT validation/writes and synchronous usage-history normalization. 3. Verify Rust and real release-child parity, lint, formatting, release build, and the full Node suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finishing resumed partial migration; first action is Windows MSVC Rust test compile. Preserving explicit-path read, Node PUT, and synchronous usage-history adapter. No live daemon probes or mock fixture changes.

Rust compile exposed an unconstrained deserializer error type. Fixed it and removed the u64 cap from positive integral threshold normalization so finite JS integer-valued numbers such as 1e30 survive. Added Rust sentinel for numeric keys, duplicate values, and threshold parity.

The bridge reconstructs insertion order in a JavaScript object. Used defineProperty for copied keys so the valid JSON key __proto__ remains an own enumerable rate entry, matching JSON.parse/object spread semantics instead of mutating the prototype.

Extended the real child-process bridge test to compare returned normalization against the retained synchronous Node adapter, and assert configured absolute path, JS integer-key enumeration, duplicate-key value behavior, __proto__ ownership, and 1e30 threshold parity.

First correctly executed full Rust test run compiled and ran 37 tests; found parallel fixture directory collisions and a Rust assertion that confused JSON integer-equivalence with preserving the parsed 12.0 token. Made temp fixture names process-unique and aligned the assertion with the retained numeric representation.

cargo fmt --check identified Rust formatting only; applied cargo fmt to the new pricing module.

Verification complete: cargo test passed 37 library tests with zero filtered (binary/doc targets zero); cargo fmt --check passed; cargo release build passed; pnpm lint passed (eslint .); pnpm test passed 619/619, including real release-child pricing bridge test. Task stays In Progress and acceptance criteria unchecked pending independent review. Live daemon and Vite were not restarted or probed.

Independent review found three blockers: unused join import in server/model-prices.mjs; serde_json rejects overflow exponents even in ignored nested fields; and base-key order uses the first duplicate top-level base property. Repair approach: use existing serde_json features preserve_order and arbitrary_precision, allowing serde_json Value to retain JS object insertion order, last-wins duplicate values, and raw exponent values; normalize references with existing logic. This adds no crate dependency beyond feature-required lock resolution. Groma reports no enabled owner for touched pricing source files; preserve that existing no-owner gap.

Review repair outcome: removed the unused path join import; enabled serde_json arbitrary_precision and preserve_order and accepted the feature-required Cargo.lock indexmap dependencies; switched pricing input to ordered serde_json Value so exponent overflow, nested ignored values, and duplicate-property semantics match Node normalization; added Rust and real release-child parity regressions. Final verification: cargo test passed 38 library tests (0 failed/ignored/filtered), binary/doc targets 0; cargo fmt --check passed; cargo release build passed without warnings; pnpm lint passed (eslint .); pnpm test passed 619/619, 0 skipped; git diff --check passed. An earlier fmt check caught two formatting lines; cargo fmt corrected them before the final successful check. No live daemon/Vite probe. Task remains In Progress with acceptance criteria unchecked pending re-review.

Independent final review passed with 0 blockers and 18 unique verification anchors. Evidence: final Rust suite passed 38 tests; release build and rustfmt check passed; pnpm lint passed; pnpm test passed 619 tests; git diff --check passed. Accepted deviation: serde_json arbitrary_precision + preserve_order adds four transitive locked crates (indexmap, equivalent, hashbrown, foldhash), replacing the custom visitor to preserve tested Node parsing/order behavior. No live daemon or Vite restart/probe was performed. Groma has no enabled source owner for these pricing paths and no architecture ref was available.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved model pricing GET parsing and normalization into Rust while keeping Node path authority, PUT writes, and synchronous usage-history behavior. Independent review passed; verified with 38 Rust tests, release build, rustfmt check, pnpm lint, and 619 Node tests.
<!-- SECTION:FINAL_SUMMARY:END -->
