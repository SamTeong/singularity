---
id: TASK-17
title: Migrate remaining Rules services to Rust backend
status: Done
assignee:
  - '@SamTeong'
created_date: '2026-10-20 03:28'
updated_date: '2026-10-20 03:45'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-next-read.notes.md
modified_files:
  - rust/backend/src/rules.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rules.mjs
  - server/index.mjs
  - server/rules.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Narrowed per user decision and explore-rules.notes.md: move only listRuleFiles (POST /api/rules/files) and searchRules (POST /api/rules/search) behind the persistent private Rust stdio bridge. Roots persistence (rules-roots.json), isRulePath guard, readRuleFile, writeRuleFile + backups.mjs flow stay Node — they are state/config authority, and read's f64 mtime feeds the write guard's 1ms stale tolerance. Keep the already-migrated reference lookup contract unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 POST /api/rules/files and /api/rules/search preserve payload shapes ({files,capped} and {results,capped} with root/path/rel/file and line/text fields), readdir order (no sort), FILE_CAP 2000 / RESULT_CAP 300 early-break semantics, dot-name and SKIP_DIRS skips, and silent root-skip behavior.
- [x] #2 Rust owns the recursive md walk and search with the mtime line cache (exact-mtime recheck per request), case-insensitive substring match on lowercased lines, 1-based line numbers, and UTF-16-code-unit 200-char trimmed snippets (wiki_read.rs utf16_prefix_cover analog); Node stays configured-root owner and public gateway.
- [x] #3 Rust unit tests cover dot-skip, SKIP_DIRS, rel normalization, both caps, empty q, line numbers, snippet trim; real-child bridge tests mirror rust-backend.test.mjs patterns; Node handler tests cover 500 backend-unavailable mapping; unrelated Rules Node coverage (roots/guard/read/write) remains passing.
- [x] #4 Release build, focused Rust and Node tests, affected lint, rustfmt, and diff checks pass; mock untouched (6 disclosed pre-existing mock/daemon drifts stay); independent review required before Done.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add list_files and search fns plus md walk, mtime line cache, utf16 snippet trim to rust/backend/src/rules.rs with unit tests. 2. Add roots field to main.rs Request and rules_files / rules_search arms above the wiki fallthrough. 3. Add ruleFiles and ruleSearch client methods to server/rust-backend.mjs. 4. Rewire listRuleFiles and searchRules in server/rules.mjs as handler factories calling the bridge; Node resolves each root via rulesDir and passes resolved dirs per request; root field stays verbatim raw client string; delete orphaned Node walk and line cache. 5. Swap server/index.mjs route bodies to the factories. 6. Update server/rules.test.mjs handler tests and rust-backend.test.mjs real-child tests. 7. Checks: release build, cargo test, targeted node tests, eslint, rustfmt, git diff --check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented p2.w4.s2 slice: rules_files and rules_search Rust arms (walk + mtime line cache + utf16 cover), ruleFiles/ruleSearch bridge methods, createRuleFilesHandler/createRuleSearchHandler factories with scanRoots per-request resolution (root kept verbatim), routes swapped, orphaned Node walk/lineCache/caps deleted, non-string root guard added in scanRoots, tests migrated: 6 new Rust unit tests, real-child bridge test, 2 handler tests (passthrough/500). All checks green: cargo 29 passed, node 16 passed, eslint clean, rustfmt clean, diff --check clean.

Independent review passed all 4 ACs (review-rules.notes.md): cargo 29/29, node 16/16, rustfmt/eslint/diff-check/build green; 21 VERIFY anchors all exact-count 1. Accepted deviations: non-string root entries now silently skipped (old Node TypeError 500), snippet 200-unit trim Node-side in bridge (wiki convention). Minor non-blocking note: U+FEFF trim edge differs.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated POST /api/rules/files and /api/rules/search behind the private Rust stdio bridge: rust/backend/src/rules.rs gains the recursive md walk (dot/SKIP_DIRS skip, FILE_CAP 2000 early-break, readdir order), search with exact-mtime line cache, case-insensitive substring match, 1-based lines, 200-UTF-16-unit trimmed snippets (Node-side trim, wiki convention), and RESULT_CAP 300; rules_files/rules_search dispatch arms; ruleFiles/ruleSearch bridge methods; createRuleFilesHandler/createRuleSearchHandler keep Node as root-resolving gateway. Roots persistence, isRulePath, readRuleFile, writeRuleFile + backup stay Node. Verified: cargo 29/29, node 16/16, release build, eslint, rustfmt, diff check; independent review passed all ACs with 21/21 unique anchors.
<!-- SECTION:FINAL_SUMMARY:END -->
