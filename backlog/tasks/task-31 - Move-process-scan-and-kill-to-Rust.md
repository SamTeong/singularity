---
id: TASK-31
title: Move process scan and kill to Rust
status: Done
assignee: []
created_date: '2026-10-20 09:38'
updated_date: '2026-10-20 10:08'
labels: []
dependencies:
  - TASK-30
type: enhancement
ordinal: 31000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /procs and POST /procs/kill execute scan and guarded PID kill through the Rust backend.
- [x] #2 Existing classification, TOCTOU re-verification, daemon-kind denial, and route contracts remain compatible; live pty pids cross the bridge.
- [x] #3 Focused tests cover scan parsing, kill guard, and route contracts.
- [x] #4 Rust fmt, Rust tests, release build, focused Node tests, lint, and full Node tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Port PowerShell/ps scan and guarded kill to Rust Command ops; pass livePids() from Node over the bridge; keep classification and route mapping in Node; add tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final verification: review PASS-with-notes, no blockers (./review-procs.notes.md — kill guards verified, taskkill error strings match uv_kill, scan via oneshot op parity holds); 9 VERIFY anchors exact-count-1; cargo test --release pass (implementer + reviewer re-run); full node suite retried clean 661 pass 2 pre-existing skips (tasks.test EPERM flake did not recur, untouched by diff). Known accepted gaps: darwin arm runtime-untested (pre-existing, matches old semantics by inspection); procs.test.mjs missing trailing newline (cosmetic).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Routed process scan (powershell/ps) and guarded PID kill through the Rust backend: scan and TOCTOU re-query reuse the queued oneshot op (no-timeout, 8MB cap, CREATE_NO_WINDOW parity); kill executes via new procs_kill op (unix libc::kill, windows absolute-path taskkill /F, argv-only, pid guards stricter than legacy: bad pid, pid<=0, ESRCH mapping identical to uv_kill error strings). All kill guards test-pinned including daemon-kind denial and a real bridge termination test. Verified by focused procs/bridge tests, cargo --release, full Node suite retry, lint, and independent review PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
