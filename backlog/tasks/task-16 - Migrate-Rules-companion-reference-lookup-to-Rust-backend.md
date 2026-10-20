---
id: TASK-16
title: Migrate Rules companion-reference lookup to Rust backend
status: Done
assignee:
  - '--plan'
created_date: '2026-10-20 03:06'
updated_date: '2026-10-20 03:19'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-next-read.notes.md
modified_files:
  - rust/backend/src/rules.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rules.mjs
  - server/index.mjs
  - server/rules.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rules companion-reference lookup still reads its configured reference tree in Node. Move only GET /api/rules/reference behind the persistent private Rust stdio bridge while keeping Node as public gateway and configured-root owner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/rules/reference preserves success payload shape, HTTP 400/404 mapping, empty-input and missing-companion behavior.
- [x] #2 Rust preserves native basename selection, case-insensitive .md stripping, whole UTF-8-lossy content reads, configured-root behavior, and existing symlink-follow behavior.
- [x] #3 Rust unit and real-child bridge tests cover success, empty input, missing companion, .Md basename, and filesystem failure; existing unrelated Rules Node coverage remains.
- [x] #4 Release build, focused Rust and Node bridge tests, affected lint, rustfmt, and diff checks pass; independent review is required before Done.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. rust/backend/src/rules.rs: new rule_reference op - native basename, case-insensitive trailing .md strip (plans.rs convention), stem + -reference.md under the root passed per request, exists-style no-reference check, whole-file UTF-8-lossy read, ok/path/content and ok:false/error payloads; focused unit tests (success pairing, empty input, missing companion, .Md basename, filesystem failure). 2. main.rs dispatch arm op=rule_reference (path, root); lib.rs pub mod rules. 3. server/rust-backend.mjs: ruleReference(path, root) request method (plans-style per-call root). 4. server/rules.mjs: keep RULES_REF_DIR configured-root ownership, remove Node lookup, add createRuleReferenceHandler(backend, logger) preserving 404/400 mapping; server/index.mjs route switches to it. 5. server/rules.test.mjs: drop the two moved-behavior reference tests, keep unrelated coverage; server/rust-backend.test.mjs: real-child bridge test covering success, .Md basename, missing companion, empty input, read failure, plus gateway 500. 6. Checks: cargo release build and focused tests, node --test rules and bridge, eslint, rustfmt --check, git diff --check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented: added rust/backend/src/rules.rs (find_reference op: native basename, case-insensitive trailing .md strip per plans.rs convention, stem + -reference.md under the per-request root, exists-style no-reference guard, whole-file UTF-8-lossy read, {ok,path,content} payloads) with 5 unit tests; main.rs dispatches op rule_reference; lib.rs exports mod rules. server/rust-backend.mjs gained ruleReference(path, root) (plans-style per-call root). server/rules.mjs keeps RULES_REF_DIR ownership, drops the Node lookup, and exports createRuleReferenceHandler(backend, logger) preserving the 404/400 mapping plus a 500 backend-unavailable path; server/index.mjs routes GET /api/rules/reference through it. rules.test.mjs reference tests replaced by handler mapping tests (200/404/400/500); rust-backend.test.mjs gained a real-child bridge test. Checks: cargo test 23 passed 0 failed; release build ok; node --test rules+bridge+plans+wiki 22 passed 0 failed; eslint exit 0; rustfmt --check clean; git diff --check clean.

Independent review passed all 4 ACs (review-rule-reference.notes.md): cargo test 23/23, focused node rules+bridge 15/15, rustfmt/eslint/diff-check green; anchors 10/10 unique. Accepted deviations: ..//. tails now 400 (unreachable from UI), Rust io error wording with unchanged HTTP mapping, 500 coverage in rules.test.mjs. Minor note: repeated ?path params now 400 instead of Fastify 500.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated GET /api/rules/reference behind the private Rust stdio bridge: new rust/backend/src/rules.rs find_reference (native basename, case-insensitive .md strip, lossy whole-file read, symlink-follow preserved) with 5 unit tests, rule_reference dispatch arm, ruleReference bridge method, createRuleReferenceHandler keeping Node as configured-root owner with unchanged 200/400/404 mapping. Verified: cargo 23/23, targeted node 22/22 (implementer) and 15/15 focused (reviewer), release build, eslint, rustfmt, diff check; independent review passed all ACs with 10/10 unique anchors.
<!-- SECTION:FINAL_SUMMARY:END -->
