---
id: TASK-42.1
title: Move system metrics sampling to Rust
status: To Do
assignee: []
created_date: '2026-10-20 23:52'
labels: []
dependencies:
  - TASK-41
parent_task_id: TASK-42
priority: medium
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The current system metrics service is a compact Node-owned service with a two-second sampler, CPU delta baseline, and bounded one-hour history, exposed through the existing status API. Migrating this service advances domain ownership after the in-progress config-state migration and creates a verified Rust-owned sampler before transport cutover. Keep the existing route and response shape during this slice.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Rust owns system metric collection, two-second sampling cadence, CPU delta baseline, and bounded one-hour history while the Node gateway remains temporarily available.
- [ ] #2 The existing metrics response shape and polling behavior remain compatible, including first-sample and history edge cases.
- [ ] #3 A focused Rust source/API decision is verified before adding any dependency; no crate version is assumed by this task.
- [ ] #4 Windows runtime tests cover metric values, sampling cadence, history bounds, startup, and stop behavior.
- [ ] #5 Linux and macOS compile/runtime evidence is recorded as follow-up work and is not a Windows acceptance blocker.
<!-- AC:END -->
