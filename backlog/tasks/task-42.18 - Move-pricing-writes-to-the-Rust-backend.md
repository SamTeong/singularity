---
id: TASK-42.18
title: Move pricing writes to the Rust backend
status: Done
assignee:
  - '--plan'
created_date: '2026-10-24 00:58'
updated_date: '2026-10-24 02:08'
labels: []
dependencies:
  - TASK-42.12
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/pricing-write-design.md
modified_files:
  - rust/backend/src/model_prices.rs
  - rust/backend/src/main.rs
  - server/model-prices.mjs
  - server/rust-backend.mjs
  - server/index.mjs
  - server/model-prices.test.mjs
  - server/rust-backend.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 66000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The completed pricing GET migration (TASK-19) left PUT persistence in Node, so pricing.json remains a Node-owned application write. Move that write through the existing Rust daemon after TASK-42.12, preserving the configured server-selected path and current JavaScript validation and response behavior. Keep the synchronous pricing reader used by usage-history. See pricing-write-design.md for the bounded seven-file contract and compatibility choices.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns pricing.json persistence; Node no longer creates directories or writes the pricing file.
- [x] #2 The writer only receives the absolute path selected by server configuration; HTTP input cannot choose the destination.
- [x] #3 Existing JavaScript validation behavior and ordering remain unchanged; invalid requests do not call Rust and leave existing file bytes or absent state unchanged.
- [x] #4 Successful writes recursively create missing parents, preserve the two-space JSON serialization, return the normalized document only after write completion, and remain direct non-atomic overwrites.
- [x] #5 Writer failures retain PUT HTTP 400 with an {error: message} body; GET retains its existing behavior. Error text may use the established Rust OS-error formatting.
- [x] #6 Focused and full regression coverage preserves pricing GET and the synchronous usage-history reader.
- [x] #7 Offline deterministic fixtures cover configured-path isolation, serialization, error mapping, completion/await behavior, validation rejection, and GET regressions; Windows isolated runtime validation exercises the configured state root without live services or provider data.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add the Rust pricing writer and bridge operation. 2. Keep JavaScript validation and await the correlated write. 3. Add fixture coverage for write semantics and existing reads. 4. Format only the two Rust files. Verification is recorded in receipt 79F44D7B1EB1E94DE995B53B7AB58EDD1AB0800A90CF4142CC7A1513ECF4F512.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Completed the Rust pricing writer, configured-path bridge, JavaScript handler integration, and fixture coverage across the seven listed source files. Accepted verification: 5 reused checks and 2 fresh checks; Node 728 passed / 2 skipped; Rust 239 library and 3 main tests; focused Node 44 passed / 2 skipped. Receipt 79F44D7B1EB1E94DE995B53B7AB58EDD1AB0800A90CF4142CC7A1513ECF4F512 records matching frozen inputs, offline fixtures, no live ports or service restarts, and pinned backend binary. Compatibility limits retained and user informed: direct overwrite is non-atomic, inherited default_key behavior and __proto__ behavior are preserved. GET and synchronous usage-history reader remain covered.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved pricing persistence to the Rust backend using only the server-configured absolute path while retaining JavaScript validation, GET behavior, and the synchronous usage-history reader. Accepted offline verification: Node 728 passed / 2 skipped, Rust 239 library + 3 main tests, focused Node 44 passed / 2 skipped; receipt 79F44D7B1EB1E94DE995B53B7AB58EDD1AB0800A90CF4142CC7A1513ECF4F512 confirms frozen inputs and no live services.
<!-- SECTION:FINAL_SUMMARY:END -->
