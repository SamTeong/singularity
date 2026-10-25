---
id: TASK-42.23
title: Move picker-root persistence to Rust with async authorization
status: Done
assignee: []
created_date: '2026-10-25 01:19'
updated_date: '2026-10-25 02:14'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/main.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/picker_roots.rs
  - server/rust-backend.mjs
  - server/config.mjs
  - server/codex-config.mjs
  - server/index.mjs
  - server/rust-backend.test.mjs
  - server/config.test.mjs
  - server/codex-config.test.mjs
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude and Codex picker-root lists are still persisted by Node and also authorize config access. Move both stores behind the Rust bridge while preserving their distinct state files, HTTP behavior, and fail-closed authorization ordering. The focused contract is recorded in C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/spec-picker-roots-persistence.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust exposes only picker_roots_get and picker_roots_set with explicit Node-supplied paths; Claude and Codex remain separate stores.
- [x] #2 Getter and setter preserve arbitrary JSON getter values, JavaScript UTF-16 deduplication, first-50 cap, and exact pretty setter bytes; focused Rust tests cover fallback and storage errors.
- [x] #3 Node picker routes await bridge operations and preserve existing status/body behavior; bridge tests cover explicit paths, malformed responses, and request correlation.
- [x] #4 Claude write authorization and Codex read/write authorization await the Rust store and fail closed before protected IO or backend dispatch; Claude read behavior and Codex scope ordering remain unchanged.
- [x] #5 After source review, the full serial nine-step isolated Windows acceptance is run once and its command outcomes/log tails are recorded.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect current Rust ordinary dispatcher and raw-token storage precedent. 2. Add the focused Rust picker-root store and register two generic explicit-path operations. 3. Add the async Node bridge adapters, await picker routes, and convert Claude/Codex authorization call chains. 4. Add focused Rust, bridge, route, and authorization regression coverage. 5. Run the focused checks and full serial nine-step isolated Windows acceptance; record outcomes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Node integration in progress: picker roots now use two generic async bridge methods with explicit provider-specific state paths, and config root routes use injectable Fastify handler factories. Claude write and Codex read/write authorization await the Rust store; Codex read/search are async. Added async caller coverage and bridge/route tests. Static checks only; tests/build remain reserved for the serial acceptance owner. Groma reports no enabled scanner owner for the four changed server source files, so no architecture ref could be linked.

Static verification completed: node --check exited 0 for all seven assigned Node files; scoped git diff --check exited 0. Runtime tests/build were not run because the serial acceptance owner has them reserved.

Final Node coverage is in place for both production root-handler factories, the falsey and malformed PUT contract, unavailable bridge failures, native storage-error response shape, and fail-closed Claude write/Codex read-write authorization. Source edits are stable; syntax and scoped diff checks passed. Tests/build remain for the assigned serial acceptance owner.

Finalized after the independent picker bridge review and serial native acceptance receipt at C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/picker-roots-acceptance-receipt-binding.json. All nine checks exited 0 with cleanup complete; 396 frozen inputs remained hash-identical at validated HEAD 8d419c70535683950be3375d5624c33c679a86ee.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved separate Claude and Codex picker-root persistence behind the Rust bridge and awaited the store in authorization checks. Verified by the independent bridge review and all nine steps of the serial native Windows acceptance, recorded in the picker-roots receipt binding.
<!-- SECTION:FINAL_SUMMARY:END -->
