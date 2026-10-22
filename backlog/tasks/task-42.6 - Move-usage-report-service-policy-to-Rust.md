---
id: TASK-42.6
title: Move usage report service policy to Rust
status: Done
assignee: []
created_date: '2026-10-21 23:43'
updated_date: '2026-10-22 00:12'
labels: []
dependencies:
  - TASK-42.5
modified_files:
  - rust/backend/src/usage_report.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - rust/backend/src/models.rs
  - server/rust-backend.mjs
  - server/usagereport.mjs
  - server/index.mjs
  - server/usagereport.test.mjs
  - server/usagereport-bridge.test.mjs
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-32 moved only the report command launch through the generic Rust one-shot operation; report selection, status/read behavior, and stdout result interpretation remain in Node. Move that complete service policy behind Rust while preserving the existing HTTP contract. The configured report renderer still runs the external Node skill as an interim parity step; Rust must replace that renderer before the Rust daemon cutover. Design: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/usage-report-service-design.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust owns latest report selection, status/mtime calculation, HTML reading, report command invocation, and output/error interpretation using explicit configured paths.
- [x] #2 The existing /usagereport/status, /usagereport/report, and /usagereport/refresh HTTP status codes, headers, bodies, nulls, timestamp units, and failure strings remain compatible.
- [x] #3 Configured Node skill invocation preserves Node CLI behavior, USAGE_REPORT_BROWSER=node, 180000 ms timeout, 16 MiB max buffer, environment overlay semantics, and the existing one-shot error outcomes as an explicitly interim residual.
- [x] #4 Rust and Node parity tests cover selection/read/generation success and failure, Unicode Windows paths/content, the report test injection seam, and route responses; the existing mock status/refresh behavior remains compatible.
- [x] #5 Focused Rust tests, isolated release build, cargo fmt, focused Node tests, and lint pass on Windows using the isolated target and all three Rust binary overrides recorded in the design note.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add typed usage-report bridge requests/responses and a Rust service for report selection, status, HTML reads, and generation result interpretation. 2. Preserve configured SING_USAGE_REPORTS and SING_USAGE_SKILL paths and reuse the existing Rust one-shot runner with its 180000 ms timeout, 16 MiB buffer, environment overlay, and USAGE_REPORT_BROWSER=node. 3. Reduce server/usagereport.mjs to a thin typed bridge adapter and preserve all three current HTTP contracts; leave the existing mock status/refresh semantics intact. 4. Add Rust and Node parity tests for filename selection, missing/unreadable files, report decoding and mtime, skill errors, process output/errors, Unicode Windows paths, injection, and route responses. 5. Run focused Rust tests, isolated release build, cargo fmt, focused Node tests, and lint with the exact target directory and three binary overrides from the prior identity-service receipt.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finalization on 2026-10-22: all nine current source SHA256 values match the repair record; each of its nine VERIFY anchors occurs exactly once. The approved .claude/rules/server.md SHA256 is 97BCF369F4FD229B36596AA594D82A50C7078777489CB18E596C31C24EDF8A7F. Native receipts: serial full Rust run exit 0 (160 library + 3 main tests); full Node suite exit 0 (699 passed, 2 skipped); lint, isolated release build, cargo fmt check, focused Rust and focused Node checks all exit 0. The prior parallel Rust full run had 159 passed and 1 status header-timeout failure; its retry hung. Serial success does not establish the parallel failure cause. TASK-42.9 tracks a deterministic, bounded fixture follow-up. External Node usage-report renderer remains the documented cutover residual.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved usage-report selection, status/read policy, generation interpretation, and typed bridge handling into Rust while preserving the existing HTTP contract. All five acceptance criteria are checked. Focused and full Node tests, focused Rust tests, the isolated release build, lint, fmt check, and the serial full Rust suite passed with recorded exit-0 receipts. The parallel Rust suite still has an unresolved header-timeout fixture failure/hang; TASK-42.9 tracks a deterministic bounded-fixture follow-up. The external Node renderer remains an explicit final-cutover residual.
<!-- SECTION:FINAL_SUMMARY:END -->
