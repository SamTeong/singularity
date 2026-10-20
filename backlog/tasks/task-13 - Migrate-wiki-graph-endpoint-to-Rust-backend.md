---
id: TASK-13
title: Migrate wiki graph endpoint to Rust backend
status: Done
assignee: []
created_date: '2026-10-20 01:54'
updated_date: '2026-10-20 02:13'
labels: []
dependencies: []
modified_files:
  - rust/backend/Cargo.toml
  - rust/backend/Cargo.lock
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/index.mjs
  - server/wiki.mjs
  - scripts/build-rust-backend.mjs
  - package.json
  - CLAUDE.md
  - server/rust-backend.test.mjs
  - backlog/tasks/task-13 - Migrate-wiki-graph-endpoint-to-Rust-backend.md
type: feature
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The wiki graph endpoint currently computes Markdown page links in Node. This is the first increment of the approved Rust backend migration; the existing Node daemon remains the public gateway so the app and HTTP/WebSocket contracts stay available during migration.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/wiki/graph preserves its current response shape, errors, node and edge order, page labels/categories, matching rules, aliases, and edge deduplication.
- [x] #2 Rust graph discovery respects the 2000-file cap, skips hidden/heavy directories, and does not follow symlink directories outside the selected wiki subtree.
- [x] #3 The Node gateway uses a persistent Rust child over private newline-delimited JSON stdio, closes it with the daemon, and reports child failure without a Node fallback.
- [x] #4 Rust behavior and Node bridge/lifecycle are covered by isolated tests; pnpm server, dev, and start build or clearly require the Rust toolchain.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Port existing wikiGraph traversal and resolution semantics into a reusable Rust backend crate. 2. Add a persistent stdio child bridge and gateway lifecycle integration. 3. Add Rust graph and Node bridge contract tests. 4. Wire predictable builds into existing start commands and document prerequisites. 5. Verify against temporary fixtures and record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PLAN_ITEM p1.w2.s1. Parent-approved protocol: private newline JSON over stdio, overriding the design note's proposed private HTTP listener to avoid another listener or secret. Toolchain will be supplied separately by the toolchain lane.

Validated: cargo test passed 4/4; isolated Node bridge tests passed 2/2; pnpm test passed 623/623; pnpm lint and cargo fmt --check passed; actual isolated API smoke returned 401 without token and 200 with token and the Rust graph payload. Risk-tier tracked diff: low (55 lines; untracked files are excluded by the script and are separately listed above). Groma component references are unavailable because no owner/scanner reads these files. Review is pending.

Startup readiness repair in progress: Node now waits for an explicit Rust ready line and fails if process exit or startup timeout happens first.

Rust startup now writes and flushes a JSON ready handshake before reading requests.

Added startup regression proving a child that emits the OS spawn event then exits before ready causes start() to reject.

Readiness repair verified: release binary rebuilt; cargo test passed 4/4; focused bridge tests passed 3/3 including exit-before-ready and successful ready-plus-concurrent-requests; cargo fmt --check and ESLint on the bridge files passed. Task stays In Progress pending independent review.

Independent final re-review passed with no blockers; all 17 VERIFY anchors matched exactly once. Evidence in implement-wiki.notes.md and implement-readiness.notes.md: release build, Rust tests 4/4, bridge tests 3/3, rustfmt, lint, full pnpm test 623/623. Acceptance criteria were verified and already checked.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated GET /api/wiki/graph to a persistent Rust stdio backend behind the existing Node gateway. Validation: Rust and Node tests, full pnpm test/lint, build, formatting, and isolated authenticated API smoke.
<!-- SECTION:FINAL_SUMMARY:END -->
