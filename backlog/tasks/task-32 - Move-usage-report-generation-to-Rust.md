---
id: TASK-32
title: Move usage report generation to Rust
status: Done
assignee: []
created_date: '2026-10-20 09:38'
updated_date: '2026-10-20 10:17'
labels: []
dependencies:
  - TASK-31
type: enhancement
ordinal: 32000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 POST /usagereport/refresh executes the report command through the Rust backend.
- [x] #2 Env redirect, timeout, stdout last-line parsing, and route contract remain compatible.
- [x] #3 Focused tests cover success, timeout, and parse failure.
- [x] #4 Rust fmt, Rust tests, release build, focused Node tests, lint, and full Node tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add Rust Command op for the report exec (node SKILL_STATS script report); bridge server/usagereport.mjs generateReport; keep read side in Node; add tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation: extended oneshot Rust op with optional max_buffer + env params (defaults preserve 8MB parity for existing callers); generateReport now routes through oneShotSpawn (Rust backend wired via setOneShotBackend), keeping 16MB buffer, 180s timeout, USAGE_REPORT_BROWSER env, and last-stdout-line parsing; read side unchanged in Node. New server/usagereport.test.mjs (success/timeout/parse-failure/missing-skill/legacy fallback); cargo fmt+tests (72 pass), release exe rebuilt, focused + full Node tests (666 pass), lint clean.

Final verification: review PASS no blockers (./review-usagereport.notes.md — contract identical, env overlay equivalent to execFile, SING_TOKEN bridge transit same trust domain, accepted); 6 anchors verified (SING_BRIDGE_PROBE appears twice as one test's fixture+opts pair, legitimate); cargo test --release 72 pass; fmt/lint clean; full pnpm test 666 pass 2 pre-existing skips in both implement and review runs; release exe rebuilt.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Routed usage report generation (POST /usagereport/refresh) through the queued Rust backend by extending the oneshot op with optional max_buffer and env (8MB default preserved for existing callers); generateReport keeps 16MB/180s/USAGE_REPORT_BROWSER redirect and identical last-stdout-line parsing, read side stays in Node. Verified by focused usagereport/one-shot/bridge tests, cargo --release 72 pass, full Node 666 pass, lint, and independent review PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
