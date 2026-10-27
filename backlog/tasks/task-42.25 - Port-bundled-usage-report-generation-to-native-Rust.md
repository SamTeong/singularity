---
id: TASK-42.25
title: Port bundled usage report generation to native Rust
status: In Progress
assignee:
  - '@sate'
created_date: '2026-10-25 10:29'
updated_date: '2026-10-27 14:13'
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
  - rust/backend/src/usage_report_csv.rs
  - rust/backend/tests/usage_report_csv_oracle.mjs
  - rust/backend/tests/usage_report_csv_oracle.rs
  - rust/backend/src/usage_report_forecast.rs
  - rust/backend/tests/usage_report_forecast_cross_language.rs
  - rust/backend/tests/usage_report_forecast_oracle.mjs
  - rust/backend/src/usage_report_cost.rs
  - rust/backend/src/usage_report_sessions.rs
  - rust/backend/src/usage_report_forecast_build.rs
  - rust/backend/src/usage_report_codex_ingest.rs
  - rust/backend/src/usage_report_codex_rows.rs
  - rust/backend/src/usage_report_rebuild.rs
  - rust/backend/src/usage_report_pipeline.rs
  - .claude/rules-reference/setup-and-layout.md
  - .env.example
  - README.md
  - e2e/README.md
  - e2e/serve.mjs
  - e2e/usage.spec.mjs
  - rust/backend/src/main.rs
  - rust/backend/src/usage_report.rs
  - scripts/bootstrap.mjs
  - server/index.mjs
  - server/rust-backend.mjs
  - server/usagereport-bridge.test.mjs
  - server/usagereport.mjs
  - server/usagereport.test.mjs
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

Pure roadmap slice (p1.w1.s5): add rust/backend/src/usage_report_roadmap.rs with Inventory, StatsRow, StatsProjection, Suggestion and pure build_roadmap mirroring bundled improve.mjs row order/text/status/archive branch and JS coverage/rounding/interpolation; register it in rust/backend/src/lib.rs; add source-bound Node VM oracle rust/backend/tests/usage_report_roadmap_oracle.mjs. No acquisition, renderer wiring, custom-generator policy, production generation, or whole-pipeline cutover in this slice.

Pure freshness slice (p1.w2.s2): add rust/backend/src/usage_report_freshness.rs with pure decide_freshness(FreshnessInput) -> FreshnessDecision mirroring bundled stats.mjs::_ensure_fresh (900s cost-state window, 180s transcript fallback and Codex window, zero-CSV rebuild sentinel, first-strict-max ties, state-presence fallback suppression, active-SID exclusion, strict CSV-newer comparison, JS IEEE comparisons); register the module in rust/backend/src/lib.rs; add source-bound Node VM oracle rust/backend/tests/usage_report_freshness_oracle.mjs that extracts the checked-in _ensure_fresh, observes active/need even when need is false, and asserts rebuild receives the exact glob transcript snapshot. No filesystem, clock, enumeration, rebuild, adapter, generation, or pipeline cutover in this slice.

Native generation continuation: wire completed cost/session/forecast/Codex/rebuild modules into an explicit-roots pipeline, then replace Node generation. User decisions: ignore SING_USAGE_SKILL; reports always available; output env override or state-parent/reports; skip OAuth refresh; retain documented fixed-offset behavior. Preserve protected listeners and foreign source; validate synthetic parity and full Windows gates before finalization.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Accepted intermediate renderer slice only. Verified machine receipt C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/native-renderer-acceptance/run-20261025T122138349Z/checks-receipt.json: all seven gates exited 0 with cleanup complete; frozen input count 441, before/after maps stable, HEAD a164e6acddea93b49433a16280ea3e33f3c2affe, five renderer source hashes match both maps. Focused renderer tests 2/2; full Rust tests 278 passed/0 failed; pnpm test 744 passed/0 failed (746 total); lint, release build, fmt check, oracle passed. Production usage_report.rs Node generation dispatch remains unchanged. This slice does not complete TASK-42.25: criteria #1-#7 remain unchecked pending CSV/preparation/freshness, forecast/persistence, OAuth/provider history, roadmap, and final generation/API integration with full parity and validation.

