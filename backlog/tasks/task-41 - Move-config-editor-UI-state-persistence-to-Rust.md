---
id: TASK-41
title: Move config editor UI state persistence to Rust
status: Done
assignee: []
created_date: '2026-10-20 23:48'
updated_date: '2026-10-21 00:02'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/config_state.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/config-state.mjs
  - server/index.mjs
  - server/config-state.test.mjs
priority: medium
type: task
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The config editor's tabs, active file, autosave preference, and expanded roots are durable under the configured state directory but are still persisted by Node. Move this bounded JSON persistence operation behind the existing Rust bridge while keeping Node responsible for resolving the path and retaining the existing HTTP and UI contracts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /config/state and PUT /config/state retain their response shapes and valid object-state merge behavior; malformed, missing, and non-object saved JSON starts from defaults.
- [x] #2 Only JSON objects are restored. Arrays, strings (including emoji and non-ASCII), numbers, booleans, and null reset to defaults rather than spreading indexed properties.
- [x] #3 PUT filtering, empty-string acceptance, tab and expanded caps, partial updates, and error results match the approved object-state contract.
- [x] #4 The Rust bridge uses Node-resolved STATE_DIR, serializes requests through the existing queue, and focused tests cover invalid saved shapes, valid objects, validation/caps, partial merge, concurrency, and write failures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Restrict Rust saved-state loading to JSON objects; use defaults for malformed or non-object values while preserving object extras and wrong-typed fields. 2. Keep existing setter validation, partial merge, caps, Node-resolved path, and queued Rust bridge wiring. 3. Update focused Rust/Node tests for invalid saved shapes including emoji and non-ASCII strings, rebuild the Windows release backend, and run focused bridge checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Groma reported no component/source coverage; no architecture refs exist. User approved on 2026-10-21: saved config state must be a JSON object; arrays, strings (including emoji/non-ASCII), numbers, booleans, null, malformed, and missing files use defaults. Valid objects retain shallow defaults merge, extra keys, and wrong-typed known fields. This intentionally retires primitive JavaScript object-spread behavior. Repair verification: Rust config_state tests 4/4; Windows release backend rebuilt; Node bridge tests 6/6; cargo fmt --check passed. Task remains In Progress pending independent review.

Finalization verification: pnpm lint passed; pnpm test passed (692 passed, 2 skipped, 0 failed); cargo test --manifest-path rust/backend/Cargo.toml passed (99 tests); cargo fmt --manifest-path rust/backend/Cargo.toml -- --check passed on Windows MSVC.

Independent review passed with no findings. TASK-41 finalized as Done after full verification.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved config editor state persistence to the Rust bridge while preserving the HTTP response and validation contracts. Verification passed: pnpm lint, pnpm test (692 passed, 2 skipped), full Rust test suite (99 passed), and cargo fmt --check.
<!-- SECTION:FINAL_SUMMARY:END -->
