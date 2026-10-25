---
id: TASK-42.25
title: Port bundled usage report generation to native Rust
status: In Progress
assignee:
  - '@sate'
created_date: '2026-10-25 10:29'
updated_date: '2026-10-25 12:29'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/native-report-generation-design.md
modified_files:
  - rust/backend/src/lib.rs
  - rust/backend/src/usage_report_render.rs
  - rust/backend/src/usage_report_templates.rs
  - rust/backend/examples/usage_report_render_fixture.rs
  - rust/backend/tests/usage_report_render_oracle.mjs
parent_task_id: TASK-42
type: feature
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The final TASK-42 cutover residual still starts the configured Node usage-report skill. The accepted target is the repository-bundled harness-usage-report pipeline with Node used only for web asset builds. Preserve its full preparation, optional integrations, forecast, complete self-contained report, filesystem side effects, and existing HTTP/report service contracts. Design and unresolved research gates: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/native-report-generation-design.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Production report generation runs through native Rust and no longer starts Node; non-bundled configured skill paths have explicit documented behavior and never silently fall back to Node.
- [ ] #2 Freshness, active-session exclusion, Claude transcript and cost-state reconciliation, CSV/session/facet generation, Codex report ingestion, and cache behavior match the bundled pipeline on synthetic fixtures.
- [ ] #3 Optional OAuth snapshot refresh, provider history inputs, forecast calculation and persistence, and roadmap fallback preserve bundled behavior without real credentials, network access, or a Node child.
- [ ] #4 The complete self-contained HTML preserves all seven bundled assets, embedded session/facet/forecast data, sections, theme/skin behavior, filters, and browser interactions.
- [ ] #5 Report output naming, directory and file mode, encoding, collision/error behavior, browser suppression for daemon refresh, and status/read/refresh API contracts remain compatible.
- [ ] #6 Isolated differential fixtures cover representative success, boundary, malformed/missing, optional integration, Unicode, escaping, and failure cases without reading user data.
- [ ] #7 Focused and full Windows validation passes; Linux/macOS daemon validation remains tracked separately by TASK-42.2.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Finish source characterization for configuration/path behavior, freshness/rebuild/cache, CSV and Codex mapping, forecast math/persistence, OAuth snapshot contract, roadmap dependencies, HTML assets/interactions, and synthetic fixture seams. Do not read private state or credentials or run the report generator. 2. First code slice: own rust/backend/src/usage_report_render.rs and its Rust tests; add an explicit payload contract and callable pure renderer over all bundled HTML/assets. Keep current Node generation wired while this slice is developed. 3. Implement separately testable native preparation/freshness, forecast, optional OAuth, provider-history and roadmap responsibilities using injected time/randomness/transport and synthetic roots; reuse existing Rust APIs only where parity is demonstrated. 4. Integrate all stages behind the existing Rust generation operation, preserve output/service/HTTP behavior and caller browser suppression, then remove the Node child only when the entire pipeline is connected. 5. Run isolated differential fixtures, focused/full serial Rust and Node suites, release build, cargo fmt --check, and lint on Windows; leave Linux/macOS runtime validation to TASK-42.2.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Accepted intermediate renderer slice only. Verified machine receipt C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/native-renderer-acceptance/run-20261025T122138349Z/checks-receipt.json: all seven gates exited 0 with cleanup complete; frozen input count 441, before/after maps stable, HEAD a164e6acddea93b49433a16280ea3e33f3c2affe, five renderer source hashes match both maps. Focused renderer tests 2/2; full Rust tests 278 passed/0 failed; pnpm test 744 passed/0 failed (746 total); lint, release build, fmt check, oracle passed. Production usage_report.rs Node generation dispatch remains unchanged. This slice does not complete TASK-42.25: criteria #1-#7 remain unchecked pending CSV/preparation/freshness, forecast/persistence, OAuth/provider history, roadmap, and final generation/API integration with full parity and validation.
<!-- SECTION:NOTES:END -->