Accepted the pure CSV codec slice only. Latest isolated acceptance receipt native-csv-acceptance/run-20261025T130105630Z/checks-receipt.json is status ok, terminal cleanup complete, bound to HEAD 5b38fd678c18e478f13eda508be80e46b6d8a076, with 444 stable frozen inputs and six successful gates: release build, CSV focused tests (4/4), CSV oracle (1/1), cargo format, release Rust suite (283 passed/0 failed; doc tests 0), and pnpm lint. Actual SHA256 for lib.rs, usage_report_csv.rs, usage_report_csv_oracle.rs, usage_report_csv_oracle.mjs, and usage_report.rs matched receipt before/after maps; built binary hash was stable across checks. All seven implementation/repair VERIFY anchors occur once. CSV implementation and two source-bound oracles are accepted as this slice. Caveat: production usage_report.rs remains unchanged and dispatches Node; this does not satisfy full TASK-42.25. All seven whole-pipeline acceptance criteria remain unchecked and task stays In Progress.

Accepted pure forecast math slice after source-bound integrated acceptance. All six combined gates passed: release build; 11 focused report tests; cargo format; full Rust release suite 289 passed/0 failed; pnpm lint; pnpm test 744 passed/0 failed/2 skipped (746 total). Receipt SHA-256 F6D5080B20410003EF1D249C46F1F4A2B6C96CF746B95BF0807B5. Receipt binds HEAD 97eef6549705ff625b4a182ad783153790c8c70b, 447 frozen inputs, cleanup complete, and stable isolated binary hash CF242C00444B2ED76E4720977F30B454FA891AD8C914512DA5BF681493EAD4F6. Forecast source and both tests were byte-matched to receipt before/after maps. This slice implements pure prepared-history forecast math and source-bound synthetic Rust/JS comparison. The bundled JS seSq/seOlsSq posterior fallback defect remains preserved for compatibility. Production usage_report.rs still invokes Node; the native whole pipeline is incomplete, so all seven whole-pipeline acceptance criteria remain unchecked and task stays In Progress. Deferred: history preparation/freshness, provider wrappers, integrations, persistence, renderer/runtime generation integration, and full native backend acceptance.

Receipt hash transcription correction: the exact SHA-256 is F6D5080B20410003EF1D249C46F1F4A2B6C96CF746B95BF080D07FF0197E92B5.

Native pure roadmap derivation and freshness decision helpers now implemented, each with source-bound Node VM differential oracles. Accepted combined run C:/Users/sate/.agents/.plan/01a17baa-6bce-73d0-a4bb-e4439fbffb34/native-combined-acceptance/run-20261027T060147007Z: fmt/lint/release build/full Rust339pass/focused Node157pass2skip/full pnpm test756pass2skip, all exits0; source fingerprints/binaryhash/listenerowners unchanged and cleanup complete. Production report generation is still Node-dispatched; preparation/rebuild/provider history/forecast persistence/OAuth/roadmap acquisition/generation integration remain. User chose native generation with clear errors for custom JavaScript SING_USAGE_SKILL paths, no Node runtime fallback. Keep whole-task In Progress and ACs unchecked.

Native pipeline candidate now replaces the Node generator. User-approved behavior: always available, ignore SING_USAGE_SKILL, skip OAuth, fixed local offset; output precedence explicit request then SING_USAGE_REPORTS then state-parent/reports. Full Rust acceptance 412 library plus 7 other tests PASS in clean e9a2982-based candidate with synthetic roots. JavaScript and independent final reviews pending; no activation/push. Modified-file list preserves prior entries. Groma Rust path unindexed; no invented architecture references.
<!-- SECTION:NOTES:END -->
