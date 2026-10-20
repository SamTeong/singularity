---
id: TASK-15
title: Migrate Plans read services to Rust backend
status: Done
assignee: []
created_date: '2026-10-20 02:44'
updated_date: '2026-10-20 03:05'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-plans.notes.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-design.notes.md
modified_files:
  - rust/backend/src/lib.rs
  - rust/backend/src/plans.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/plans.mjs
  - server/index.mjs
  - server/plans.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Plans browsing reads an externally configured handoff tree from Node while other read domains now use the persistent private Rust child. Move Plans parsing and bounded filesystem reads behind the existing bridge while keeping Node as the authenticated public gateway and platform folder opener.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/plans/sessions and /api/plans/session preserve payload fields, status mapping, disabled-root behavior, and the existing SID validation and realpath containment boundary.
- [x] #2 Rust-backed list/detail parsing preserves direct-child filesystem order, the 300 matching-directory scan cap, 256 KiB prefix reads, plan/status parsing, state fields/nulls, note association, and the 200-note return cap.
- [x] #3 POST /api/plans/open retains Node's platform-specific Explorer behavior and existing status/error mapping using the guarded session resolver.
- [x] #4 Rust unit and bridge tests cover plan parsing, caps, unreadable/missing inputs, malformed state, and configured-root containment; prior Plans tests are meaningfully migrated, not dropped.
- [x] #5 Release build, Rust tests, targeted Plans/bridge/wiki Node tests, affected lint, rustfmt, and diff checks pass; independent review remains required before Done.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a Rust plans-read module and JSON-line dispatch operations for configured-root list and one-session detail reads. 2. Extend the persistent Node bridge with Plans operations while retaining Node's configured-root resolver and platform opener. 3. Replace Node Plans parsing/read algorithms with bridge adapters and preserve route mappings. 4. Migrate/extend tests for service, bridge, and route contracts without changing mock/UI. 5. Record each source path via Backlog CLI, then run requested release, Rust, targeted Node, lint, format, and diff checks; leave the task In Progress for independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Repair in progress: add case-insensitive .Md fallback-title parity and deterministic unreadable/malformed Plans state coverage in Rust and bridge tests.

Repair complete: mixed-case .Md fallback title now matches Node; Rust tests cover missing plan reads, unreadable state directories, malformed state, null/skip behavior, and list continuation; bridge coverage exercises unreadable and malformed state. TASK-15 remains In Progress for independent review.

Independent final pass: pass; the reviewed repair findings are resolved. Focused Rust Plans and real-child bridge tests passed; broader previously reported release/Rust/Node/lint/fmt/diff checks were not repeated in final pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated Plans list/detail reads to the persistent Rust backend while retaining Node route validation and platform open behavior. Acceptance criteria were verified by the implementation checks and independent final pass recorded in review-plans.notes.md; isolated public daemon/auth smoke remains unverified.
<!-- SECTION:FINAL_SUMMARY:END -->
