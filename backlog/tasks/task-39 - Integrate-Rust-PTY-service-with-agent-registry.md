---
id: TASK-39
title: Integrate Rust PTY service with agent registry
status: In Progress
assignee: []
created_date: '2026-10-20 15:14'
updated_date: '2026-10-20 15:26'
labels: []
dependencies: []
modified_files:
  - server/agents.mjs
  - server/agents.test.mjs
  - server/index.mjs
  - server/app-dir.mjs
  - server/migrate-state.mjs
  - scripts/bootstrap.mjs
  - .claude/rules/server.md
  - package.json
  - pnpm-lock.yaml
  - scripts/fix-pty-helper.mjs
  - server/rust-pty-backend.mjs
  - server/rust-pty-backend.test.mjs
  - server/pty-ws.test.mjs
  - server/fixtures/rust-pty-child.mjs
type: feature
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The dedicated Rust PTY service and Node bridge are ready, but agent sessions still use node-pty. Route create and reattach through the service while keeping session policy, persistence, events, and WebSocket behavior in the registry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Agent create and reattach await Rust PTY spawn acceptance and preserve existing validation, persisted state, event counters, and WS payloads.
- [ ] #2 Early output and exit callbacks are delivered only after registry wiring; stale generation callbacks cannot mutate a replacement session.
- [ ] #3 Registry fire-and-forget input, resize, kill, remove, respawn, and shutdown preserve their current ordering and do not leak promise rejections.
- [ ] #4 Both Rust services are ready before task/cron recovery and listen; PTY shutdown follows registry drain and the existing five-second grace.
- [ ] #5 Remove node-pty and its obsolete postinstall helper after source callers are removed; document the approved portable-pty Windows DLL behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inject and wire the Rust PTY adapter in the agent registry while preserving lifecycle/state behavior. 2. Await both backend services before recovery/listen and stop PTY after registry drain. 3. Add focused registry/lifecycle/WS compatibility checks and remove node-pty dependency/helper. 4. Run focused checks, lint, and full Node tests once stable.
<!-- SECTION:PLAN:END -->
