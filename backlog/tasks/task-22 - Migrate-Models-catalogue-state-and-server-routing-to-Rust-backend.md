---
id: TASK-22
title: Migrate Models catalogue state and server routing to Rust backend
status: Done
assignee: []
created_date: '2026-10-20 06:27'
updated_date: '2026-10-20 07:17'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/models.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/model-store.mjs
  - server/models.mjs
  - server/index.mjs
  - server/agents.mjs
  - server/tasks.mjs
  - server/background.mjs
  - server/crons.mjs
  - server/pty-ws.mjs
  - server/sessions.mjs
  - server/history.mjs
  - server/projects.mjs
  - server/window-anchor.mjs
  - server/model-store.test.mjs
  - server/models.test.mjs
  - server/rust-backend.test.mjs
  - server/agents.test.mjs
  - server/tasks.test.mjs
  - server/tasks-integration.test.mjs
  - server/history.test.mjs
  - server/projects.test.mjs
  - server/background.test.mjs
  - server/crons.test.mjs
  - server/sessions.test.mjs
  - server/window-anchor.test.mjs
type: feature
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Models catalogue currently has Node-owned JSON persistence, validation, restore-defaults merging, server classification, tool/model validation, Claude alias conversion, and History summarizer selection. These behaviors share one state document and must migrate as one bundle so future Node consumers never depend on a synchronous shadow reader. Preserve the Node HTTP gateway, STATE_DIR authority, public route contracts, and separate pricing APIs/readers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rust is the sole server authority for the 21-row seed, exact defaults, catalogue validation/normalization, missing-file seed creation, corrupt-file seed fallback without clobber, GET, PUT, restore-defaults merge, classification, tool/model validation, Claude alias conversion, and summarizer selection.
- [x] #2 Public GET /api/models remains a bare document including disabled rows; PUT keeps {ok:true,state} or HTTP 400 {ok:false,error}; restore-defaults keeps {ok:true,state}; transport failures map distinctly to 500. Node derives and passes an absolute models.json path; no HTTP caller supplies paths and Rust does not derive the app root.
- [x] #3 Validation parity preserves exact error messages, trimmed unique IDs, max 200 models, exact groups and Codex gpt- prefix, 80 UTF-16-unit labels, enabled false only for exact false, trimmed default/summarizer fields, and enabled membership requirements.
- [x] #4 Routing parity preserves stored groups including disabled entries, unknown-ID/provider heuristics and shipped Claude aliases, claudeIdToAlias family/1m behavior, optional tool/model inputs, and all-group summarizer selection with deterministic fallback when unset or binary unavailable.
- [x] #5 The full Node migration awaits every affected server consumer asynchronously without a synchronous Node shadow reader; it includes spawn/task/cron/session/history/project/window-anchor behavior, leaves pricing paths unchanged, and is covered by real child, persistence, routing, and HTTP parity tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement and verify Rust Models authority. 2. Integrate shared Rust bridge and asynchronous Node consumers with real bridge-backed parity tests. 3. Run focused validation and full suites. 4. Resolve independent bundle review findings and focused regressions. 5. Finalize acceptance criteria and local commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rust Models authority is implemented in models.rs and exposed through the private bridge. Node delegates catalogue and routing decisions to that bridge, then awaits decisions across agents, tasks, background work, crons, PTY, sessions, history, projects, and window-anchor consumers. The Node HTTP gateway retains response contracts and STATE_DIR path ownership; pricing remains separate. Bundle verification: Rust suite 45/45, rustfmt check, release build, and five-operation bridge smoke passed. Node suite 627/627, lint, and diff check passed before the final exit-cleanup ordering adjustment; after that adjustment, focused agents tests passed 50/50, lint and diff check passed, and independent whole-bundle review passed after repair. The full suite was not repeated after the final ordering adjustment. Groma has no owner for representative changed Rust/Node paths because no enabled scanner reads them; no architecture references were inferred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Models catalogue state, validation, routing, and summarizer selection to Rust behind the Node gateway, propagated asynchronous route decisions through server consumers, and preserved pricing paths. Verified with Rust 45/45, formatting, release build, bridge smoke, Node full 627/627 before the final event-order adjustment, focused agents 50/50 after it, lint, diff check, and independent whole-bundle review.
<!-- SECTION:FINAL_SUMMARY:END -->
