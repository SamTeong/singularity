---
id: TASK-42
title: Complete Rust daemon runtime cutover
status: To Do
assignee: []
created_date: '2026-10-20 23:52'
labels: []
dependencies: []
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
