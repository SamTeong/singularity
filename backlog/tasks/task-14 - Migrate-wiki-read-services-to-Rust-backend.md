---
id: TASK-14
title: Migrate wiki read services to Rust backend
status: Done
assignee:
  - '@sate'
created_date: '2026-10-20 02:13'
updated_date: '2026-10-20 02:44'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/wiki_read.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/wiki.mjs
  - server/index.mjs
  - server/wiki.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wiki file enumeration, sweep freshness, search, and guarded page reads still run in Node while wiki graph traversal has moved behind the Rust child. Keeping this read domain together preserves one filesystem implementation and lets Node remain the public gateway and owner of the selected wiki-root preference.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/wiki/files and /api/wiki/sweeps preserve current status, JSON shape, ordering, limits, exclusions, and freshness parsing with Rust-backed read logic.
- [x] #2 GET /api/wiki/search preserves query handling, case behavior, ordering, aliases, result fields, the 300-result cap, unreadable-file handling, and meaningful mtime caching.
- [x] #3 GET /api/wiki/file preserves persisted-root equality and shared path containment authorization, status/error JSON, page text, and symlink/traversal behavior.
- [x] #4 Wiki root preference get/set remains owned by Node; public routes/query contracts do not change and Node fallback read algorithms are removed.
- [x] #5 Rust and isolated Node bridge/gateway tests cover list ordering/cap, sweeps, search aliases/order/cap/unreadable files, missing roots/wiki, guarded reads, and bridge readiness/concurrency; full project validation passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Generalize stdio dispatch for files/search/sweeps/authorized page reads while retaining graph behavior. 2. Keep root persistence and shared path authorization in Node; delegate read algorithms to Rust. 3. Remove orphaned Node algorithms and add fixture parity tests. 4. Update Backlog file links immediately after each file change; run release build, Rust and targeted Node tests, lint/format, then full suite. 5. Record evidence and leave task In Progress for independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added Rust wiki-read module for bounded listing, sweep parsing, cached search, and guarded file-read execution. Groma reports no owner for server/wiki.mjs and no enabled scanner reads it; no architecture ref is available.

Registered the new wiki_read Rust module beside the existing graph implementation; graph code remains unchanged.

Generalized the private JSON-lines request shape with an operation field (defaulting to graph for current clients) and routed new wiki-read operations into the Rust module.

Extended the persistent FIFO bridge with files, sweeps, search, and page-read operations; existing graph requests continue to default to the graph operation.

Removed the Node wiki enumeration, sweep parsing, search/cache, and file read implementations while preparing the module to retain only root preference and existing authorization helpers.

Restored server/wiki.mjs with only root preference persistence, tilde path resolution used by the gateway, and the existing shared path guard.

Routed wiki files/sweeps/search/page reads through Rust while retaining Node root preference, root normalization, route paths, shared persisted-root/path containment check, response codes, and auth gateway.

Removed the Node-only wiki parser/list/search test suite as those algorithms have moved to Rust tests; retained Node authorization and preference coverage in the replacement file.

Replacement server/wiki.test.mjs keeps focused regression coverage for persisted-root authorization, traversal rejection, extension checks, and preference persistence.

Added real Rust child bridge coverage for sorted/capped file payload shape, recursive search order and case folding, sweep freshness parsing, page text, missing page/root behavior, and multi-operation concurrent responses.

Initial cargo test exposed an ambiguous HashMap inference in the new sweep parser; annotated the aggregation map. Final Rust checks remain pending.

Ported the existing sweep edge semantics into Rust tests: case-insensitive types, claim-bullet exclusions, interruption fallback, completion override boundaries, continuation completion, heading boundaries, invalid calendar dates, and unsupported hyphenated types.

The first Rust suite showed regex's lack of look-around support; replaced the sweep-heading lookahead with a consumed delimiter while retaining the recognized type and continuation capture.

Hardened sweep summary truncation at UTF-8 boundaries, restored case-insensitive context-label replacement, and made bridge search fixture independent of filesystem enumeration order.

Matched legacy JavaScript UTF-16 clipping lengths and post-filter sweep clipping order; ported long-claim marker and partial-context regression coverage. Date validation remains calendar-equivalent to the prior ISO round-trip.

A Rust test assertion initially compared the Option<String> sweep result to &str; corrected expected values to Some(String) before final verification.

Added a compatibility sort/clip adapter in the Node bridge using localeCompare and UTF-16 slice after Rust returns a UTF-8 prefix covering the cutoff; added accent ordering and lone-surrogate boundary tests. Ported both carry-forward contexts with later interruption and long-claim completion/interruption cases.

Completed Rust parity cases for sweep negative/positive completion clauses, continuation completion after a long claim, fallback after interruption, fixed domains, absent root, and malformed/invalid IAP ingest dates.

Added private locale-sorted wiki-name hints from Node directory metadata so Rust applies legacy localeCompare order before list/search caps; Rust still performs traversal, filtering, matching, and payload generation.

Final verification: `node scripts/build-rust-backend.mjs` release build succeeded; `cargo test --manifest-path rust/backend/Cargo.toml` passed 11/11; `node --test server/wiki.test.mjs server/rust-backend.test.mjs` passed 8/8; `pnpm lint` passed; `pnpm test` passed 612/612 Node tests; rustfmt --check passed for changed Rust module/main. Together the Node suite plus Rust suite accounts for 623 test cases. An isolated HTTP gateway fixture command was blocked by guard-agent before execution; exact rejection and path are in implement-wiki-reads.notes.md. Keep TASK-14 In Progress pending review.

Review repair: adjusted sweep context normalization and interruption detection to preserve legacy JavaScript ASCII word boundaries; added search page processing helper for deterministic read-failure coverage. Source: rust/backend/src/wiki_read.rs

Review repair tests added: impartial must retain its newer date; embedded xNew partial context remains interrupted and falls back to the older completed date; search page processing skips a missing read and preserves readable results. Source: rust/backend/src/wiki_read.rs

Review repair verification: Rust 12/12; release backend build succeeded; targeted Node 8/8; rustfmt check passed. See C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/implement-wiki-parity.notes.md. Independent route smoke receipt: wrong-token 401, reads 200, outside-root 400.

Finalization evidence: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/review-wiki-reads.notes.md verdict Pass after the three parity blockers were repaired. Exact final focused rechecks: cargo test 12/12, release build succeeded, targeted Node 8/8, rustfmt passed; prior real API smoke returned wrong-token 401, authorized reads 200, outside-root 400. All four repair VERIFY anchors unique. Full suite/lint remain implementation-record evidence rather than reviewer reruns.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated wiki file enumeration, sweeps, search, and guarded reads to the persistent Rust backend while preserving Node root authorization. Final independent review accepted with no blockers; reviewer verified Rust 12/12, release build, targeted Node 8/8, rustfmt, all four repair anchors, and prior isolated route/auth smoke. The implementer also recorded full suite 612/612 and lint passing.
<!-- SECTION:FINAL_SUMMARY:END -->
