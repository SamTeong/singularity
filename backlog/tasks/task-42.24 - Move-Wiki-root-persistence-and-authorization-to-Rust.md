---
id: TASK-42.24
title: Move Wiki root persistence and authorization to Rust
status: Done
assignee: []
created_date: '2026-10-25 06:12'
updated_date: '2026-10-25 08:25'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/spec-wiki-root-persistence.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/probe-wiki-node-runtime.notes.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/probe-wiki-http-runtime.notes.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/probe-wiki-root-parity.notes.md
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-wiki-validation-runner.notes.md
modified_files:
  - rust/backend/src/lib.rs
  - rust/backend/src/wiki_root.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/wiki-routes.mjs
  - server/index.mjs
  - server/wiki.mjs
  - server/wiki.test.mjs
  - server/rust-backend.test.mjs
  - server/wiki-routes.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 72000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Wiki root preference, authorization policy, and capability probe still perform filesystem-dependent work in Node. Move that small service boundary into the Rust daemon while keeping the browser-facing HTTP contract and existing traversal/search behavior stable. The root preference accepts any non-empty JavaScript string, including whitespace, NUL, and unpaired UTF-16 code units, so transport must keep the root as a raw JSON string leaf and serialize it directly rather than through serde_json::Value. See the linked runtime probe receipts and finalized design for measured behavior and explicit unmeasured gates.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns wiki-root JSON persistence and defaulting: missing, malformed, non-object, missing/empty/non-string root states return ~/wiki; duplicate root keys use the last value; valid non-empty strings preserve their UTF-16 code units, including NUL and lone/mixed surrogates. Raw serde parser probes cover duplicate keys, numeric overflow both in root and ignored extra fields, unpaired strings, extra fields, and request-envelope handling before integration; inputs accepted by the current Node parser remain tolerated.
- [x] #2 The private bridge exposes root get/set, authorization, and availability operations with an explicit absolute STATE_DIR/wiki-root.json path and Node homedir value on each operation; invalid setter values still return {ok:false,error:'bad root'}, root-file reads that fail or contain invalid root state retain the ~/wiki default, and root-file write failures expose native Rust I/O error text.
- [x] #3 Rust authorization matches the persisted root after tilde expansion and Windows case-insensitive normalization, then applies lexical path containment and case-insensitive .md suffix checks; traversal and sibling-prefix escapes are rejected, the ordinary directory root is rejected, and an outside-pointing symlink lexically inside the root remains accepted. Preserve check order for an unusual .md-named root path. Invalid filesystem representations fail closed before content read.
- [x] #4 Capability availability is true only when the selected root exists and has an immediate non-hidden directory child; missing roots, files, empty roots, hidden-only children, and read errors are false.
- [x] #5 GET/PUT /wiki/root, GET /wiki/file, and /capabilities.wiki.available retain the characterized response bodies, validation/type errors, and status mappings. Production route handlers are extracted or registered through one reusable seam used by server/index.mjs and direct Fastify inject tests; copied handler bodies are not used as the integration test target.
- [x] #6 Focused Rust module/bridge and Node route tests cover measured compatibility edges and filesystem failures, preserve existing Wiki traversal/search contracts, and pass the exact scoped Windows acceptance runner and focused build/test gates named in the finalized design.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement raw-aware Wiki root persistence, authorization, and capability module with focused module tests. 2. Leave bridge and HTTP integration to later stages. 3. Validate through the guarded runner in the integration lane.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Stage 1 implementation started in the Rust module. This worktree CLI accepts TASK-42.24 (not the shorthand TASK42.24).

Acceptance evidence: wiki-full-acceptance run-20261025T082154215Z completed all Windows gates with status ok and cleanup complete; pinned HEAD matched; 422 frozen inputs were unchanged; 276 Rust tests and 744 Node tests passed (2 skipped), with build, bridge probe, fmt, lint, and suites exit 0. Linux/macOS remain a separate TASK-42.2 gate. The original intermittent persistence assertion remains unexplained; later passes do not establish cause or prove non-recurrence.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Wiki root persistence, authorization, and availability into Rust while retaining the HTTP contract and reusable production route tests. Verified by the pinned Windows acceptance run: build, actual-binary bridge probe, formatting, lint, 276 Rust tests, and 744 Node tests passed (2 skipped); all 422 frozen inputs remained unchanged. Linux/macOS validation remains in TASK-42.2. The earlier intermittent persistence assertion's cause is unproven.
<!-- SECTION:FINAL_SUMMARY:END -->
