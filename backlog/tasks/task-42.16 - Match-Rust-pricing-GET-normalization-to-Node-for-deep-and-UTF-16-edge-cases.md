---
id: TASK-42.16
title: Match Rust pricing GET normalization to Node for deep and UTF-16 edge cases
status: Done
assignee: []
created_date: '2026-10-22 16:27'
updated_date: '2026-10-23 00:20'
labels: []
dependencies:
  - TASK-47
modified_files:
  - rust/backend/src/transcripts.rs
  - rust/backend/src/model_prices.rs
  - rust/backend/src/main.rs
  - server/rust-backend.test.mjs
parent_task_id: TASK-42
priority: medium
type: bug
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-19 moved pricing GET parsing and normalization into Rust, but production differential probes still show Rust falling back for depth-127/128/129 pricing documents and a base key containing an escaped lone surrogate. Node's UTF-8 file decoding also replaces malformed sequences before JSON parsing, while Rust's current text read rejects them. Repair this reader compatibility gap as the prerequisite to any later pricing-history reader migration. Preserve Node-owned PUT validation and writes, existing bridge reconstruction, defaults, and the exact probe inputs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust GET normalizes the measured nesting depths 127, 128, and 129 to the same pricing result as the retained Node reader.
- [x] #2 An escaped lone-surrogate base key survives raw Rust bridge serialization and JavaScript reconstruction with the same own-key behavior and ordering as Node.
- [x] #3 Malformed UTF-8 bytes inside a quoted key decode as U+FFFD and produce a normalized pricing entry instead of fallback.
- [x] #4 Existing pricing behavior remains compatible for legacy and layered roots, duplicate properties, integer-like ordering, own __proto__, defaults, malformed or unreadable files, and overflowing values; unknown nested fields retain their values.
- [x] #5 The current Node bridge and reader pass the five valid differential cases and malformed-byte case against a newly built binary, with source blob IDs and binary SHA-256 recorded in a fresh probe receipt.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Factor the existing transcript renderer object parser into the narrow ordered token API. 2. Normalize pricing from lossy UTF-8 and raw canonical tokens, then dispatch the successful response as raw JSON. 3. Add focused Rust and bridge regression cases for measured depth, lone-surrogate, and malformed UTF-8 inputs. 4. Freeze source/Cargo hashes and record the implementation; leave all validation commands to the dedicated runner.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final implementation evidence: fresh validated receipt `C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/pricing-read-repair-checks/run-20261023T001326904Z/checks-receipt.json` passed all 8/8 selected steps (exit 0), including production differential 6/6 (normal control, nesting 127/128/129, escaped lone-surrogate key, malformed UTF-8 key); Rust 215 library + 3 binary tests passed, focused Node 44 passed/2 skipped, full Node 728 passed/2 skipped, fmt/build/lint/diff-check passed. The accepted validation record supports AC #1-4 and the runtime part of #5. Before recording Git identities, current SHA-256 digests matched the receipt and frozen control record: `rust/backend/src/transcripts.rs` 80FF930400B97EEFB555F4ED5ED5E2E700EA362B32759D287C1BDFE159F3C526; `rust/backend/src/model_prices.rs` 25B51130D98415EDE5C41313E7811B9229C9D55B86D673195F17F832BA0B54A2; `rust/backend/src/main.rs` B86591C2AD1CCB288FB232BDC07C3F4053710D529AB68ACDF57C68AC76F17FB7; `server/rust-backend.test.mjs` 7EAE2EDEDA6E613B6AF0218AF61D35DB2E1BB892348334ADB0B9EEB3CB707969. Git blob IDs from `git hash-object` (without `-w`), paired with current SHA-256: transcripts.rs 23491ea88155516620528832460a5df77985703c; model_prices.rs 536da5dd007f0075cfab406a5b60e6dc7d068805; main.rs 737f6a5c79df5381b41fc428d922fb5ced3efd59; rust-backend.test.mjs 7f229c4d6189e2e8061f2841e5226b015e9843a1; Node oracle/bridge files also matched receipt: rust-backend.mjs SHA256 ACA45F28A2FD98995D0EE8A2C4BD89A0B4469A30B7BE736127400D33F815EB5B, Git 729c52ccce9079c20ca2aa3e7605a768ec230c5f; model-prices.mjs SHA256 CD131A6A548273B25FAFD7018A187B45C49248F4E0E594AF512AA4F4414DB0B7, Git 4e1a7d9f6c21fb983d94ca45e7c65f775c6ec339; app-dir.mjs SHA256 E1994EA4BF9D9F2645B673C0B843AFAD3B6083FD34FC8F095CEE462A50810937, Git e71f20a11c3e0ce6772f798dc4951ce6c6c712b4. Receipt records release binary SHA-256 BAF1ED0BE496457FCAD1EFC3F987E1D0B56A4CE7EE78AC4B5FC487C03D43FB2B. Git identities supplement receipt content digests; immutable receipts were not changed. No tests/builds were rerun in this finalization step.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rust pricing GET normalization now matches the retained Node behavior across the specified depth, UTF-16, malformed UTF-8, and compatibility cases. Verified by the frozen 2026-10-23 repair receipt (8/8 steps passed, production differential 6/6); its SHA-256 identities are now supplemented with matching Git blob IDs.
<!-- SECTION:FINAL_SUMMARY:END -->
