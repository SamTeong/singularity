---
id: TASK-40
title: Migrate keyboard shortcut override persistence to Rust
status: Done
assignee: []
created_date: '2026-10-20 23:37'
updated_date: '2026-10-20 23:48'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/keys.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/keys.mjs
  - server/index.mjs
  - server/keys.test.mjs
type: task
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Keyboard shortcut overrides are durable application state and remain implemented in Node. Move their bounded persistence operation behind the existing Rust service bridge while retaining the Node HTTP route and configured state directory ownership.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /keys and PUT /keys preserve their current response shapes and validation, filtering, deletion, merge, insertion order, and first-64 entry behavior.
- [x] #2 Malformed or non-object stored JSON falls back to an empty map; storage failures return the existing error result shape.
- [x] #3 Rust-backed Node adapter uses the existing bridge design and focused tests cover parity and meaningful errors.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect existing keys, bridge, Rust dispatch and tests. 2. Implement Rust persistence operation and bridge adapter using configured Node state path. 3. Verify focused Rust and Node tests; record remaining gaps.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rust-backed GET/PUT persistence and focused parity tests are implemented. cargo test --lib keys::tests passes 3/3; node --test server/keys.test.mjs passes 8/8 through the real Rust bridge. Error results preserve the {ok:false,error} shape; exact Node fs error wording is not guaranteed because Rust reports platform IO text.

Repair/rebuttal: extracted the ID_RE literal from git show HEAD:server/keys.mjs and compared Node regex results with the Rust bridge. Normal ID accepted by both; LF, CRLF, CR, U+2028 and U+2029 suffixes rejected by both. Added malformed JSON syntax fallback assertion; cargo test --lib keys::tests passes 3/3. Reviewer accepted platform-native Rust IO message wording because the API contract exposes a string error without requiring byte-identical Node formatting.

Final review verification: Rust keys tests 3/3, release backend build succeeded, Node bridge tests 8/8, focused ESLint and diff --check passed. Independent review accepted Rust platform-native I/O error text under the string error contract.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved keyboard shortcut override persistence behind the Rust bridge while preserving GET/PUT shapes and validation, merge, deletion, insertion order, and 64-entry behavior. Verified with Rust keys tests (3/3), release build, Node bridge tests (8/8), focused ESLint, and diff --check.
<!-- SECTION:FINAL_SUMMARY:END -->
