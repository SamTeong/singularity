---
id: TASK-42
title: Complete Rust daemon runtime cutover
status: To Do
assignee: []
created_date: '2026-10-20 23:52'
updated_date: '2026-10-22 00:12'
labels: []
dependencies: []
modified_files:
  - .claude/rules/server.md
priority: high
type: feature
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The current incremental migrations move selected operations into a private Rust child while Node still owns the production HTTP/WS listener, application services, agent lifecycle, startup and shutdown. The accepted target is a production Rust daemon with Node used only to build web assets. Track the end-to-end cutover while delivering verified service slices and preserving the existing browser contracts and state roots.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Production startup and normal operation require no Node.js process or Node runtime helper; Node remains only in web asset build tooling.
- [ ] #2 The Rust daemon owns all production HTTP/API and WebSocket behavior, application domain services, agent/process lifecycle, startup, and shutdown.
- [ ] #3 Windows runtime validation passes for the daemon, HTTP/WS contracts, security invariants, state ownership, agent lifecycle, and distribution/startup/shutdown.
- [ ] #4 Linux and macOS runtime validation remain explicit follow-up work and do not block Windows cutover acceptance.
- [ ] #5 HTTP and WebSocket contracts, loopback-only binding, token/origin protections, configured state roots, and external-terminal failure preservation are covered by parity evidence.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cutover residual from TASK-42.6: replace the configured external Node usage-report renderer with Rust before the final daemon cutover; interim refresh still invokes node <SING_USAGE_SKILL> report.

TASK-42.6 finalization: all nine reviewed source hashes and their unique VERIFY anchors match; the approved server rule correction hash is 97BCF369F4FD229B36596AA594D82A50C7078777489CB18E596C31C24EDF8A7F. Serial full Rust suite passed (160 library + 3 main); Node full suite passed (699, 2 skipped); lint, release build, and fmt check passed. A parallel full Rust run recorded 159 passed and one status header-timeout failure, and a rerun hung; serial pass does not prove the cause. TASK-42.9 tracks the bounded deterministic fixture follow-up. External Node usage-report renderer remains a cutover residual.
<!-- SECTION:NOTES:END -->
