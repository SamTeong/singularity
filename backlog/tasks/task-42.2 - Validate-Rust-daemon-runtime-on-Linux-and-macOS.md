---
id: TASK-42.2
title: Validate Rust daemon runtime on Linux and macOS
status: To Do
assignee: []
created_date: '2026-10-20 23:52'
labels: []
dependencies:
  - TASK-42
parent_task_id: TASK-42
priority: low
type: task
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Windows runtime validation defines completion of the production Rust daemon cutover. Linux and macOS have separate runtime evidence gaps and should be validated after the cutover without delaying Windows acceptance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run the distributed Rust daemon on supported Linux and macOS hosts and record startup, HTTP/WS, security, state-root, agent lifecycle, and shutdown results.
- [ ] #2 Record platform-specific failures and follow-up work separately from Windows cutover acceptance.
<!-- AC:END -->
