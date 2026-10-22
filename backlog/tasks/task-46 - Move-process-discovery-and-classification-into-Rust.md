---
id: TASK-46
title: Move process discovery and classification into Rust
status: Done
assignee: []
created_date: '2026-10-22 14:25'
updated_date: '2026-10-22 15:53'
labels: []
dependencies:
  - TASK-45
modified_files:
  - rust/backend/src/procs_discovery.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/agents.mjs
  - server/rust-backend.mjs
  - server/procs.mjs
  - server/procs.test.mjs
  - server/rust-backend.test.mjs
priority: medium
type: feature
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-31 moved platform scan command execution and guarded PID termination through the Rust backend, but Node still parses scanner output and classifies every row. The task manager needs reliable tracked/stale/external/daemon rows, including live-agent correlation and checkout-scoped dev tooling, while the public /procs response and guarded kill behavior stay stable. Complete process scan ownership in Rust after TASK-45 releases the shared bridge dispatch files. While Node remains the composition root, preserve its host PID for daemon-row protection and sample the Node-owned agent registry after the asynchronous OS query, using a two-phase internal Rust scan/classify seam.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns Windows and Darwin process query parsing and normalization; Node samples live PIDs and session IDs only after the asynchronous scan and parse complete, then Rust filters and classifies from that snapshot.
- [x] #2 GET /procs retains the existing { procs: [...] } shape, exact row keys, kind meanings, scanner-error-to-empty behavior, singleton Windows JSON handling, and platform-specific started-time behavior.
- [x] #3 Tracked-session correlation still recognizes wrapper-launched Claude children by --session-id or --resume; checkout dev-tool rows remain repo-scoped, and the Node host process remains daemon-protected while Node is the composition root.
- [x] #4 POST /procs/kill preserves its current validation, initial scan, daemon denial, Windows same-name re-query, response errors, and uses the existing Rust kill operation without widening termination policy.
- [x] #5 Focused scan/classification fixtures and existing Node route/kill tests pass, with Rust formatting/tests and the Windows release build verified before switching the scan owner.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a Rust process-discovery module that runs the current Windows/Darwin queries, parses and normalizes raw snapshots, and classifies rows from explicit host PID, repo root, live PIDs, and live session IDs. 2. Add the Node registry snapshot API and bridge scan/classify calls, sampling only after scanRaw resolves; switch only GET /procs scan adapter while preserving the kill flow. 3. Add differential Rust parsing/filter/classification fixtures and focused bridge/Node adapter coverage. 4. Format and inspect the diff; test/build execution is delegated to the root runner.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finalization evidence: independent acceptance and review pass; continuation receipt confirms focused Node 38 passed/2 skipped, full Node 724 passed/2 skipped, lint and diff check passed. Reused matching original receipt for Rust fmt, 210 library + 3 binary tests, and release build after source/Cargo.lock hashes remained stable. Live Darwin execution remains an existing platform-validation follow-up.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved process discovery parsing, normalization, and classification into Rust while preserving the Node /procs contract and guarded kill policy. Independent review passed; focused and full Node suites, lint, diff check, Rust formatting/tests, and release build passed or were reused from hash-pinned receipts. Darwin live execution remains follow-up.
<!-- SECTION:FINAL_SUMMARY:END -->
